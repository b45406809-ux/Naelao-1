import { DurableObject } from "cloudflare:workers";
import { applyMigrations, execute, queryAll, queryOne } from "@naelao/db";
import type { Migration } from "@naelao/db";
import {
  buildFireParams,
  evaluateCondition,
  findPossibleDuplicateProjects,
  getBusinessFeatureKind,
  isFailureKind,
  isKnownProjectKind,
  roleMeetsMinimum,
  selectMatchingRules,
  computeNextRun,
  validateCronExpression,
} from "@naelao/events";
import type {
  ConditionContext,
  EventEnvelope,
  TriggerCondition,
  TriggerRule,
} from "@naelao/events";
import { broadcastSpaceEvent, mintInternalToken } from "@naelao/http";
import type { MessageRole } from "@naelao/types";
import { defaultViewportFor, getProjectKindManifest, validateExtensionManifest } from "@naelao/agent-sdk";
import type { DisplayMode, ExtensionManifest, TemplateMode } from "@naelao/agent-sdk";
import { consumeEphemeralActionGrant, mintEphemeralActionGrant, type EphemeralActionGrant, verifyCapabilityToken } from "@naelao/security";

function todaySpendKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/** Same shape as BuilderAccountDO's local copy — a raw API key is hashed before it's ever
 *  persisted, never the other way around. Small enough that a shared package isn't worth it
 *  (matches this codebase's existing precedent of small crypto helpers duplicated per-DO). */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface WebhookEventIdentity { spaceId: string; provider: string; eventType: string; eventId: string; }
export async function claimProcessedWebhookEvent(
  sql: { exec(query: string, ...bindings: unknown[]): { rowsWritten: number } },
  event: WebhookEventIdentity
): Promise<{ claimed: boolean; eventHash: string }> {
  const eventHash = await sha256Hex(JSON.stringify([event.spaceId, event.provider, event.eventType, event.eventId]));
  sql.exec(`DELETE FROM processed_webhook_events WHERE processed_at < datetime('now', '-24 hours')`);
  const result = sql.exec(
    `INSERT OR IGNORE INTO processed_webhook_events (event_hash, provider, event_id, processed_at)
     VALUES (?, ?, ?, datetime('now'))`, eventHash, event.provider, event.eventId
  );
  return { claimed: result.rowsWritten > 0, eventHash };
}

function safeJsonParseObj(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }

}

/** projects.allowed_agent_ids is stored as a JSON string[] or NULL (unrestricted). */
function safeJsonParseAgentIds(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : null;
  } catch {
    return null;
  }
}

function safeJsonParseArr(text: string): unknown[] {
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function safeJsonParseCondition(text: string): TriggerCondition {
  try {
    const v = JSON.parse(text) as unknown;
    if (
      v &&
      typeof v === "object" &&
      typeof (v as { type?: unknown }).type === "string"
    ) {
      return v as TriggerCondition;
    }
  } catch {
    /* fall through to the always-match default */
  }
  return { type: "always" };
}

interface EventTriggerRow {
  id: string;
  space_id: string;
  project_id: string | null;
  event_type: string;
  condition: string;
  script_name: string;
  params: string;
  enabled: number;
  priority: number;
  created_at: string;
}

function rowToTriggerRule(row: EventTriggerRow): TriggerRule {
  return {
    id: row.id,
    space_id: row.space_id,
    ...(row.project_id ? { project_id: row.project_id } : {}),
    event_type: row.event_type,
    condition: safeJsonParseCondition(row.condition),
    action: {
      type: "run_script",
      script_name: row.script_name,
      params: safeJsonParseObj(row.params),
    },
    enabled: row.enabled === 1,
    priority: row.priority,
  };
}

// ── Schema migrations ────────────────────────────────────────────────────────
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial schema",
    // Do NOT run PRAGMA journal_mode/synchronous/cache_size here — Cloudflare's SQLite-backed DO
    // storage manages its own engine settings and rejects these with "not authorized:
    // SQLITE_AUTH", throwing on every call to this DO in production (confirmed via a live
    // wrangler tail session; the test suite's SQLite shim doesn't enforce this restriction, so
    // it was never caught by the unit tests). CLAUDE.md's own DO SQLite Pattern section used to
    // instruct setting WAL mode — it does not apply to Cloudflare's real runtime.
    up: `
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        space_id    TEXT NOT NULL,
        tenant_id   TEXT NOT NULL,
        end_user_id TEXT,
        status      TEXT NOT NULL DEFAULT 'active',
        metadata    TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES sessions(id),
        role         TEXT NOT NULL,
        content      TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name    TEXT,
        token_count  INTEGER,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS agent_state (
        session_id        TEXT PRIMARY KEY REFERENCES sessions(id),
        current_fsm_state TEXT NOT NULL DEFAULT 'IDLE',
        goal_stack        TEXT NOT NULL DEFAULT '[]',
        context_json      TEXT NOT NULL DEFAULT '{}',
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS kb_documents (
        id           TEXT PRIMARY KEY,
        space_id     TEXT NOT NULL,
        title        TEXT NOT NULL,
        source_url   TEXT,
        content_type TEXT NOT NULL DEFAULT 'text',
        status       TEXT NOT NULL DEFAULT 'pending',
        chunk_count  INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_space ON sessions(space_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_kb_space ON kb_documents(space_id);
    `,
  },
  {
    version: 2,
    description: "FTS5 for message search",
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content=messages,
        content_rowid=rowid
      );
    `,
  },
  {
    version: 3,
    // G-D01: composite index ensures ORDER BY (session_id, created_at, id) uses an index scan
    description: "composite message ordering index",
    up: `CREATE INDEX IF NOT EXISTS idx_messages_session_time ON messages(session_id, created_at, id);`,
  },
  {
    version: 4,
    // G-AO30/G-AO31: index for per-user GDPR export and erasure queries
    description: "end_user_id index on sessions for GDPR",
    up: `CREATE INDEX IF NOT EXISTS idx_sessions_end_user ON sessions(end_user_id);`,
  },
  {
    version: 5,
    // G-AO17: track injection attempts per user for runtime rate-limiting
    description: "injection_attempts table",
    up: `
      CREATE TABLE IF NOT EXISTS injection_attempts (
        id          TEXT PRIMARY KEY,
        space_id    TEXT NOT NULL,
        end_user_id TEXT NOT NULL,
        detected_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_injection_user ON injection_attempts(end_user_id, detected_at);
    `,
  },
  {
    version: 6,
    // G-AX13: per-user token bucket for message rate limiting within a Space
    description: "user_rate_limits token bucket table",
    up: `
      CREATE TABLE IF NOT EXISTS user_rate_limits (
        user_id        TEXT PRIMARY KEY,
        tokens         REAL NOT NULL DEFAULT 10,
        last_refill_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        capacity       REAL NOT NULL DEFAULT 10,
        rate_per_sec   REAL NOT NULL DEFAULT 0.1667
      );
    `,
  },
  {
    version: 7,
    // SpaceDO owns agent_definitions per spec §11 / CLAUDE.md direction.
    // Each definition is the config for one installed agent (system_prompt, model, skills, triggers).
    description: "agent_definitions table",
    up: `
      CREATE TABLE IF NOT EXISTS agent_definitions (
        id               TEXT PRIMARY KEY,
        space_id         TEXT NOT NULL,
        name             TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        config_json      TEXT NOT NULL DEFAULT '{}',
        version          INTEGER NOT NULL DEFAULT 1,
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_defs_space ON agent_definitions(space_id);
    `,
  },
  {
    version: 8,
    // threads and space_members: spec-canonical tables (SpaceDO owns threads + members).
    // threads replaces the earlier "sessions" concept in the full spec; both coexist here.
    description: "threads and space_members tables",
    up: `
      CREATE TABLE IF NOT EXISTS threads (
        id         TEXT PRIMARY KEY,
        space_id   TEXT NOT NULL,
        user_id    TEXT,
        project_id TEXT,
        title      TEXT,
        status     TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_threads_space ON threads(space_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id) WHERE project_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS space_members (
        space_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','editor','member','viewer')),
        joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (space_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_members_user ON space_members(user_id);
    `,
  },
  {
    version: 9,
    // billing credits table — SpaceDO owns per-space credit balance (spec §51 / CLAUDE.md)
    description: "space_credits billing table",
    up: `
      CREATE TABLE IF NOT EXISTS space_credits (
        space_id          TEXT PRIMARY KEY,
        balance_credits   INTEGER NOT NULL DEFAULT 0,
        daily_spent       INTEGER NOT NULL DEFAULT 0,
        daily_limit       INTEGER NOT NULL DEFAULT 0,
        last_reset_date   TEXT NOT NULL DEFAULT (date('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 10,
    // Space hierarchy registry (spec §10 SpaceDO schema + §49 Sub-Space Architecture,
    // G-Y15/G-Y16). This DO is one product's complete database; the `spaces` table is
    // the product's space registry: the root space (depth 0) plus its in-DO sub-spaces
    // (departments, depth 1) for tenancy_mode='team'. Sub-spaces share this SQLite and
    // are isolated by the space_id column already carried on threads/messages — no RLS,
    // because the DO instance boundary is the product boundary.
    //
    // For tenancy_mode='saas' the per-end-user business is its OWN SpaceDO (own SQLite),
    // so it has its OWN `spaces` registry rooted at that business; cross-business isolation
    // is structural. cross_space_grants records explicit cross-sub-space access within a
    // product (e.g. Litigation may read M&A's knowledge) — checkCrossSpacePermission()
    // defaults to DENIED on any error and never silently permits.
    description: "spaces registry + cross_space_grants (hierarchy + tenancy)",
    up: `
      CREATE TABLE IF NOT EXISTS spaces (
        id            TEXT PRIMARY KEY,
        parent_id     TEXT REFERENCES spaces(id),
        name          TEXT NOT NULL,
        space_type    TEXT NOT NULL,
        tenancy_mode  TEXT NOT NULL DEFAULT 'team'
                        CHECK (tenancy_mode IN ('single','team','saas')),
        agency_shell  INTEGER NOT NULL DEFAULT 0,
        depth         INTEGER NOT NULL DEFAULT 0 CHECK (depth IN (0, 1)),
        scenario_type TEXT,
        status        TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','suspended','deleted')),
        settings      TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_spaces_parent ON spaces(parent_id);

      CREATE TABLE IF NOT EXISTS cross_space_grants (
        id                 TEXT PRIMARY KEY,
        granting_space_id  TEXT NOT NULL,
        receiving_space_id TEXT NOT NULL,
        grant_type         TEXT NOT NULL
                             CHECK (grant_type IN ('read-knowledge','read-threads','full-access')),
        granted_by         TEXT NOT NULL,
        granted_at         TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at         TEXT,
        revoked_at         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_csg_receiving ON cross_space_grants(receiving_space_id);
      CREATE INDEX IF NOT EXISTS idx_csg_granting ON cross_space_grants(granting_space_id);
    `,
  },
  {
    version: 11,
    // Projects — "a project is a grouping of threads within a space" (CLAUDE.md). Threads
    // already carry project_id; this is the registry the bootstrap/onboarding creates on first
    // run (e.g. Whop-seller → Members / Support / Content). Not a sub-space (own DO/structure) —
    // just a labelled grouping inside this space's DO.
    description: "projects registry (thread grouping)",
    up: `
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        space_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_projects_space ON projects(space_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_space_name ON projects(space_id, name);
    `,
  },
  {
    version: 12,
    // Customer-facing bot projects (WhatsApp/Discord/etc business bots). A project can be
    // flagged `kind = 'customer_bot'`: the UI surface flips from "workspace I chat in" to
    // "surface I watch and configure," each external user becomes a thread (the normal
    // project/thread model — no new addressing concept), and the bound agent runs under
    // real, structural constraints instead of full autonomy:
    //   - execution_ceiling caps which execution-ladder tier its scripts may use (e.g. a
    //     ceiling of 2 means "can talk and look things up, never touch a container").
    //   - daily_spend_cap_credits bounds runaway spend from a chatty/adversarial customer.
    //   - channel_config records which channel(s) are bound (the channel_links row in the
    //     agents worker's D1 carries the matching project_id — this is the SpaceDO side of
    //     that link, kept here because the project is what an admin configures/sees).
    description:
      "customer-bot project config + project_rules (no-code triggers)",
    up: `
      ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'workspace' CHECK (kind IN ('workspace','customer_bot'));
      ALTER TABLE projects ADD COLUMN execution_ceiling INTEGER NOT NULL DEFAULT 5 CHECK (execution_ceiling BETWEEN 1 AND 5);
      ALTER TABLE projects ADD COLUMN daily_spend_cap_credits INTEGER NOT NULL DEFAULT 0; -- 0 = no cap
      ALTER TABLE projects ADD COLUMN channel_config TEXT NOT NULL DEFAULT '{}';

      -- No-code "after customer says X, this happens" rules (checked before the full
      -- reasoning loop — cheap, deterministic, admin-authored, no coding required).
      CREATE TABLE IF NOT EXISTS project_rules (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL,
        space_id        TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,   -- substring/keyword match against the inbound text
        action          TEXT NOT NULL CHECK (action IN ('reply','run_script','human_takeover')),
        reply_text      TEXT,            -- when action = 'reply'
        script_name     TEXT,            -- when action = 'run_script'
        enabled         INTEGER NOT NULL DEFAULT 1,
        priority        INTEGER NOT NULL DEFAULT 0, -- higher checked first
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_project_rules_project ON project_rules(project_id, enabled, priority DESC);
    `,
  },
  {
    version: 13,
    // Thread hierarchy: a sub-agent run or a channel (WhatsApp/Discord/email) conversation is
    // NOT a new addressing concept — it's just another thread, linked to its parent via
    // parent_thread_id like any subthread would be. thread_kind distinguishes the three shapes
    // so the default thread list can hide the noisy ones (a project spawning 16 sub-agents
    // shouldn't flood the builder's thread list) while still making them fully browsable —
    // an admin who wants to audit a project's whole sub-agent tree, or every channel session,
    // just flips show_sub_threads (or passes include_sub_threads=true) to see them inline,
    // nested under the thread that spawned/received them.
    description:
      "thread hierarchy (parent_thread_id, thread_kind) + show_sub_threads config",
    up: `
      ALTER TABLE threads ADD COLUMN parent_thread_id TEXT REFERENCES threads(id);
      ALTER TABLE threads ADD COLUMN thread_kind TEXT NOT NULL DEFAULT 'primary' CHECK (thread_kind IN ('primary','sub_agent','channel'));
      ALTER TABLE threads ADD COLUMN channel TEXT;
      ALTER TABLE threads ADD COLUMN channel_session_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parent_thread_id) WHERE parent_thread_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_threads_kind ON threads(space_id, thread_kind, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_channel_session ON threads(channel_session_id) WHERE channel_session_id IS NOT NULL;

      -- Off by default: a builder's thread list stays exactly as it looked before this
      -- migration until they (or a customer-bot template) explicitly opt in.
      ALTER TABLE projects ADD COLUMN show_sub_threads INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 14,
    // Space Assistant approval policy: "same access as the owning user, but ask before
    // acting unless the user has explicitly trusted this action." One row per space.
    // approval_mode='always_ask' (the default) gates EVERY action unless it's in
    // auto_approved_actions; approval_mode='yolo' skips asking entirely. This inverts the
    // ordinary Naelao Agent's requires_approval_for allowlist (which gates a SPECIFIC list of
    // actions, everything else free) — see loop.ts's ApprovalMode.
    description:
      "assistant_policy (Space Assistant approval mode + auto-approved actions)",
    up: `
      CREATE TABLE IF NOT EXISTS assistant_policy (
        space_id              TEXT PRIMARY KEY,
        approval_mode         TEXT NOT NULL DEFAULT 'always_ask' CHECK (approval_mode IN ('always_ask','yolo')),
        auto_approved_actions TEXT NOT NULL DEFAULT '[]', -- JSON array of action names
        updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 15,
    // Event triggers (spec-adjacent "no-code, from projects to threads to everything"):
    // "after event X happens in this project/space, run script Y" — the same no-code,
    // admin/assistant-authored, checked-before-anything-expensive pattern as project_rules,
    // generalized from "customer said X" to "X happened structurally" (a thread was created,
    // a project was created, ...). Always scoped to project_id (or space-wide when NULL) —
    // condition evaluation and target-thread resolution NEVER cross that boundary (an agent
    // cannot construct a trigger, or have one fire, against another project's threads).
    description:
      "event_triggers (no-code lifecycle triggers, e.g. 'thread created -> compact the idle one')",
    up: `
      CREATE TABLE IF NOT EXISTS event_triggers (
        id            TEXT PRIMARY KEY,
        space_id      TEXT NOT NULL,
        project_id    TEXT, -- NULL = space-wide
        event_type    TEXT NOT NULL, -- e.g. 'thread.created', 'project.created'
        condition     TEXT NOT NULL DEFAULT '{"type":"always"}', -- JSON TriggerCondition (@naelao/events)
        script_name   TEXT NOT NULL, -- the script.run action fired on match
        params        TEXT NOT NULL DEFAULT '{}', -- JSON, merged with event-derived params at fire time
        enabled       INTEGER NOT NULL DEFAULT 1,
        priority      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_event_triggers_lookup ON event_triggers(space_id, event_type, enabled, priority DESC);
    `,
  },
  {
    version: 16,
    // Presence (spec A1.8 "space collaboration"): "the company state is shared ... two
    // members' assistants do not build two companies because they read/write the same shared
    // state." Coordination = locks (already built, LockDO/A1.15) + presence + project
    // deduplication (this migration + createProject below). Presence is a lightweight
    // heartbeat, not a WebSocket/DO-alarm system: one row per (space, user) recording where
    // they currently are; a caller-supplied freshness window (isPresenceFresh, @naelao/events)
    // decides who still counts as "active" — a crashed/closed client just ages out.
    description:
      "presence (heartbeat-based, one row per space+user — who's active where)",
    up: `
      CREATE TABLE IF NOT EXISTS presence (
        space_id      TEXT NOT NULL,
        user_id       TEXT NOT NULL,
        project_id    TEXT, -- NULL = present at the space level, not scoped to one project
        thread_id     TEXT,
        last_seen_at  INTEGER NOT NULL, -- unix ms
        PRIMARY KEY (space_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_presence_project ON presence(space_id, project_id, last_seen_at DESC);
    `,
  },
  {
    version: 17,
    // F9: the customer-bot daily spend cap was enforced against a `project_spend` table living
    // in NaelaoAgentDO's OWN SQLite — but agent DOs are addressed space:project:thread, so
    // every thread got an independent, zero-based tally. A project with N concurrent customer
    // threads could spend up to N x its configured cap. SpaceDO is one DO per space (all
    // threads/projects in it share this single instance), so it's the correct single writer:
    // moving the authoritative tally here means every thread's spend against the same project
    // lands in the same row, serialized by the DO's single-threaded request handling.
    description:
      "project_spend (authoritative per-project daily spend tally, single-writer)",
    up: `
      CREATE TABLE IF NOT EXISTS project_spend (
        project_id TEXT NOT NULL,
        day        TEXT NOT NULL, -- YYYY-MM-DD (UTC)
        credits    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, day)
      );
    `,
  },
  {
    version: 18,
    // Templates ship pre-wired projects (and, per the bootstrap flow, a starter thread inside
    // each one) bound to whichever installed agent owns that project's work — e.g. Launchpad's
    // creator-store template's "Orders" project defaults to launchpad-fulfillment-v1, "Support"
    // to launchpad-support-v1. This is a DEFAULT only, not an enforced identity: any caller may
    // still pass a different agentId to /script/run for a thread in this project. Nullable —
    // reference/data projects (e.g. "Products", "Members", "FAQ") intentionally have no default
    // agent, since nothing runs automatically in them.
    description: "projects.default_agent_id (template-seeded agent binding)",
    up: `
      ALTER TABLE projects ADD COLUMN default_agent_id TEXT;
    `,
  },
  {
    version: 19,
    // Per-project configurability, round 2: a hard cap on how many "real" conversations
    // (primary threads + channel sessions — NOT ephemeral sub-agent fan-out, which is already
    // bounded by MAX_SUB_AGENTS_PER_SPAWN/ConcurrencyDO) a project may host at once, and a
    // restricted agent allowlist so a thread's "switch agent" surface can be scoped to just the
    // agents relevant to this project instead of every agent in the space. Both nullable/zero
    // means "unrestricted" (today's behavior) — a project only gets these limits when a builder,
    // the Space Assistant, or a project template explicitly sets them.
    description: "projects.max_threads + projects.allowed_agent_ids",
    up: `
      ALTER TABLE projects ADD COLUMN max_threads INTEGER NOT NULL DEFAULT 0; -- 0 = unlimited
      ALTER TABLE projects ADD COLUMN allowed_agent_ids TEXT; -- JSON string[]; NULL = unrestricted
    `,
  },
  {
    version: 20,
    // Container Marketplace (spec §33b, gap G-1; §A1.17 Phase L). Phase K gave every project one
    // base Tier-5 sandbox (ephemeral compute, R2-synced /workspace); this table is the slot
    // registry for ADDITIONAL, dedicated containers a project can add (a database, a cache) —
    // each row is one slot, addressed by its own DO once its image is actually wired (see the
    // catalogue's `available` flag — every image ships `false` this pass; the registry/limit
    // mechanism is real and tested ahead of any specific image going live).
    description: "container_slots (Container Marketplace slot registry)",
    up: `
      CREATE TABLE IF NOT EXISTS container_slots (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        space_id    TEXT NOT NULL,
        image_id    TEXT NOT NULL,
        slot_name   TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'provisioning'
          CHECK (status IN ('provisioning','running','stopped','error')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_container_slots_project ON container_slots(project_id);
    `,
  },
  {
    version: 21,
    // Local-machine-as-container (spec "Local PC as a Container Target", gap G-3; §A1.17 Phase
    // M). A grant is an explicit, revocable opt-in: "the agent may read/write under THIS
    // directory" or "the agent may run THESE exact commands" on ONE builder's own machine (the
    // Naelao Local Agent tunnel is addressed per (space, user_id) — see LocalTunnelDO). No
    // grant exists by default; the local-machine prebuilt fails closed with no active grant.
    // project_id nullable = a space-wide grant (usable by the Space Assistant); set = scoped to
    // one project's threads only.
    description: "local_grants (Local-machine-as-container permission model)",
    up: `
      CREATE TABLE IF NOT EXISTS local_grants (
        id            TEXT PRIMARY KEY,
        space_id      TEXT NOT NULL,
        project_id    TEXT,
        user_id       TEXT NOT NULL,
        grant_type    TEXT NOT NULL CHECK (grant_type IN ('read','write','readwrite','exec')),
        directory     TEXT,
        commands_json TEXT NOT NULL DEFAULT '[]',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_local_grants_space ON local_grants(space_id);
      CREATE INDEX IF NOT EXISTS idx_local_grants_user ON local_grants(user_id);
    `,
  },
  {
    version: 22,
    // §A1.17 Phase O: "make an API for the whole platform — what a user can do manually, an
    // agent can do the same way, through the same routes, just attributed to itself." An agent
    // authenticates with its own nak_... key (never the builder's JWT); agent_api_keys is this
    // space's own key store (mirrors BuilderAccountDO.api_keys — hash + prefix only, raw key
    // returned once at mint time and never persisted). agent_policy_overrides is a PER-AGENT
    // approval policy, additive to (never replacing) the existing space-wide `assistant_policy`
    // row: an agent with no override row here falls back to assistant_policy's gate_unless_listed
    // default (always_ask, nothing pre-approved) — fail closed, same posture as
    // fetchAssistantPolicy. A separate table rather than widening assistant_policy's PK because
    // assistant_policy is keyed PRIMARY KEY(space_id) alone (one space-wide row) and changing that
    // key shape would risk the existing single-row-per-space call sites; this is purely additive.
    // messages.author_type/author_id: so a thread bubble can say "Agent1" vs "Agent2" vs the
    // Space Assistant instead of every non-user message collapsing into a bare 'assistant' role —
    // the same field Phase T's @mention multi-agent replies key off of.
    description:
      "agent_api_keys, agent_policy_overrides, messages.author_type/author_id",
    up: `
      CREATE TABLE IF NOT EXISTS agent_api_keys (
        id           TEXT PRIMARY KEY,
        agent_id     TEXT NOT NULL,
        key_hash     TEXT NOT NULL,
        key_prefix   TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        revoked_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_api_keys_hash ON agent_api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_agent_api_keys_agent ON agent_api_keys(agent_id);

      CREATE TABLE IF NOT EXISTS agent_policy_overrides (
        space_id              TEXT NOT NULL,
        agent_id              TEXT NOT NULL,
        approval_mode         TEXT NOT NULL DEFAULT 'always_ask' CHECK (approval_mode IN ('always_ask','yolo')),
        auto_approved_actions TEXT NOT NULL DEFAULT '[]',
        updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (space_id, agent_id)
      );

      ALTER TABLE messages ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user' CHECK (author_type IN ('user','agent','assistant','tool'));
      ALTER TABLE messages ADD COLUMN author_id TEXT;
    `,
  },
  {
    version: 23,
    // §A1.17 Phase T: project collaboration. T1 — real visibility + membership: a 'private'
    // project (the default, preserving today's implicit behavior) is visible only to its
    // project_members plus the space's own owner/admin (checkCrossSpace's existing
    // owner-override precedent); 'public' is visible to every space member, same as before this
    // migration. project_members is an ACL, not just a "who's active" list — role gates member
    // management itself (owner/editor can add/remove; viewer cannot). T3 — hybrid thread
    // locking: exclusive_mode is OFF by default (today's behavior, unlimited concurrent threads);
    // when a builder opts a project into it, active_thread_id/active_thread_since track which
    // thread currently holds the lock, enforced by a dedicated activate-thread endpoint (not
    // wired into every message send — sessions and structural threads are two separate tables
    // with no server-side link today, a documented pre-existing gap; a client acquires the lock
    // when a user opens/focuses a thread, which is both simpler and a more realistic UX than a
    // per-message check).
    description:
      "project visibility + project_members ACL + exclusive-mode thread locking",
    up: `
      ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private'));
      ALTER TABLE projects ADD COLUMN created_by TEXT;
      ALTER TABLE projects ADD COLUMN exclusive_mode INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN active_thread_id TEXT;
      ALTER TABLE projects ADD COLUMN active_thread_since TEXT;

      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','editor','viewer')),
        added_at   TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
    `,
  },
  {
    version: 24,
    // §A1.17 Phase U: Memory OS project-shared layers. T2 committed each (thread, agentId) pair
    // to its OWN NaelaoAgentDO instance/memory — meaning without this table, two threads in the
    // SAME project sharing an agent (or two different mentioned agents in the same project) would
    // have ZERO shared knowledge, since Memory OS Layers 3 (facts)/4 (fabric)/6 (wiki) live in
    // each DO's own SQLite today. Promoted here to SpaceDO (one instance per SPACE, reused rather
    // than a new DO class), keyed by project_id so a project's agents share a "team knowledge"
    // layer while staying isolated from every other project's. Layer 5 (episodic/semantic vector
    // memory) deliberately stays exactly where it is — private per (thread, agentId), never
    // promoted here. The Space Assistant's own facts/fabric/wiki (its `_assistant` slot, no
    // projectId) are UNAFFECTED — they keep using NaelaoAgentDO's local memory-os.ts tables
    // exactly as before this migration; only project-bound agent threads route here.
    description: "project-scoped Memory OS Layers 3/4/6 (facts, fabric, wiki)",
    up: `
      CREATE TABLE IF NOT EXISTS project_facts (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        entity      TEXT NOT NULL,
        relation    TEXT NOT NULL,
        attribute   TEXT NOT NULL,
        trust_score REAL NOT NULL DEFAULT 1.0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_facts_unique ON project_facts(project_id, entity, relation);
      CREATE INDEX IF NOT EXISTS idx_project_facts_project ON project_facts(project_id);

      CREATE TABLE IF NOT EXISTS project_fabric (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        summary      TEXT NOT NULL,
        key_insights TEXT NOT NULL DEFAULT '[]',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_project_fabric_project ON project_fabric(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS project_wiki (
        project_id    TEXT NOT NULL,
        concept       TEXT NOT NULL,
        definition    TEXT NOT NULL,
        relationships TEXT NOT NULL DEFAULT '[]',
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, concept)
      );
    `,
  },
  {
    version: 25,
    // Launchpad Wallet (user-directed feature): a project can be flagged kind='wallet' — a
    // business's own stored-value balance, topped up via Lemon Squeezy checkout (billing
    // worker's /internal/wallet/checkout, same pattern as the existing credit-packs/
    // business-subscriptions checkouts) and drawn down for NAELAO's OWN metered platform costs
    // (script/container spend beyond a project's normal daily_spend_cap_credits, wallet-funded
    // add-ons, etc). Deliberately scoped to that — an internal ledger Naelao is the ledger-of-
    // record for, NOT a payment rail that pays third parties (Whop/Shopify/Stripe) on a
    // business's behalf. Actually issuing outbound payments to arbitrary vendors is a real
    // money-transmission/PCI undertaking this build does not attempt; see wallet.ts's own
    // header comment for the full boundary. wallet_ledger is balance-derived (SUM of deltas,
    // same append-only-ledger-is-the-source-of-truth pattern as ProductUserDO's credit_ledger)
    // rather than a cached balance column, so a replayed webhook can never double-credit —
    // idempotency_key mirrors credit_ledger's own unique-partial-index convention exactly.
    //
    // SQLite can't widen an existing CHECK constraint via ALTER TABLE, so this rebuilds
    // `projects` with every column accumulated by migrations 1/12/13/18/19/23 preserved
    // byte-for-byte, only the `kind` CHECK widened to add 'wallet'.
    description:
      "projects.kind widened to include 'wallet' + wallet_ledger (Launchpad Wallet)",
    up: `
      CREATE TABLE projects_new (
        id                      TEXT PRIMARY KEY,
        space_id                TEXT NOT NULL,
        name                    TEXT NOT NULL,
        description             TEXT NOT NULL DEFAULT '',
        status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        kind                    TEXT NOT NULL DEFAULT 'workspace' CHECK (kind IN ('workspace','customer_bot','wallet')),
        execution_ceiling       INTEGER NOT NULL DEFAULT 5 CHECK (execution_ceiling BETWEEN 1 AND 5),
        daily_spend_cap_credits INTEGER NOT NULL DEFAULT 0,
        channel_config          TEXT NOT NULL DEFAULT '{}',
        show_sub_threads        INTEGER NOT NULL DEFAULT 0,
        default_agent_id        TEXT,
        max_threads             INTEGER NOT NULL DEFAULT 0,
        allowed_agent_ids       TEXT,
        visibility              TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
        created_by              TEXT,
        exclusive_mode          INTEGER NOT NULL DEFAULT 0,
        active_thread_id        TEXT,
        active_thread_since     TEXT
      );
      INSERT INTO projects_new SELECT
        id, space_id, name, description, status, created_at, kind, execution_ceiling,
        daily_spend_cap_credits, channel_config, show_sub_threads, default_agent_id, max_threads,
        allowed_agent_ids, visibility, created_by, exclusive_mode, active_thread_id, active_thread_since
      FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;
      CREATE INDEX IF NOT EXISTS idx_projects_space ON projects(space_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_space_name ON projects(space_id, name);

      CREATE TABLE IF NOT EXISTS wallet_ledger (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL,
        space_id          TEXT NOT NULL,
        delta_cents       INTEGER NOT NULL,
        currency          TEXT NOT NULL DEFAULT 'USD',
        reason            TEXT NOT NULL,
        balance_after_cents INTEGER NOT NULL,
        idempotency_key   TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_ledger_project ON wallet_ledger(project_id, created_at ASC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_ledger_idempotency
        ON wallet_ledger(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    // External revenue tracker: a business whose real sales happen on a platform Naelao never
    // custodies money through (Whop, most commonly) has no natural point for Naelao/the builder
    // to take a cut the way the wallet-settlement path (P0-5) does for LS-native storefront
    // sales. This tracks that business's own reported gross revenue per period (read-only, via
    // the existing mcp-connector prebuilt's `list_payments` call against the business's OWN
    // Whop credential) so a builder-configured revenue-cut % can be billed as an additional
    // charge — the actual cut/billing logic lives in the billing worker; this table is purely
    // the observed-revenue ledger. One row per (space, period, provider): re-tracking the SAME
    // period overwrites it (a snapshot of "revenue observed as of the last check", not an
    // accumulating ledger — a period's revenue can only grow as more of it completes, so the
    // latest observation is what matters for billing).
    version: 26,
    description:
      "external_revenue_snapshots (Whop-native business revenue tracker)",
    up: `
      CREATE TABLE IF NOT EXISTS external_revenue_snapshots (
        id             TEXT PRIMARY KEY,
        space_id       TEXT NOT NULL,
        period         TEXT NOT NULL, -- 'YYYY-MM'
        provider       TEXT NOT NULL DEFAULT 'whop',
        revenue_cents  INTEGER NOT NULL DEFAULT 0,
        billed         INTEGER NOT NULL DEFAULT 0, -- 1 once a revenue-cut surcharge has been charged for this period
        tracked_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_revenue_period ON external_revenue_snapshots(space_id, period, provider);
      CREATE INDEX IF NOT EXISTS idx_ext_revenue_tracked ON external_revenue_snapshots(space_id, tracked_at DESC);
    `,
  },
  {
    // Security audit follow-up (observability gap): a builder had no way to see what their
    // agent has actually been doing — no run history, no cost, no visibility into why it
    // escalated. agent_runs lives inside NaelaoAgentDO, one DO per (space, project, thread) —
    // querying it for a whole product would mean opening every single agent DO, the same
    // "doesn't scale" problem business_memberships/threads-mirroring already solved elsewhere
    // on this platform. Mirrors that precedent: NaelaoAgentDO posts one row here per run
    // completion/failure and per approval request/resolution, via a new internal HMAC-gated
    // endpoint — SpaceDO becomes the single, product-wide, paginated read surface a builder
    // dashboard can query directly.
    version: 27,
    description: "agent_activity_log — cross-DO builder observability surface",
    up: `
      CREATE TABLE IF NOT EXISTS agent_activity_log (
        id           TEXT PRIMARY KEY,
        space_id     TEXT NOT NULL,
        project_id   TEXT,
        thread_id    TEXT,
        agent_id     TEXT NOT NULL,
        event_type   TEXT NOT NULL CHECK (event_type IN (
          'run_completed', 'run_failed', 'approval_requested', 'approval_resolved', 'moderation_blocked'
        )),
        summary      TEXT NOT NULL DEFAULT '',
        tokens_used  INTEGER,
        cost_credits INTEGER,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_activity_space ON agent_activity_log(space_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_activity_project ON agent_activity_log(project_id, created_at DESC);
    `,
  },
  {
    version: 28,
    description:
      "Business Feature Projects: projects.is_singleton_kind + drop kind CHECK (validate in app against BUSINESS_FEATURE_KIND_REGISTRY) + partial unique index for singleton kinds",
    up: `
      CREATE TABLE projects_new (
        id                      TEXT PRIMARY KEY,
        space_id                TEXT NOT NULL,
        name                    TEXT NOT NULL,
        description             TEXT NOT NULL DEFAULT '',
        status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        kind                    TEXT NOT NULL DEFAULT 'workspace',
        execution_ceiling       INTEGER NOT NULL DEFAULT 5 CHECK (execution_ceiling BETWEEN 1 AND 5),
        daily_spend_cap_credits INTEGER NOT NULL DEFAULT 0,
        channel_config          TEXT NOT NULL DEFAULT '{}',
        show_sub_threads        INTEGER NOT NULL DEFAULT 0,
        default_agent_id        TEXT,
        max_threads             INTEGER NOT NULL DEFAULT 0,
        allowed_agent_ids       TEXT,
        visibility              TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
        created_by              TEXT,
        exclusive_mode          INTEGER NOT NULL DEFAULT 0,
        active_thread_id        TEXT,
        active_thread_since     TEXT,
        is_singleton_kind       INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO projects_new SELECT
        id, space_id, name, description, status, created_at, kind, execution_ceiling,
        daily_spend_cap_credits, channel_config, show_sub_threads, default_agent_id, max_threads,
        allowed_agent_ids, visibility, created_by, exclusive_mode, active_thread_id, active_thread_since,
        CASE WHEN kind = 'wallet' THEN 1 ELSE 0 END
      FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;
      CREATE INDEX IF NOT EXISTS idx_projects_space ON projects(space_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_space_name ON projects(space_id, name);
      -- The real singleton guarantee (F-32): at most one ACTIVE project per (space, kind) among
      -- singleton kinds. DO-SQLite has no SELECT FOR UPDATE, so an app-level check races — this
      -- partial unique index is the enforcement, a second create attempt hits a constraint error.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_singleton_kind
        ON projects(space_id, kind) WHERE is_singleton_kind = 1 AND status = 'active';
    `,
  },
  {
    version: 29,
    description:
      "project_members.assistant_mode — clamp an assistant's effective access when acting on behalf of a specific user (F-36)",
    up: `
      ALTER TABLE project_members ADD COLUMN assistant_mode TEXT NOT NULL DEFAULT 'inherit'
        CHECK (assistant_mode IN ('inherit','read_only','none'));
    `,
  },
  {
    version: 30,
    description:
      "external_revenue_snapshots: billed_cents (F-27 delta billing) + pending_checkout_at (F-31 in-flight-checkout guard)",
    up: `
      -- F-27: how much of this period's cut has ACTUALLY been charged. A correction re-bills only
      -- max(0, cut(new_revenue) - billed_cents), never the full corrected figure.
      ALTER TABLE external_revenue_snapshots ADD COLUMN billed_cents INTEGER NOT NULL DEFAULT 0;
      -- F-31: when a surcharge checkout covering this period was minted (skipped for ~24h so two
      -- checkouts issued before either is paid don't both bill it). Cleared on pay/refund.
      ALTER TABLE external_revenue_snapshots ADD COLUMN pending_checkout_at TEXT;
      -- Backfill: an already-billed period gets billed_cents = revenue_cents (a ceiling that's
      -- always >= any cut, so it's never re-billed) — the exact historical cut wasn't stored, and
      -- erring toward "already billed" is the conservative direction (never double-bill).
      UPDATE external_revenue_snapshots SET billed_cents = revenue_cents WHERE billed = 1;
    `,
  },
  {
    // §A1 Harness Excellence Phase HX2: signals + session token-budget guard substrate.
    // agent_signal_events is the IMPLICIT-signal counterpart to the already-existing
    // agent_activity_log (which already carries everything needed for EXPLICIT signals —
    // error rate / avg cost per run are computed on read from that table, no new storage).
    // session_spend is the per-session cumulative credit meter the budget guard reads/writes;
    // the ceiling itself is NOT stored here (would be a split-brain against
    // productConfig.limits.sessionCreditCeiling, config_json's already-authoritative copy) —
    // only the running tally.
    version: 31,
    description:
      "agent_signal_events (implicit signals) + session_spend (session token-budget guard)",
    up: `
      CREATE TABLE IF NOT EXISTS agent_signal_events (
        id           TEXT PRIMARY KEY,
        space_id     TEXT NOT NULL,
        project_id   TEXT,
        thread_id    TEXT,
        agent_id     TEXT NOT NULL,
        signal_type  TEXT NOT NULL,
        detail       TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_signal_events_space ON agent_signal_events(space_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS session_spend (
        session_id   TEXT PRIMARY KEY,
        space_id     TEXT NOT NULL,
        project_id   TEXT,
        credits_used INTEGER NOT NULL DEFAULT 0,
        warned_80    INTEGER NOT NULL DEFAULT 0,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_session_spend_space ON session_spend(space_id);
    `,
  },
  {
    // threads.session_id — a general-purpose link from a structural thread row to the real chat
    // session (SpaceDO `sessions`) that carries its actual messages. Item 71/74 documented these
    // as two separate tables with no server-side link, approximated client-side via a cached
    // sessionKey; this column closes that gap for threads created THROUGH this link (notably the
    // new assistant<->agent consult subthreads, §A1.18/A1.34 thread model) without retrofitting
    // every pre-existing thread/session pair, which stays exactly as it was.
    version: 32,
    description:
      "threads.session_id — links a structural thread to its chat session",
    up: `
      ALTER TABLE threads ADD COLUMN session_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id) WHERE session_id IS NOT NULL;
    `,
  },
  {
    // messages.metadata — same free-form JSON-override pattern sessions.metadata already used
    // (this table, migration 0001). Item 79 (inline consult cards): when the assistant's own
    // reply in a visible thread resulted from consulting a project agent in a hidden subthread
    // (thread.consult), the ASSISTANT'S message here carries which subthread(s) it opened —
    // {consulted_threads: [{thread_id, agent_id, title}]} — so the client can render an inline,
    // expandable card at the exact point in the conversation where the delegation happened,
    // instead of only in a separate side panel with no correlation to any specific turn.
    version: 33,
    description:
      "messages.metadata — carries structured per-message data (e.g. consulted_threads)",
    up: `
      ALTER TABLE messages ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    // notifications — a durable, business-member-visible inbox for what the assistant/its agents
    // surface (an approval waiting, a run that failed, a connector that needs setup). Distinct
    // from agent_activity_log (builder-only, a technical audit trail) — this is END-USER-facing
    // (a business admin using the shell) and carries read/delivery state so the assistant's own
    // heartbeat sweep can tell "already seen" from "still needs escalating to a channel".
    version: 34,
    description:
      "notifications — durable business-member inbox + delivery tracking for heartbeat escalation",
    up: `
      CREATE TABLE IF NOT EXISTS notifications (
        id            TEXT PRIMARY KEY,
        space_id      TEXT NOT NULL,
        project_id    TEXT,
        kind          TEXT NOT NULL,
        title         TEXT NOT NULL,
        body          TEXT NOT NULL DEFAULT '',
        severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
        source_agent_id TEXT,
        related_id    TEXT,
        status        TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read')),
        read_at       TEXT,
        delivered_at  TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_space ON notifications(space_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_undelivered ON notifications(space_id, status, delivered_at, created_at);
    `,
  },
  {
    // connector_account_mode — a per-session preference: which credential tier a script's mcp-hub
    // calls should use for a given connector ("business", the default shared account, vs
    // "personal", the caller's own connected one). No row for a connector = business (today's
    // default resolution, unchanged). Deliberately its own table rather than folded into
    // sessions.metadata — updateSession's PATCH replaces the whole metadata object, and a UI
    // toggle firing concurrently with, say, a title update would silently clobber one or the other.
    version: 35,
    description:
      "connector_account_mode — per-session business-vs-personal connector preference",
    up: `
      CREATE TABLE IF NOT EXISTS connector_account_mode (
        session_id   TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        mode         TEXT NOT NULL CHECK (mode IN ('business', 'personal')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, connector_id)
      );
    `,
  },
  {
    // Failure diagnostics. agent_activity_log already recorded THAT a run failed, but not what
    // kind of failure it was or which thread to resume — so an assistant reading it could see
    // "3 runs failed" and do nothing useful with that. These four columns are what turn the log
    // into something actionable: the classification (see @naelao/events classifyFailure), and the
    // ids needed to actually go and continue the interrupted work.
    //
    // Deliberately ALTER ... ADD COLUMN rather than a table rebuild: the event_type CHECK
    // constraint stays exactly as it is, because a failed wake-up IS a failed run — 'run_failed'
    // plus a failure_kind says everything a new event type would have, without SQLite's
    // can't-alter-a-CHECK-in-place rebuild (migrations 0052/0065 hit that; not worth it here).
    version: 36,
    description:
      "agent_activity_log failure diagnostics — classification + ids to resume from",
    up: `
      ALTER TABLE agent_activity_log ADD COLUMN failure_kind TEXT;
      ALTER TABLE agent_activity_log ADD COLUMN session_id TEXT;
      ALTER TABLE agent_activity_log ADD COLUMN run_id TEXT;
      ALTER TABLE agent_activity_log ADD COLUMN trigger_source TEXT;
      CREATE INDEX IF NOT EXISTS idx_agent_activity_failure
        ON agent_activity_log(space_id, failure_kind, created_at DESC);
    `,
  },
  {
    // "recent" projects ordering was created_at-only — an assistant<->agent consult (or any real
    // activity in a project's own threads) never bumped a project back to the top, the reported
    // bug. last_activity_at is touched from ONE choke point, appendMessage (every message write —
    // human chat, consult subthread messages, anything thread-linked — already lands there), by
    // resolving the project via threads.project_id for the session, so this covers ordinary
    // project-thread chat and consult subthreads uniformly with no NaelaoAgentDO-side change.
    version: 37,
    description:
      "projects.last_activity_at (touched on any thread-linked message) — recent ordering",
    up: `
      ALTER TABLE projects ADD COLUMN last_activity_at TEXT;
    `,
  },
  {
    // POST /messages was not idempotent, and the shell's apiFetch retries a POST on a network-level
    // throw or a 5xx/429. A throw client-side does NOT mean the server didn't process it — a reset
    // connection or a response lost in transit both throw while the row is already committed — so a
    // retry wrote a SECOND identical message. Invisible in the live UI (the client only ever renders
    // the one response it eventually got) and visible the moment you reload: the reported duplicate.
    //
    // A partial unique index rather than a plain one so the overwhelming majority of historical rows
    // (client_message_id NULL) don't collide with each other. Dedupe is per session, since ids are
    // minted client-side and only need to be unique within the conversation they belong to.
    version: 38,
    description:
      "messages.client_message_id — idempotency key so a retried POST can't duplicate",
    up: `
      ALTER TABLE messages ADD COLUMN client_message_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id
        ON messages(session_id, client_message_id) WHERE client_message_id IS NOT NULL;
    `,
  },
  {
    // AVOS plan, step 4 — a task DAG state machine for multi-agent coordination WITHIN a
    // project. Distinct from project_journal's own todos (project-journal.ts): a journal todo
    // is a loose personal checklist item (text + done), with no dependency graph and no
    // assignment — fine for "what I still need to do," useless for "Agent2's task is blocked on
    // Agent1 finishing theirs." `dependencies` is a JSON array of other task ids in THIS same
    // table (never enforced as a real foreign key — D1/DO SQLite has no cross-row CHECK — the
    // `tasks` prebuilt script is what's expected to read it before marking a task IN_PROGRESS).
    version: 39,
    description:
      "tasks — a per-project task DAG (dependencies + status), for multi-agent coordination",
    up: `
      CREATE TABLE IF NOT EXISTS tasks (
        id             TEXT PRIMARY KEY,
        space_id       TEXT NOT NULL,
        project_id     TEXT,
        thread_id      TEXT,
        title          TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'blocked', 'cancelled')),
        dependencies   TEXT NOT NULL DEFAULT '[]',
        assigned_agent TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_space_project ON tasks(space_id, project_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id) WHERE thread_id IS NOT NULL;
    `,
  },
  {
    version: 40,
    description: "event triggers become project-only automation",
    up: `
      DELETE FROM event_triggers WHERE project_id IS NULL;
      CREATE TABLE event_triggers_v40 (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT NOT NULL,
        event_type TEXT NOT NULL, condition TEXT NOT NULL DEFAULT '{"type":"always"}',
        script_name TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO event_triggers_v40 SELECT * FROM event_triggers;
      DROP TABLE event_triggers;
      ALTER TABLE event_triggers_v40 RENAME TO event_triggers;
      CREATE INDEX idx_event_triggers_lookup ON event_triggers(space_id, project_id, event_type, enabled, priority DESC);
    `,
  },
  {
    version: 41,
    description: "expand execution_ceiling CHECK to support Tier 6 containers",
    up: `
      CREATE TABLE projects_v41 (
        id                      TEXT PRIMARY KEY,
        space_id                TEXT NOT NULL,
        name                    TEXT NOT NULL,
        description             TEXT NOT NULL DEFAULT '',
        status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        kind                    TEXT NOT NULL DEFAULT 'workspace',
        execution_ceiling       INTEGER NOT NULL DEFAULT 5 CHECK (execution_ceiling BETWEEN 1 AND 6),
        daily_spend_cap_credits INTEGER NOT NULL DEFAULT 0,
        channel_config          TEXT NOT NULL DEFAULT '{}',
        show_sub_threads        INTEGER NOT NULL DEFAULT 0,
        default_agent_id        TEXT,
        max_threads             INTEGER NOT NULL DEFAULT 0,
        allowed_agent_ids       TEXT,
        visibility              TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
        created_by              TEXT,
        exclusive_mode          INTEGER NOT NULL DEFAULT 0,
        active_thread_id        TEXT,
        active_thread_since     TEXT,
        is_singleton_kind       INTEGER NOT NULL DEFAULT 0,
        last_activity_at        TEXT
      );
      INSERT INTO projects_v41 SELECT
        id, space_id, name, description, status, created_at, kind, execution_ceiling,
        daily_spend_cap_credits, channel_config, show_sub_threads, default_agent_id, max_threads,
        allowed_agent_ids, visibility, created_by, exclusive_mode, active_thread_id, active_thread_since,
        is_singleton_kind, last_activity_at
      FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_v41 RENAME TO projects;
      CREATE INDEX idx_projects_space ON projects(space_id, created_at DESC);
      CREATE UNIQUE INDEX idx_projects_space_name ON projects(space_id, name);
      CREATE UNIQUE INDEX idx_projects_singleton_kind
        ON projects(space_id, kind) WHERE is_singleton_kind = 1 AND status = 'active';
    `,
  },
  {
    version: 42,
    description: "strict two-tier hierarchy, canonical cross-space tickets, public project default",
    up: `
      CREATE TRIGGER IF NOT EXISTS spaces_two_tier_insert
      BEFORE INSERT ON spaces WHEN NEW.depth NOT IN (0, 1)
      BEGIN SELECT RAISE(ABORT, 'space hierarchy depth must be 0 or 1'); END;

      CREATE TABLE cross_space_grants_v42 (
        id TEXT PRIMARY KEY,
        grantee_space_id TEXT NOT NULL,
        target_space_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        CHECK (grantee_space_id <> target_space_id)
      );
      INSERT INTO cross_space_grants_v42
        (id, grantee_space_id, target_space_id, resource_id, granted_by, created_at, expires_at, revoked_at)
      SELECT id, receiving_space_id, granting_space_id,
        CASE WHEN grant_type = 'full-access' THEN '*' ELSE grant_type END,
        granted_by, granted_at, COALESCE(expires_at, granted_at), revoked_at
      FROM cross_space_grants;
      DROP TABLE cross_space_grants;
      ALTER TABLE cross_space_grants_v42 RENAME TO cross_space_grants;
      CREATE INDEX idx_csg_grantee ON cross_space_grants(grantee_space_id);
      CREATE INDEX idx_csg_target ON cross_space_grants(target_space_id);

      CREATE TABLE project_members_v42 (
        project_id TEXT NOT NULL, user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','editor','viewer')),
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        assistant_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (assistant_mode IN ('inherit','read_only','none')),
        PRIMARY KEY (project_id, user_id)
      );
      INSERT INTO project_members_v42
        (project_id, user_id, role, added_at, created_at, assistant_mode)
      SELECT project_id, user_id, role, added_at, added_at, assistant_mode FROM project_members;
      DROP TABLE project_members;
      ALTER TABLE project_members_v42 RENAME TO project_members;
      CREATE INDEX idx_project_members_user ON project_members(user_id);

      CREATE TABLE projects_v42 (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')), kind TEXT NOT NULL DEFAULT 'workspace',
        execution_ceiling INTEGER NOT NULL DEFAULT 5 CHECK (execution_ceiling BETWEEN 1 AND 6),
        daily_spend_cap_credits INTEGER NOT NULL DEFAULT 0, channel_config TEXT NOT NULL DEFAULT '{}',
        show_sub_threads INTEGER NOT NULL DEFAULT 0, default_agent_id TEXT, max_threads INTEGER NOT NULL DEFAULT 0,
        allowed_agent_ids TEXT, visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
        created_by TEXT, exclusive_mode INTEGER NOT NULL DEFAULT 0, active_thread_id TEXT,
        active_thread_since TEXT, is_singleton_kind INTEGER NOT NULL DEFAULT 0, last_activity_at TEXT
      );
      INSERT INTO projects_v42 SELECT * FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_v42 RENAME TO projects;
      CREATE INDEX idx_projects_space ON projects(space_id, created_at DESC);
      CREATE UNIQUE INDEX idx_projects_space_name ON projects(space_id, name);
      CREATE UNIQUE INDEX idx_projects_singleton_kind
        ON projects(space_id, kind) WHERE is_singleton_kind = 1 AND status = 'active';
    `,
  },
  {
    version: 43,
    description: "logical connector aliases with three-tier execution scope",
    up: `
      CREATE TABLE IF NOT EXISTS connector_aliases (
        space_id TEXT NOT NULL,
        alias_name TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'space_shared'
          CHECK (scope IN ('space_shared','project_bound','user_personal')),
        project_id TEXT,
        user_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (space_id, alias_name, scope, project_id, user_id),
        CHECK ((scope='space_shared' AND project_id IS NULL AND user_id IS NULL)
          OR (scope='project_bound' AND project_id IS NOT NULL AND user_id IS NULL)
          OR (scope='user_personal' AND project_id IS NULL AND user_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_connector_alias_resolution
        ON connector_aliases(space_id, alias_name, user_id, project_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_alias_binding
        ON connector_aliases(space_id, alias_name, scope, ifnull(project_id,''), ifnull(user_id,''));
    `,
  },
  {
    version: 44,
    description: "single-use ephemeral action grant consumption ledger",
    up: `CREATE TABLE IF NOT EXISTS ephemeral_grants_consumed (
      nonce TEXT PRIMARY KEY, tool_name TEXT NOT NULL, consumed_at TEXT NOT NULL
    );`,
  },
  {
    version: 45,
    description: "goal planner task specifications and isolated worker budgets",
    up: `
      ALTER TABLE tasks ADD COLUMN subtask_spec TEXT;
      ALTER TABLE tasks ADD COLUMN assigned_role TEXT;
      ALTER TABLE tasks ADD COLUMN model TEXT;
      ALTER TABLE tasks ADD COLUMN file_paths TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE tasks ADD COLUMN budget_tokens INTEGER NOT NULL DEFAULT 1800;
    `,
  },
  {
    version: 46,
    description: "four-tier threads and dynamic project collaboration mode",
    up: `
      ALTER TABLE threads ADD COLUMN thread_tier TEXT NOT NULL DEFAULT 'tier_2_task'
        CHECK (thread_tier IN ('tier_1_team','tier_2_task','tier_3_consult','tier_4_scratchpad'));
      ALTER TABLE threads ADD COLUMN created_by TEXT;
      ALTER TABLE threads ADD COLUMN system_internal INTEGER NOT NULL DEFAULT 0;
      UPDATE threads SET created_by = user_id WHERE created_by IS NULL;
      UPDATE threads SET thread_tier = 'tier_3_consult', system_internal = 1
        WHERE thread_kind = 'sub_agent';
      CREATE INDEX IF NOT EXISTS idx_threads_tier ON threads(space_id, thread_tier, created_at DESC);
      ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'solo_cockpit'
        CHECK (mode IN ('solo_cockpit','multiplayer_office'));
      UPDATE projects SET mode = CASE
        WHEN (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = projects.id) > 1
        THEN 'multiplayer_office' ELSE 'solo_cockpit' END;
    `,
  },
  {
    version: 47,
    description: "inline pull request cards in team-room streams",
    up: `
      CREATE TABLE IF NOT EXISTS pull_request_cards (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT NOT NULL,
        thread_id TEXT, base_branch TEXT NOT NULL, fork_branch TEXT NOT NULL,
        title TEXT NOT NULL, author TEXT NOT NULL, reasoning TEXT NOT NULL,
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open'
          CHECK (status IN ('open','merged','revisions_requested','rejected')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pr_cards_room ON pull_request_cards(space_id, project_id, created_at DESC);
    `,
  },
  {
    version: 48,
    description: "atomic task leases, semantic intents, and sponsor-alignment RFCs",
    up: `
      ALTER TABLE tasks ADD COLUMN claimed_by TEXT;
      ALTER TABLE tasks ADD COLUMN lease_expires_at TEXT;
      ALTER TABLE tasks ADD COLUMN spectator_assistant_ids TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE tasks ADD COLUMN intent_embedding TEXT;
      ALTER TABLE tasks ADD COLUMN prompt_text TEXT;
      ALTER TABLE projects ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'ACTIVE';
      ALTER TABLE projects ADD COLUMN lead_user_id TEXT;
      ALTER TABLE notifications ADD COLUMN recipient_user_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_tasks_active_intent ON tasks(project_id, status);
      CREATE TABLE IF NOT EXISTS rfcs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
        conflicting_directives_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','CANCELLED')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rfcs_project_status ON rfcs(project_id, status, created_at DESC);
    `,
  },
  {
    version: 49,
    description: "tamper-evident provenance ledger and editor cursor presence",
    up: `
      CREATE TABLE IF NOT EXISTS provenance_ledger (
        entry_hash TEXT PRIMARY KEY,
        prev_hash TEXT NOT NULL,
        human_trigger_id TEXT NOT NULL,
        assistant_actor_id TEXT NOT NULL,
        project_executor_id TEXT NOT NULL,
        git_commit_oid TEXT NOT NULL,
        task_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_provenance_created ON provenance_ledger(created_at, entry_hash);
      ALTER TABLE presence ADD COLUMN file_path TEXT;
      ALTER TABLE presence ADD COLUMN cursor_line INTEGER;
      ALTER TABLE presence ADD COLUMN cursor_col INTEGER;
    `,
  },
  {
    version: 50,
    description: "finite project lifecycle and completed-project hibernation",
    up: `
      CREATE TABLE projects_v50 (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','HIBERNATED_COMPLETED')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')), kind TEXT NOT NULL DEFAULT 'workspace',
        execution_ceiling INTEGER NOT NULL DEFAULT 5 CHECK (execution_ceiling BETWEEN 1 AND 6),
        daily_spend_cap_credits INTEGER NOT NULL DEFAULT 0, channel_config TEXT NOT NULL DEFAULT '{}',
        show_sub_threads INTEGER NOT NULL DEFAULT 0, default_agent_id TEXT, max_threads INTEGER NOT NULL DEFAULT 0,
        allowed_agent_ids TEXT, visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
        created_by TEXT, exclusive_mode INTEGER NOT NULL DEFAULT 0, active_thread_id TEXT,
        active_thread_since TEXT, is_singleton_kind INTEGER NOT NULL DEFAULT 0, last_activity_at TEXT,
        execution_status TEXT NOT NULL DEFAULT 'ACTIVE', lead_user_id TEXT,
        lifecycle TEXT NOT NULL DEFAULT 'finite' CHECK (lifecycle IN ('finite','continuous'))
      );
      INSERT INTO projects_v50
        (id,space_id,name,description,status,created_at,kind,execution_ceiling,daily_spend_cap_credits,
         channel_config,show_sub_threads,default_agent_id,max_threads,allowed_agent_ids,visibility,created_by,
         exclusive_mode,active_thread_id,active_thread_since,is_singleton_kind,last_activity_at,execution_status,lead_user_id)
      SELECT id,space_id,name,description,status,created_at,kind,execution_ceiling,daily_spend_cap_credits,
         channel_config,show_sub_threads,default_agent_id,max_threads,allowed_agent_ids,visibility,created_by,
         exclusive_mode,active_thread_id,active_thread_since,is_singleton_kind,last_activity_at,execution_status,lead_user_id FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_v50 RENAME TO projects;
      CREATE INDEX idx_projects_space ON projects(space_id, created_at DESC);
      CREATE UNIQUE INDEX idx_projects_space_name ON projects(space_id, name);
      CREATE UNIQUE INDEX idx_projects_singleton_kind ON projects(space_id, kind)
        WHERE is_singleton_kind = 1 AND status = 'active';
      CREATE TABLE custom_model_manifests (
        model_id TEXT NOT NULL, space_id TEXT NOT NULL, base_model TEXT NOT NULL,
        lora_adapter_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (space_id, model_id)
      );
    `,
  },
  {
    version: 51,
    description: "display preferences, operating mode, and canvas viewport configuration",
    up: `
      ALTER TABLE projects ADD COLUMN template_mode TEXT NOT NULL DEFAULT 'cowork_studio'
        CHECK (template_mode IN ('autonomous_operator','autonomous_venture_os','cowork_studio'));
      ALTER TABLE projects ADD COLUMN viewport_config TEXT NOT NULL DEFAULT '{}';
      CREATE TABLE user_settings (
        user_id TEXT NOT NULL, space_id TEXT NOT NULL,
        display_mode TEXT NOT NULL DEFAULT 'business' CHECK (display_mode IN ('business','developer')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, space_id)
      );
    `,
  },
  {
    version: 52,
    description: "validated userspace extension installations",
    up: `
      CREATE TABLE installed_extensions (
        extension_id TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        installed_by TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 53,
    description: "24-hour webhook event idempotency registry",
    up: `
      CREATE TABLE processed_webhook_events (
        event_hash TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        processed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_processed_webhook_events_at ON processed_webhook_events(processed_at);
    `,
  },
  {
    version: 54,
    description: "project-universal crons and space-shared calendar state",
    up: `
      CREATE TABLE project_scheduled_jobs (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT NOT NULL,
        bot_id TEXT NOT NULL, cron_expression TEXT NOT NULL, script_path TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT '{}', last_run_at TEXT, next_run_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_project_scheduled_jobs_due
        ON project_scheduled_jobs(space_id, next_run_at);
      CREATE TABLE space_calendar_events (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL, calendar_id TEXT NOT NULL,
        start_at TEXT NOT NULL, end_at TEXT NOT NULL, client_details TEXT NOT NULL DEFAULT '{}',
        provider_booking_id TEXT, status TEXT NOT NULL DEFAULT 'confirmed',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_space_calendar_availability
        ON space_calendar_events(space_id, calendar_id, start_at, end_at);
    `,
  },
];

export const PROVENANCE_GENESIS_HASH = "0".repeat(64);

export async function provenanceHmac(secret: string, fields: readonly string[]): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(fields.join("")));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface SpaceDOEnv {
  PLATFORM_SECRET: string;
  /** Agents worker — used to fire event_triggers (script.run) on a structural lifecycle
   *  event (thread.created, project.created, ...). Optional: firing is best-effort, never
   *  blocks the state change that triggered it. */
  AGENTS_WORKER?: Fetcher;
  /** §A1.17 Phase V — naelao-ws-gateway, for live-syncing a mutation to a space's connected
   *  clients via WsHubDO. Optional: broadcastSpaceEvent degrades to a silent no-op when unbound. */
  WS_GATEWAY?: Fetcher;
}

// Row types for internal use
interface SessionRow {
  id: string;
  space_id: string;
  tenant_id: string;
  end_user_id: string | null;
  status: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  token_count: number | null;
  created_at: string;
  // §A1.17 Phase O: which identity actually produced an 'assistant'-role message — the Space
  // Assistant (author_id 'naelao-agent'), a named project agent (author_id = its agentId), or a
  // human ('user'/author_id = their user/end-user id). Lets a thread bubble render "Agent1" vs
  // "Agent2" vs the assistant instead of every non-user message collapsing into one identity.
  author_type: string;
  author_id: string | null;
  /** Raw JSON string (migration v33) — parsed in getMessages before it reaches a client. */
  metadata: string;
}

interface AgentStateRow {
  session_id: string;
  current_fsm_state: string;
  goal_stack: string;
  context_json: string;
}

interface SpaceRow {
  id: string;
  parent_id: string | null;
  name: string;
  space_type: string;
  tenancy_mode: string;
  agency_shell: number;
  depth: number;
  scenario_type: string | null;
  status: string;
  settings: string;
  created_at: string;
}

interface CrossSpaceGrantRow {
  id: string;
  grantee_space_id: string;
  target_space_id: string;
  resource_id: string;
  granted_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

// ── G-F03: Negative auth result cache ────────────────────────────────────────
// Key: deny:{userId}:{spaceId} → expiry timestamp ms
// In-memory only; intentionally lost on DO hibernation (acceptable for 30s TTL).
const DENY_CACHE_TTL_MS = 30_000;

// How long a presence row survives with no heartbeat before heartbeatPresence's opportunistic
// prune deletes it — deliberately much longer than PRESENCE_FRESHNESS_WINDOW_MS (~90s, which
// only governs GET /presence's "who's active" filter, not storage). 24h gives ample room for a
// legitimately-idle-but-still-open session while still bounding table growth from departed
// members and one-time invitees.
export const PRESENCE_PRUNE_CUTOFF_MS = 24 * 60 * 60 * 1000;

// ── SpaceDO ──────────────────────────────────────────────────────────────────
export class SpaceDO extends DurableObject<SpaceDOEnv> {
  private initialized = false;
  // G-F03: Negative auth cache — maps deny:{userId}:{spaceId} to expiry timestamp
  private readonly denyCache = new Map<string, number>();

  private isDenied(userId: string, spaceId: string): boolean {
    const key = `deny:${userId}:${spaceId}`;
    const expiry = this.denyCache.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.denyCache.delete(key);
      return false;
    }
    return true;
  }

  private cacheDeny(userId: string, spaceId: string): void {
    this.denyCache.set(
      `deny:${userId}:${spaceId}`,
      Date.now() + DENY_CACHE_TTL_MS
    );
  }

  private invalidateUserCache(userId: string, spaceId: string): void {
    this.denyCache.delete(`deny:${userId}:${spaceId}`);
  }

  private ensureInit(): void {
    if (this.initialized) return;
    applyMigrations(this.ctx.storage as never, MIGRATIONS);
    this.initialized = true;
  }

  /** Resolve on every invocation. A cron has no userId, so user_personal rows are not even
   * eligible for the query and their connector ids cannot leak into autonomous execution. */
  resolveConnectorAlias(
    spaceId: string,
    aliasName: string,
    projectId?: string,
    userId?: string
  ): { connector_id: string; scope: "space_shared" | "project_bound" | "user_personal" } | null {
    if (!spaceId || !/^[a-z][a-z0-9_]{1,63}$/.test(aliasName)) return null;
    return queryOne(
      this.ctx.storage.sql as never,
      `SELECT connector_id, scope FROM connector_aliases
       WHERE space_id = ? AND alias_name = ?
         AND ((scope = 'user_personal' AND user_id = ?)
           OR (scope = 'project_bound' AND project_id = ?)
           OR scope = 'space_shared')
       ORDER BY CASE scope
         WHEN 'user_personal' THEN 3 WHEN 'project_bound' THEN 2 ELSE 1 END DESC
       LIMIT 1`,
      spaceId,
      aliasName,
      userId ?? null,
      projectId ?? null
    ) as { connector_id: string; scope: "space_shared" | "project_bound" | "user_personal" } | null;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    try {
      if (url.pathname === "/extensions" && method === "GET") return this.listExtensions();
      if (url.pathname === "/extensions" && method === "POST") return await this.installExtension(request);
      const extensionMatch = url.pathname.match(/^\/extensions\/(ext_[a-z0-9_-]+)$/);
      if (extensionMatch?.[1] && method === "DELETE") return this.uninstallExtension(extensionMatch[1]);
      if (method === "POST" && url.pathname === "/ephemeral-grants/mint") {
        const body = await request.json<{ tool_name?: string; params?: Record<string, unknown> }>().catch(() => ({} as { tool_name?: string; params?: Record<string, unknown> }));
        if (!body.tool_name) return Response.json({ error: "tool_name is required" }, { status: 400 });
        const grant = await mintEphemeralActionGrant(body.tool_name, body.params ?? {}, this.env.PLATFORM_SECRET);
        return Response.json({ type: "mcp_v2_elicitation_card", action: body.tool_name, grant, expires_in_ms: 15_000 }, { status: 201 });
      }
      if (method === "POST" && url.pathname === "/ephemeral-grants/consume") {
        const body = await request.json<{ grant?: EphemeralActionGrant; tool_name?: string; params?: Record<string, unknown> }>().catch(() => ({} as { grant?: EphemeralActionGrant; tool_name?: string; params?: Record<string, unknown> }));
        if (!body.grant || !body.tool_name) return Response.json({ error: "grant and tool_name are required" }, { status: 400 });
        const consumed = await consumeEphemeralActionGrant(this.ctx.storage.sql, body.grant, body.tool_name, body.params ?? {}, this.env.PLATFORM_SECRET);
        return consumed ? Response.json({ consumed: true }) : Response.json({ error: "invalid_expired_or_replayed_grant" }, { status: 403 });
      }
      // POST /sessions
      if (method === "POST" && url.pathname === "/sessions") {
        return this.createSession(request);
      }
      // GET /sessions?end_user_id=&limit= — Three-Tier Platform Model Phase 6: a signed-in
      // product end user's own conversation list (the router allowlists this, filtered server
      // side to end_user_id — never the space-wide list for that caller). Must be matched
      // before the /sessions/:id pattern below, which would otherwise treat "?end_user_id=..."
      // as no match anyway (path has no segment), but keep the ordering explicit.
      if (method === "GET" && url.pathname === "/sessions") {
        return this.listSessions(url.searchParams);
      }
      // GET /sessions/:id
      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (method === "GET" && sessionMatch?.[1]) {
        const endUserId = url.searchParams.get("end_user_id") ?? undefined;
        return this.getSession(sessionMatch[1], endUserId);
      }
      // POST /sessions/:id/messages
      const msgMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && msgMatch?.[1]) {
        return this.appendMessage(request, msgMatch[1]);
      }
      // GET /sessions/:id/messages
      if (method === "GET" && msgMatch?.[1]) {
        return this.getMessages(msgMatch[1], url.searchParams);
      }
      // DELETE /sessions/:id/messages?from=<messageId> — truncate the transcript from that
      // message onward, so editing-and-resending REPLACES the old exchange instead of leaving
      // the original question and answer behind for the next reload to render as duplicates.
      if (method === "DELETE" && msgMatch?.[1]) {
        return this.truncateMessages(msgMatch[1], url.searchParams);
      }
      // PATCH /sessions/:id — update status
      if (method === "PATCH" && sessionMatch?.[1]) {
        return this.updateSession(request, sessionMatch[1]);
      }
      // §A1 connector default-vs-personal switch — GET/PATCH /sessions/:id/connector-mode
      const connModeMatch = url.pathname.match(
        /^\/sessions\/([^/]+)\/connector-mode$/
      );
      if (method === "GET" && connModeMatch?.[1]) {
        return this.getConnectorMode(connModeMatch[1]);
      }
      if (method === "PATCH" && connModeMatch?.[1]) {
        return await this.setConnectorMode(request, connModeMatch[1]);
      }
      // GET /sessions/:id/state — agent state
      const stateMatch = url.pathname.match(/^\/sessions\/([^/]+)\/state$/);
      if (method === "GET" && stateMatch?.[1]) {
        return this.getAgentState(stateMatch[1]);
      }
      if (method === "PUT" && stateMatch?.[1]) {
        return this.putAgentState(request, stateMatch[1]);
      }

      // POST /invalidate-user — G-F03: clear deny-cache entries for a user+space pair
      if (method === "POST" && url.pathname === "/invalidate-user") {
        return this.handleInvalidateUser(request);
      }

      const aliasMatch = url.pathname.match(/^\/internal\/connector-aliases\/([^/]+)$/);
      if (method === "GET" && aliasMatch?.[1]) {
        const resolved = this.resolveConnectorAlias(
          url.searchParams.get("space_id") ?? "",
          decodeURIComponent(aliasMatch[1]),
          url.searchParams.get("project_id") ?? undefined,
          url.searchParams.get("user_id") ?? undefined
        );
        return resolved
          ? Response.json(resolved)
          : Response.json({ error_code: "connector_alias_not_found" }, { status: 404 });
      }

      if (method === "POST" && url.pathname === "/internal/project-crons") {
        return this.registerProjectCron(await request.json());
      }
      if (url.pathname === "/internal/primary-calendar/availability" && method === "GET") {
        return this.getCalendarAvailability(url.searchParams);
      }
      if (url.pathname === "/internal/primary-calendar/bookings" && method === "POST") {
        return this.createCalendarBooking(await request.json());
      }
      const calendarBookingMatch = url.pathname.match(/^\/internal\/primary-calendar\/bookings\/([^/]+)$/);
      if (calendarBookingMatch?.[1] && method === "DELETE") {
        return this.cancelCalendarBooking(decodeURIComponent(calendarBookingMatch[1]), url.searchParams);
      }

      // GET /me/messages?user_id=xxx — G-AO30: fetch all messages for GDPR export
      if (method === "GET" && url.pathname === "/me/messages") {
        return this.getUserMessages(url.searchParams);
      }

      // DELETE /me/data?user_id=xxx — G-AO31: erase all user data within space
      if (method === "DELETE" && url.pathname === "/me/data") {
        return this.eraseUserData(url.searchParams);
      }

      // POST /me/injection — G-AO17: record an injection attempt, return rate-limited status
      if (method === "POST" && url.pathname === "/me/injection") {
        return this.recordInjectionAttempt(request);
      }

      // ── agent_definitions endpoints ───────────────────────────────────────────
      // GET /agent-definitions?space_id=
      if (method === "GET" && url.pathname === "/agent-definitions") {
        return this.listAgentDefinitions(url.searchParams);
      }
      // POST /agent-definitions
      if (method === "POST" && url.pathname === "/agent-definitions") {
        return this.createAgentDefinition(request);
      }
      // GET /agent-definitions/:id
      const agentDefGetMatch = url.pathname.match(
        /^\/agent-definitions\/([^/]+)$/
      );
      if (method === "GET" && agentDefGetMatch?.[1]) {
        return this.getAgentDefinition(agentDefGetMatch[1]);
      }
      // PATCH /agent-definitions/:id
      if (method === "PATCH" && agentDefGetMatch?.[1]) {
        return this.updateAgentDefinition(agentDefGetMatch[1], request);
      }
      // DELETE /agent-definitions/:id
      if (method === "DELETE" && agentDefGetMatch?.[1]) {
        return this.deleteAgentDefinition(agentDefGetMatch[1]);
      }

      // ── space_members endpoints ───────────────────────────────────────────────
      // GET /members?space_id=
      if (method === "GET" && url.pathname === "/members") {
        return this.listMembers(url.searchParams);
      }
      // POST /members
      if (method === "POST" && url.pathname === "/members") {
        return this.addMember(request);
      }
      // DELETE /members/:userId?space_id=... (the members proxy in workers/spaces/src/index.ts
      // always appends space_id to the forwarded query string, same as GET /members does)
      const memberMatch = url.pathname.match(/^\/members\/([^/]+)$/);
      if (method === "DELETE" && memberMatch?.[1]) {
        return this.removeMember(
          memberMatch[1],
          url.searchParams.get("space_id") ?? ""
        );
      }

      // POST /internal/events/fire — let a caller OUTSIDE this DO (e.g. the agents worker's
      // scheduled-jobs auto-disable) run an arbitrary event through the SAME event_triggers
      // matching every structural mutation (thread.created, project.created, ...) already
      // uses, so a builder can wire a no-code trigger to it exactly the same way. Internal
      // only — gated by requireInternalHmac in the forwarding route (workers/spaces/src/index.ts).
      if (method === "POST" && url.pathname === "/internal/events/fire") {
        return this.fireExternalEvent(request);
      }

      // ── space registry / hierarchy endpoints ──────────────────────────────────
      // POST /spaces — register the root space row (idempotent; provisioner calls this)
      if (method === "POST" && url.pathname === "/spaces") {
        return this.upsertRootSpace(request);
      }
      // GET /spaces — list all spaces in this product registry (root + sub-spaces)
      if (method === "GET" && url.pathname === "/spaces") {
        return this.listSpaceRows();
      }
      // POST /sub-spaces — create an in-DO sub-space (department) under a parent
      if (method === "POST" && url.pathname === "/sub-spaces") {
        return this.createSubSpaceRow(request);
      }
      if (method === "GET" && url.pathname === "/hierarchy-authorize") {
        return this.authorizeHierarchy(url.searchParams);
      }
      // GET /spaces/:id — fetch a single space row (meta)
      const spaceRowMatch = url.pathname.match(/^\/spaces\/([^/]+)$/);
      if (method === "GET" && spaceRowMatch?.[1]) {
        return this.getSpaceRow(spaceRowMatch[1]);
      }
      // PATCH /spaces/:id — update status / settings (suspend a department, etc.)
      if (method === "PATCH" && spaceRowMatch?.[1]) {
        return this.updateSpaceRow(spaceRowMatch[1], request);
      }
      const preferenceMatch = url.pathname.match(/^\/spaces\/([^/]+)\/users\/([^/]+)\/preferences$/);
      if (method === "GET" && preferenceMatch?.[1] && preferenceMatch[2]) {
        return this.getUserPreferences(preferenceMatch[1], preferenceMatch[2]);
      }
      if (method === "PUT" && preferenceMatch?.[1] && preferenceMatch[2]) {
        return this.putUserPreferences(preferenceMatch[1], preferenceMatch[2], request);
      }

      // ── projects (thread grouping) ────────────────────────────────────────────
      // GET /projects?space_id= — list projects
      if (method === "GET" && url.pathname === "/projects") {
        return this.listProjects(url.searchParams);
      }
      // POST /projects — create a project (idempotent on (space_id, name))
      if (method === "POST" && url.pathname === "/projects") {
        return this.createProject(request);
      }
      // GET /projects/:id — single project (incl. customer-bot config)
      const projectIdMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
      if (method === "GET" && projectIdMatch?.[1]) {
        return this.getProject(projectIdMatch[1], url.searchParams);
      }
      const projectModeMatch = url.pathname.match(/^\/projects\/([^/]+)\/mode$/);
      if (method === "GET" && projectModeMatch?.[1]) {
        return Response.json({ project_id: projectModeMatch[1], mode: this.getProjectMode(projectModeMatch[1]) });
      }
      const automationAccessMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/automation-access$/
      );
      if (method === "GET" && automationAccessMatch?.[1]) {
        return this.getAutomationAccess(
          automationAccessMatch[1],
          url.searchParams
        );
      }
      // PATCH /projects/:id — configure kind / execution_ceiling / channel_config / spend cap
      if (method === "PATCH" && projectIdMatch?.[1]) {
        return this.updateProject(projectIdMatch[1], request);
      }
      // ── project_members (§A1.17 Phase T1 — real per-project ACL) ───────────────
      const projectMembersMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/members$/
      );
      if (method === "GET" && projectMembersMatch?.[1]) {
        return this.listProjectMembers(projectMembersMatch[1]);
      }
      if (method === "POST" && projectMembersMatch?.[1]) {
        return this.addProjectMember(projectMembersMatch[1], request);
      }
      const projectMemberIdMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/members\/([^/]+)$/
      );
      if (
        method === "DELETE" &&
        projectMemberIdMatch?.[1] &&
        projectMemberIdMatch?.[2]
      ) {
        return this.removeProjectMember(
          projectMemberIdMatch[1],
          projectMemberIdMatch[2]
        );
      }
      // F-36: GET /projects/:id/assistant-access?user_id=U — the effective role an assistant has
      // in this project when acting on behalf of U (min of U's role and the assistant_mode clamp).
      // The agent side queries this before touching a project on a user's behalf.
      const assistantAccessMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/assistant-access$/
      );
      if (method === "GET" && assistantAccessMatch?.[1]) {
        const uid = url.searchParams.get("user_id") ?? "";
        const effective = this.resolveAssistantEffectiveRole(
          assistantAccessMatch[1],
          uid
        );
        return Response.json({
          project_id: assistantAccessMatch[1],
          user_id: uid,
          effective_role: effective,
        });
      }
      // POST /projects/:id/activate-thread — hard exclusive-mode lock (§A1.17 Phase T3)
      const activateThreadMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/activate-thread$/
      );
      if (method === "POST" && activateThreadMatch?.[1]) {
        return this.activateProjectThread(activateThreadMatch[1], request);
      }
      // ── Launchpad Wallet (kind='wallet' projects only) ─────────────────────────
      const walletBalanceMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/wallet\/balance$/
      );
      if (method === "GET" && walletBalanceMatch?.[1]) {
        return this.getWalletBalance(walletBalanceMatch[1]);
      }
      const walletCreditMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/wallet\/credit$/
      );
      if (method === "POST" && walletCreditMatch?.[1]) {
        return this.creditWallet(walletCreditMatch[1], request);
      }
      const walletDebitMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/wallet\/debit$/
      );
      if (method === "POST" && walletDebitMatch?.[1]) {
        return this.debitWallet(walletDebitMatch[1], request);
      }
      const walletHistoryMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/wallet\/history$/
      );
      if (method === "GET" && walletHistoryMatch?.[1]) {
        return this.listWalletHistory(walletHistoryMatch[1], url.searchParams);
      }
      // GET /wallet-project?space_id=... — metering enforcement follow-up: NaelaoAgentDO looks
      // this up to find the space's own wallet project (auto-provisioned at space-creation time,
      // see the provisioner's seedWallet step) before gating/debiting a project-scoped run's
      // real LLM cost against it.
      if (method === "GET" && url.pathname === "/wallet-project") {
        return this.findWalletProject(url.searchParams.get("space_id") ?? "");
      }
      // External revenue tracker (Whop-native business cut) — the revenue-tracker prebuilt
      // POSTs a period's observed gross revenue here; the billing worker reads it back to
      // compute a builder-configured cut surcharge.
      if (method === "POST" && url.pathname === "/revenue-tracking") {
        return this.recordExternalRevenue(request);
      }
      if (method === "GET" && url.pathname === "/revenue-tracking") {
        return this.getExternalRevenue(url.searchParams);
      }
      if (
        method === "POST" &&
        url.pathname === "/revenue-tracking/mark-billed"
      ) {
        return this.markRevenueBilled(request);
      }
      if (
        method === "POST" &&
        url.pathname === "/revenue-tracking/unmark-billed"
      ) {
        return this.markRevenueUnbilled(request);
      }
      if (
        method === "POST" &&
        url.pathname === "/revenue-tracking/mark-pending"
      ) {
        return this.markRevenuePending(request);
      }
      // ── project-scoped Memory OS Layers 3/4/6 (§A1.17 Phase U) ─────────────────
      const projFactsMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/memory\/facts$/
      );
      if (method === "POST" && projFactsMatch?.[1])
        return this.rememberProjectFact(projFactsMatch[1], request);
      if (method === "GET" && projFactsMatch?.[1])
        return this.recallProjectFacts(projFactsMatch[1], url.searchParams);
      const projFactIdMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/memory\/facts\/([^/]+)$/
      );
      if (method === "DELETE" && projFactIdMatch?.[1] && projFactIdMatch?.[2])
        return this.deleteProjectFact(projFactIdMatch[1], projFactIdMatch[2]);

      const projFabricBriefMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/memory\/fabric\/brief$/
      );
      if (method === "GET" && projFabricBriefMatch?.[1])
        return this.briefProjectFabric(
          projFabricBriefMatch[1],
          url.searchParams
        );
      const projFabricMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/memory\/fabric$/
      );
      if (method === "POST" && projFabricMatch?.[1])
        return this.recordProjectFabric(projFabricMatch[1], request);
      if (method === "GET" && projFabricMatch?.[1])
        return this.recallProjectFabric(projFabricMatch[1], url.searchParams);

      const projWikiConceptMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/memory\/wiki\/([^/]+)$/
      );
      if (
        method === "GET" &&
        projWikiConceptMatch?.[1] &&
        projWikiConceptMatch?.[2]
      ) {
        return this.lookupProjectWikiConcept(
          projWikiConceptMatch[1],
          decodeURIComponent(projWikiConceptMatch[2])
        );
      }
      const projWikiMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/memory\/wiki$/
      );
      if (method === "POST" && projWikiMatch?.[1])
        return this.upsertProjectWikiConcept(projWikiMatch[1], request);
      if (method === "GET" && projWikiMatch?.[1])
        return this.searchProjectWiki(projWikiMatch[1], url.searchParams);
      // ── project_rules (no-code "after customer says X" triggers) ──────────────
      const projectRulesMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/rules$/
      );
      if (method === "GET" && projectRulesMatch?.[1]) {
        return this.listProjectRules(projectRulesMatch[1]);
      }
      if (method === "POST" && projectRulesMatch?.[1]) {
        return this.createProjectRule(projectRulesMatch[1], request);
      }
      const projectRuleIdMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/rules\/([^/]+)$/
      );
      if (
        method === "DELETE" &&
        projectRuleIdMatch?.[1] &&
        projectRuleIdMatch?.[2]
      ) {
        return this.deleteProjectRule(
          projectRuleIdMatch[1],
          projectRuleIdMatch[2]
        );
      }
      // ── Authoritative per-project daily spend (F9) ─────────────────────────────
      const projectSpendMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/spend$/
      );
      if (method === "GET" && projectSpendMatch?.[1]) {
        return this.getProjectSpend(projectSpendMatch[1], url.searchParams);
      }
      if (method === "POST" && projectSpendMatch?.[1]) {
        return this.debitProjectSpend(projectSpendMatch[1], request);
      }
      // ── Builder observability surface (security audit follow-up) ──────────────
      // `await` here (not bare `return this.recordAgentActivity(...)`) deliberately, unlike most
      // handlers in this dispatcher: an async handler invoked via a bare `return` returns its
      // promise BEFORE this function's own try/catch scope has anything left to catch, so a
      // rejection from it becomes an unhandled rejection instead of the intended 500 — a
      // pre-existing bug in this dispatcher's general pattern, out of scope to fix everywhere
      // here, but easy to just not introduce in this new code.
      if (method === "POST" && url.pathname === "/agent-activity") {
        return await this.recordAgentActivity(request);
      }
      if (method === "GET" && url.pathname === "/agent-activity") {
        return this.listAgentActivity(url.searchParams);
      }
      // ── Notifications inbox ────────────────────────────────────────────────
      // Deliberately ONE path (no /notifications/undelivered sibling) — a dynamic-:spaceId route
      // with a static suffix has repeatedly corrupted this file's Hono route table for UNRELATED
      // routes elsewhere in the app (items 40/52/60's documented RegExpRouter bug); the
      // undelivered-only sweep is a query param on the same GET instead.
      if (method === "POST" && url.pathname === "/notifications") {
        return await this.createOrActOnNotification(request);
      }
      if (method === "GET" && url.pathname === "/notifications") {
        return this.listNotifications(url.searchParams);
      }
      // ── §A1 Harness Excellence Phase HX2: signals + session token-budget guard ─
      // GET /agent-signals?project_id=&window_hours= — explicit signals, computed on read from
      // the already-existing agent_activity_log (no separate ingestion).
      if (method === "GET" && url.pathname === "/agent-signals") {
        return this.computeAgentSignals(url.searchParams);
      }
      // GET /agent-diagnostics?window_hours= — the whole-business summary the Space Assistant
      // reads on a wake-up (counts, failure kinds, per-project shape, resumable stalls).
      if (method === "GET" && url.pathname === "/agent-diagnostics") {
        return this.computeAgentDiagnostics(url.searchParams);
      }
      // GET /business-analytics?window=7d|30d|90d — the end-user-facing Analytics page's data.
      // Unlike agent-activity/agent-diagnostics (builder-only: individual summaries and session
      // ids that could surface one member's escalation to another), this is PURE AGGREGATE —
      // counts, sums, and per-day/per-agent rollups with no session/thread/summary text attached
      // — so it's safe for any business member to read, not just an admin. Same "aggregate is
      // safe, raw rows aren't" precedent as /template-activity.
      if (method === "GET" && url.pathname === "/business-analytics") {
        return this.computeBusinessAnalytics(url.searchParams);
      }
      // POST /signal-events — internal only (NaelaoAgentDO posts one row per detected implicit
      // signal — user frustration / agent-forgot markers). Same await-not-bare-return rationale
      // as recordAgentActivity above.
      if (method === "POST" && url.pathname === "/signal-events") {
        return await this.recordSignalEvent(request);
      }
      if (method === "GET" && url.pathname === "/signal-events") {
        return this.listSignalEvents(url.searchParams);
      }
      // POST /session-spend — internal only: increments a session's cumulative credit tally.
      if (method === "POST" && url.pathname === "/session-spend") {
        return await this.incrementSessionSpend(request);
      }
      // GET /session-spend/:sessionId — read the current tally (zeroed default if none yet).
      const sessionSpendMatch = url.pathname.match(
        /^\/session-spend\/([^/]+)$/
      );
      if (method === "GET" && sessionSpendMatch?.[1]) {
        return this.getSessionSpend(sessionSpendMatch[1]);
      }
      // POST /session-spend/:sessionId/continue — a human approved continuing past the ceiling;
      // resets the tally so the next cycle starts fresh (see NaelaoAgentDO's gate for why a
      // reset, not an ever-growing extension, is the right model here).
      const sessionSpendContinueMatch = url.pathname.match(
        /^\/session-spend\/([^/]+)\/continue$/
      );
      if (method === "POST" && sessionSpendContinueMatch?.[1]) {
        return this.continueSessionSpend(sessionSpendContinueMatch[1]);
      }
      // POST /session-spend/:sessionId/mark-warned — idempotent single-fire flag so the 80%
      // warning event only fires once per spending cycle, not on every run past the threshold.
      const sessionSpendWarnMatch = url.pathname.match(
        /^\/session-spend\/([^/]+)\/mark-warned$/
      );
      if (method === "POST" && sessionSpendWarnMatch?.[1]) {
        return this.markSessionSpendWarned(sessionSpendWarnMatch[1]);
      }
      // ── Container Marketplace slots (§A1.17 Phase L) ───────────────────────────
      const containerSlotsMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/container-slots$/
      );
      if (method === "GET" && containerSlotsMatch?.[1]) {
        return this.listContainerSlots(containerSlotsMatch[1]);
      }
      if (method === "POST" && containerSlotsMatch?.[1]) {
        return this.createContainerSlot(containerSlotsMatch[1], request);
      }
      const containerSlotIdMatch = url.pathname.match(
        /^\/projects\/([^/]+)\/container-slots\/([^/]+)$/
      );
      if (
        method === "DELETE" &&
        containerSlotIdMatch?.[1] &&
        containerSlotIdMatch?.[2]
      ) {
        return this.deleteContainerSlot(
          containerSlotIdMatch[1],
          containerSlotIdMatch[2]
        );
      }

      // ── Local-machine-as-container permission grants (§A1.17 Phase M) ─────────
      if (method === "GET" && url.pathname === "/local-grants") {
        return this.listLocalGrants(
          url.searchParams.get("space_id") ?? "",
          url.searchParams.get("user_id") ?? undefined,
          url.searchParams.get("project_id") ?? undefined
        );
      }
      if (method === "POST" && url.pathname === "/local-grants") {
        return this.createLocalGrant(
          url.searchParams.get("space_id") ?? "",
          request
        );
      }
      const localGrantIdMatch = url.pathname.match(/^\/local-grants\/([^/]+)$/);
      if (method === "DELETE" && localGrantIdMatch?.[1]) {
        return this.deleteLocalGrant(
          url.searchParams.get("space_id") ?? "",
          localGrantIdMatch[1]
        );
      }

      // ── Presence (space collaboration, A1.8) ───────────────────────────────────
      // POST /presence — heartbeat: upsert where this user currently is (space-level if no
      // project_id/thread_id given).
      if (method === "POST" && url.pathname === "/presence") {
        return this.heartbeatPresence(request);
      }
      // GET /presence?space_id=&project_id= — members currently active (fresh heartbeat),
      // optionally scoped to one project.
      if (method === "GET" && url.pathname === "/presence") {
        return this.listPresence(url.searchParams);
      }
      if (method === "POST" && url.pathname === "/provenance") {
        return this.appendProvenanceEntry(request);
      }
      if (method === "GET" && url.pathname === "/provenance/verify") {
        return Response.json(await this.verifyProvenanceLedger());
      }
      if (method === "POST" && url.pathname === "/pull-request-cards") {
        return this.createPullRequestCard(request);
      }
      if (method === "GET" && url.pathname === "/pull-request-cards") {
        return this.listPullRequestCards(url.searchParams);
      }
      if (method === "POST" && url.pathname === "/workspace-events") {
        const body = await request.json<{ space_id?: string; project_id?: string; event?: { type?: string } }>().catch(() => ({} as { space_id?: string; project_id?: string; event?: { type?: string } }));
        if (!body.space_id || !body.project_id || body.event?.type !== "workspace.merged")
          return Response.json({ error_code: "bad_request", message: "A workspace.merged event is required" }, { status: 400 });
        await broadcastSpaceEvent(this.env, request.headers.get("x-naelao-tenant-id") ?? "", body.space_id, "workspace.merged", { project_id: body.project_id, ...body.event });
        return Response.json({ emitted: true });
      }
      if (method === "POST" && url.pathname === "/processed-webhook-events") {
        return this.claimWebhookEvent(request);
      }

      // ── Event triggers (@naelao/events) ────────────────────────────────────────
      // GET /event-triggers?space_id=&project_id=
      if (method === "GET" && url.pathname === "/event-triggers") {
        return this.listEventTriggers(url.searchParams);
      }
      if (method === "POST" && url.pathname === "/event-triggers") {
        return this.createEventTrigger(request);
      }
      const eventTriggerIdMatch = url.pathname.match(
        /^\/event-triggers\/([^/]+)$/
      );
      if (method === "DELETE" && eventTriggerIdMatch?.[1]) {
        return this.deleteEventTrigger(
          url.searchParams.get("space_id") ?? "",
          eventTriggerIdMatch[1]
        );
      }

      // ── Space Assistant approval policy ────────────────────────────────────────
      if (method === "GET" && url.pathname === "/assistant-policy") {
        return this.getAssistantPolicy(url.searchParams.get("space_id") ?? "");
      }
      if (method === "PATCH" && url.pathname === "/assistant-policy") {
        return this.updateAssistantPolicy(
          url.searchParams.get("space_id") ?? "",
          request
        );
      }

      // ── Agent API keys (§A1.17 Phase O: "the same API a human can use, attributed to the
      // agent itself") ───────────────────────────────────────────────────────────
      const agentKeysMatch = url.pathname.match(
        /^\/agents\/([^/]+)\/api-keys$/
      );
      if (method === "POST" && agentKeysMatch?.[1]) {
        return this.createAgentApiKey(agentKeysMatch[1]);
      }
      if (method === "GET" && agentKeysMatch?.[1]) {
        return this.listAgentApiKeys(agentKeysMatch[1]);
      }
      const agentKeyIdMatch = url.pathname.match(
        /^\/agents\/([^/]+)\/api-keys\/([^/]+)$/
      );
      if (method === "DELETE" && agentKeyIdMatch?.[1] && agentKeyIdMatch?.[2]) {
        return this.revokeAgentApiKey(agentKeyIdMatch[1], agentKeyIdMatch[2]);
      }
      // POST /internal/agent-keys/verify — chicken-and-egg (the caller doesn't know which
      // space's DO to ask until the key resolves), same trust model as
      // /internal/product-sessions/verify: gated by a direct platform-secret check upstream in
      // workers/spaces/src/index.ts, not requireInternalHmac.
      if (method === "POST" && url.pathname === "/internal/agent-keys/verify") {
        return this.verifyAgentApiKey(request);
      }

      // ── Per-agent approval policy override (falls back to assistant_policy when absent) ──
      const agentPolicyMatch = url.pathname.match(
        /^\/agents\/([^/]+)\/policy$/
      );
      if (method === "GET" && agentPolicyMatch?.[1]) {
        return this.getAgentPolicy(
          url.searchParams.get("space_id") ?? "",
          agentPolicyMatch[1]
        );
      }
      if (method === "PATCH" && agentPolicyMatch?.[1]) {
        return this.updateAgentPolicy(
          url.searchParams.get("space_id") ?? "",
          agentPolicyMatch[1],
          request
        );
      }

      // ── threads (spec-canonical; sub-agent/channel mirrors are ordinary subthreads) ────
      // GET /threads?space_id=&project_id=&include_sub_threads=
      if (method === "GET" && url.pathname === "/threads") {
        return this.listThreads(url.searchParams);
      }
      // POST /threads — also used (idempotently) by NaelaoAgentDO to mirror a sub-agent
      // spawn or a channel session as a browsable subthread.
      if (method === "POST" && url.pathname === "/threads") {
        return this.createThread(request);
      }
      // GET /threads/:id
      const threadIdMatch = url.pathname.match(/^\/threads\/([^/]+)$/);
      if (method === "GET" && threadIdMatch?.[1]) {
        return this.getThread(threadIdMatch[1], url.searchParams.get("viewer_id") ?? "");
      }
      // PATCH /threads/:id — rename and/or archive (there is no hard delete — see updateThread).
      if (method === "PATCH" && threadIdMatch?.[1]) {
        return this.updateThread(threadIdMatch[1], request);
      }

      // ── tasks (AVOS plan step 4 — a per-project task DAG, distinct from project_journal's
      // own loose todos) ──────────────────────────────────────────────────────────
      // GET /tasks?space_id=&project_id=&thread_id=&status=
      if (method === "GET" && url.pathname === "/tasks") {
        return this.listTasks(url.searchParams);
      }
      // POST /tasks — create ONE task (bare object body, not the plural {tasks:[...]} batch
      // shape — the tasks prebuilt creates one at a time, and a single-item batch API is a
      // needless extra layer for its only real caller).
      if (method === "POST" && url.pathname === "/tasks") {
        return this.createTask(request);
      }
      const taskLeaseMatch = url.pathname.match(/^\/tasks\/([^/]+)\/lease$/);
      if (method === "POST" && taskLeaseMatch?.[1]) {
        return this.claimTaskLease(taskLeaseMatch[1], request);
      }
      if (method === "POST" && url.pathname === "/intent-deduplicate") {
        return this.checkActiveIntentDeduplication(request);
      }
      const customModelMatch = url.pathname.match(/^\/custom-models\/(custom%2F|custom\/)([^/]+)$/i);
      if (customModelMatch) {
        const modelId = `custom/${decodeURIComponent(customModelMatch[2] ?? "")}`;
        const spaceId = url.searchParams.get("space_id") ?? "";
        if (method === "GET") {
          const manifest = queryOne<{ base_model: string; lora_adapter_id: string }>(this.ctx.storage.sql as never,
            "SELECT base_model, lora_adapter_id FROM custom_model_manifests WHERE space_id = ? AND model_id = ?", spaceId, modelId);
          return manifest
            ? Response.json({ modelId, baseModel: manifest.base_model, loraAdapterId: manifest.lora_adapter_id })
            : Response.json({ error_code: "not_found", message: "Custom model manifest not found" }, { status: 404 });
        }
        if (method === "PUT") {
          const body = await request.json<{ baseModel?: string; loraAdapterId?: string }>().catch((): { baseModel?: string; loraAdapterId?: string } => ({}));
          if (!spaceId || !body.baseModel || !body.loraAdapterId) return Response.json({ error_code: "bad_request", message: "space_id, baseModel and loraAdapterId are required" }, { status: 400 });
          execute(this.ctx.storage.sql as never,
            `INSERT INTO custom_model_manifests (model_id, space_id, base_model, lora_adapter_id) VALUES (?, ?, ?, ?)
             ON CONFLICT(space_id, model_id) DO UPDATE SET base_model=excluded.base_model, lora_adapter_id=excluded.lora_adapter_id`,
            modelId, spaceId, body.baseModel, body.loraAdapterId);
          return Response.json({ modelId, baseModel: body.baseModel, loraAdapterId: body.loraAdapterId });
        }
      }
      if (method === "POST" && url.pathname === "/rfcs") {
        return this.triggerSponsorRfc(request);
      }
      const taskIdMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
      // PATCH /tasks/:id — status/title/dependencies/assigned_agent, any subset.
      if (method === "PATCH" && taskIdMatch?.[1]) {
        return this.updateTask(taskIdMatch[1], request);
      }
      if (method === "DELETE" && taskIdMatch?.[1]) {
        return this.deleteTask(taskIdMatch[1]);
      }

      // ── cross-space access grants (spec §49 checkPermission path) ─────────────
      // POST /cross-space-grants
      if (method === "POST" && url.pathname === "/cross-space-grants") {
        return this.grantCrossSpace(request);
      }
      // GET /cross-space-grants?space_id= — grants visible to a space
      if (method === "GET" && url.pathname === "/cross-space-grants") {
        return this.listCrossSpaceGrants(url.searchParams);
      }
      // DELETE /cross-space-grants/:id
      const grantMatch = url.pathname.match(/^\/cross-space-grants\/([^/]+)$/);
      if (method === "DELETE" && grantMatch?.[1]) {
        return this.revokeCrossSpace(grantMatch[1]);
      }
      // GET /cross-space-check?user_id=&requesting_space_id=&target_space_id=&grant_type=
      if (method === "GET" && url.pathname === "/cross-space-check") {
        return this.checkCrossSpace(url.searchParams);
      }

      return Response.json(
        { error_code: "not_found", message: "Unknown DO route" },
        { status: 404 }
      );
    } catch (err) {
      console.error("SpaceDO error:", err);
      return Response.json(
        { error_code: "internal_error", message: String(err) },
        { status: 500 }
      );
    }
  }

  private async claimWebhookEvent(request: Request): Promise<Response> {
    const body = await request.json<{ spaceId?: string; provider?: string; eventType?: string; eventId?: string }>().catch(() => ({} as { spaceId?: string; provider?: string; eventType?: string; eventId?: string }));
    if (!body.spaceId || !body.provider || !body.eventType || !body.eventId) {
      return Response.json({ error_code: "bad_request", message: "spaceId, provider, eventType, and eventId are required" }, { status: 400 });
    }
    const result = await claimProcessedWebhookEvent(this.ctx.storage.sql, body as WebhookEventIdentity);
    return Response.json({ ...result, duplicate: !result.claimed });
  }

  private async createSession(request: Request): Promise<Response> {
    const body = await request.json<{
      space_id: string;
      tenant_id: string;
      end_user_id?: string;
      metadata?: Record<string, unknown>;
      /**
       * When this session is the chat transport for a structural project thread (not a bare
       * assistant/Home conversation), the caller passes the thread's own id so the two can be
       * linked via `threads.session_id` (added for exactly this purpose — see that migration's
       * own comment). Without this, a project thread's chat session was indistinguishable from an
       * ordinary top-level conversation: it showed up in the flat `listSessions` "recent
       * conversations" list as if it were one, which is what a user reported as a project thread
       * mysteriously appearing in the Sessions sidebar. `listSessions` below excludes any session
       * linked this way.
       */
      thread_id?: string;
    }>();

    // G-F03: Fast-path deny for recently banned/blocked users before touching SQLite
    if (body.end_user_id && this.isDenied(body.end_user_id, body.space_id)) {
      return Response.json(
        { error_code: "forbidden", message: "Access denied" },
        { status: 403 }
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO sessions (id, space_id, tenant_id, end_user_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      body.space_id,
      body.tenant_id,
      body.end_user_id ?? null,
      JSON.stringify(body.metadata ?? {}),
      now,
      now
    );

    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO agent_state (session_id, current_fsm_state, goal_stack, context_json, updated_at)
       VALUES (?, 'IDLE', '[]', '{}', ?)`,
      id,
      now
    );

    // Link this session to its owning thread, when it has one. `AND session_id IS NULL` makes
    // this idempotent-safe (never clobbers a link that already exists) rather than a hard
    // dependency of session creation — a thread that doesn't exist, or a race with another
    // request, must never turn a successful session-create into a failure.
    if (body.thread_id) {
      try {
        execute(
          this.ctx.storage.sql as never,
          "UPDATE threads SET session_id = ?, updated_at = ? WHERE id = ? AND session_id IS NULL",
          id,
          now,
          body.thread_id
        );
      } catch {
        /* the session itself was created successfully; the thread link is a convenience */
      }
    }

    return Response.json(
      { id, space_id: body.space_id, status: "active", created_at: now },
      { status: 201 }
    );
  }

  private getSession(sessionId: string, endUserId?: string): Response {
    const session = queryOne<SessionRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM sessions WHERE id = ?",
      sessionId
    );
    if (!session) {
      return Response.json(
        { error_code: "not_found", message: "Session not found" },
        { status: 404 }
      );
    }
    // S0.1: If end_user_id is provided (product_end_user call), verify the caller owns this session
    if (endUserId && session.end_user_id !== endUserId) {
      return Response.json(
        { error_code: "not_found", message: "Session not found" },
        { status: 404 }
      );
    }
    return Response.json(session);
  }

  // GET /sessions?end_user_id=&limit= — Three-Tier Platform Model Phase 6. When end_user_id is
  // present (the only shape the router allowlists for a product end user), the result is
  // strictly scoped to that end_user_id's own sessions — this is a signed-in end user's own
  // "recent conversations" list, never a space-wide browse (that stays /threads, builder-only).
  // A builder-JWT caller omitting end_user_id gets the space-wide recent list.
  //
  // Excludes any session already linked to a structural project thread (threads.session_id) —
  // that is a project thread's own chat transport, not a standalone assistant conversation, and
  // listing it here duplicated it: a thread created and chatted in from inside a project also
  // showed up in the flat Sessions sidebar as if it were a second, unrelated conversation.
  private listSessions(params: URLSearchParams): Response {
    const endUserId = params.get("end_user_id");
    const limit = Math.min(Math.max(Number(params.get("limit")) || 20, 1), 100);
    const notThreadLinked =
      "id NOT IN (SELECT session_id FROM threads WHERE session_id IS NOT NULL)";
    // Heartbeat/cron-wake sessions (metadata.session_kind === "heartbeat") are deliberately kept
    // out of the ordinary recents list — the only two places they're meant to surface are here
    // with ?kind=heartbeat (the Sessions page's own filter tab) and the Heartbeats sidebar tab,
    // both of which call this with that param explicitly.
    const kind = params.get("kind");
    const isHeartbeat = kind === "heartbeat";
    const kindClause = isHeartbeat
      ? "json_extract(metadata, '$.session_kind') = 'heartbeat'"
      : "(json_extract(metadata, '$.session_kind') IS NULL OR json_extract(metadata, '$.session_kind') != 'heartbeat')";
    // Reported bug: the Heartbeats panel showed real "N did work / N failed" counts (from the
    // space-wide agent_activity_log) but an empty sessions list. Root cause: a heartbeat/cron-wake
    // session is created by an INTERNAL caller (createHeartbeatSession — a tenant-scoped internal
    // token, no end-user identity), so it lands with end_user_id = NULL, owned by the SYSTEM/
    // business rather than any one person. But the panel reads as a product_end_user, whose list is
    // scoped `WHERE end_user_id = <them>` — which NULL never matches, so every heartbeat session was
    // filtered out. They are business-level system artifacts (the assistant's own wake-up work, not
    // a private per-user conversation), and reaching this SpaceDO at all already required verified
    // business membership (router hybrid-auth + product-session verify), so a heartbeat listing is
    // deliberately NOT scoped by end_user_id. Only the heartbeat branch drops the scope; ordinary
    // recents stay per-user exactly as before.
    const rows =
      endUserId && !isHeartbeat
        ? queryAll<SessionRow>(
            this.ctx.storage.sql as never,
            `SELECT * FROM sessions WHERE end_user_id = ? AND ${notThreadLinked} AND ${kindClause} ORDER BY updated_at DESC LIMIT ?`,
            endUserId,
            limit
          )
        : queryAll<SessionRow>(
            this.ctx.storage.sql as never,
            `SELECT * FROM sessions WHERE ${notThreadLinked} AND ${kindClause} ORDER BY updated_at DESC LIMIT ?`,
            limit
          );
    return Response.json({ data: rows, count: rows.length });
  }

  // G-D02: 128 KB hard cap on message content to prevent OOM in DO SQLite
  private static readonly MAX_MESSAGE_CONTENT_BYTES = 131_072;

  // G-AX13: Token bucket rate limit check for a given end_user_id (10 msg/min default)
  private checkUserRateLimit(userId: string): {
    allowed: boolean;
    retryAfterMs: number;
  } {
    const MSG_PER_MIN = 10;
    const capacity = MSG_PER_MIN;
    const ratePerSec = MSG_PER_MIN / 60;
    const nowMs = Date.now();

    interface RateLimitRow {
      tokens: number;
      last_refill_at: number;
      capacity: number;
      rate_per_sec: number;
    }

    const rows = queryAll<RateLimitRow>(
      this.ctx.storage.sql as never,
      "SELECT tokens, last_refill_at, capacity, rate_per_sec FROM user_rate_limits WHERE user_id = ?",
      userId
    );
    const row = rows[0];

    const currentTokens = row?.tokens ?? capacity;
    const lastRefill = row?.last_refill_at ?? nowMs;
    const elapsedSec = Math.max(0, (nowMs - lastRefill) / 1000);
    const refilled = Math.min(
      capacity,
      currentTokens + elapsedSec * ratePerSec
    );

    if (refilled < 1) {
      execute(
        this.ctx.storage.sql as never,
        `INSERT OR REPLACE INTO user_rate_limits (user_id, tokens, last_refill_at, capacity, rate_per_sec)
         VALUES (?, ?, ?, ?, ?)`,
        userId,
        refilled,
        nowMs,
        capacity,
        ratePerSec
      );
      return {
        allowed: false,
        retryAfterMs: Math.ceil(((1 - refilled) / ratePerSec) * 1000),
      };
    }

    execute(
      this.ctx.storage.sql as never,
      `INSERT OR REPLACE INTO user_rate_limits (user_id, tokens, last_refill_at, capacity, rate_per_sec)
       VALUES (?, ?, ?, ?, ?)`,
      userId,
      refilled - 1,
      nowMs,
      capacity,
      ratePerSec
    );
    return { allowed: true, retryAfterMs: 0 };
  }

  private async appendMessage(
    request: Request,
    sessionId: string
  ): Promise<Response> {
    const body = await request.json<{
      role: MessageRole;
      content: string;
      tool_call_id?: string;
      tool_name?: string;
      token_count?: number;
      end_user_id?: string;
      // §A1.17 Phase O: only honored for a caller reaching this route via a TRUSTED internal
      // write-back (NaelaoAgentDO.writeConversationToSession/runScriptLoop's final answer),
      // never a human — those calls carry no x-naelao-role header at all (internalHeaders()
      // only sets tenant + internal-token), so this is how they name which agent replied.
      agent_id?: string;
      // item 79: structured per-message data, same trust level as agent_id above (an internal
      // write-back only) — e.g. {consulted_threads:[{thread_id, agent_id, title}]} so the client
      // can render an inline card at the exact turn where the assistant consulted a project agent.
      metadata?: Record<string, unknown>;
      // Migration v38: caller-minted idempotency key, unique per session. Lets a retried POST
      // resolve to the message it already wrote instead of a duplicate. Client-supplied by design
      // — it identifies the caller's own send attempt and grants no authority of any kind, so
      // unlike agent_id/metadata it needs no trusted-caller check.
      client_message_id?: string;
    }>();

    // G-D02: Reject oversized messages before writing to SQLite
    const contentBytes = new TextEncoder().encode(body.content ?? "").length;
    if (contentBytes > SpaceDO.MAX_MESSAGE_CONTENT_BYTES) {
      return Response.json(
        {
          error_code: "payload_too_large",
          message: `Message content exceeds ${SpaceDO.MAX_MESSAGE_CONTENT_BYTES} byte limit`,
        },
        { status: 413 }
      );
    }

    // G-AX13: Per-user rate limiting — only for end-user "user" role messages
    if (body.role === "user" && body.end_user_id) {
      const rl = this.checkUserRateLimit(body.end_user_id);
      if (!rl.allowed) {
        return Response.json(
          {
            error_code: "rate_limited",
            message: "Too many messages — please slow down",
            retry_after_ms: rl.retryAfterMs,
          },
          { status: 429 }
        );
      }
    }

    const session = queryOne<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM sessions WHERE id = ?",
      sessionId
    );
    if (!session) {
      return Response.json(
        { error_code: "not_found", message: "Session not found" },
        { status: 404 }
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // §A1.17 Phase O: derive WHO actually authored this message from the caller's own verified
    // identity, never from a client-trustable-only field. x-naelao-role/x-naelao-user-id are set
    // by naelao-router's proxyTo from verified JWT/nak_/nps_ claims for every router-originated
    // call; a caller with no such headers (NaelaoAgentDO's own internalHeaders()) already passed
    // verifyInternalToken upstream in this same route's dispatcher, so its explicit body.agent_id
    // is trusted at the same level every other internal-only write path in this codebase is.
    const headerRole = request.headers.get("x-naelao-role");
    const headerUserId = request.headers.get("x-naelao-user-id");
    let authorType: "user" | "agent" | "assistant" | "tool" = "user";
    let authorId: string | null = null;
    if (body.role === "tool") {
      authorType = "tool";
    } else if (headerRole === "agent" && headerUserId) {
      authorType = headerUserId === "naelao-agent" ? "assistant" : "agent";
      authorId = headerUserId;
    } else if (body.agent_id) {
      authorType = body.agent_id === "naelao-agent" ? "assistant" : "agent";
      authorId = body.agent_id;
    } else if (body.role === "assistant") {
      authorType = "assistant";
      authorId = "naelao-agent";
    } else {
      authorType = "user";
      authorId = headerUserId ?? body.end_user_id ?? null;
    }

    // Migration v38 idempotency. A retried POST (the shell's apiFetch retries on a network throw
    // or a 5xx/429 — neither of which proves the server didn't already commit the row) must not
    // write a second copy. Return the message that already exists instead, so the caller sees the
    // same 2xx it would have seen had the first response reached it.
    if (body.client_message_id) {
      const existing = queryOne<{
        id: string;
        role: string;
        author_type: string;
        author_id: string | null;
        created_at: string;
      }>(
        this.ctx.storage.sql as never,
        "SELECT id, role, author_type, author_id, created_at FROM messages WHERE session_id = ? AND client_message_id = ?",
        sessionId,
        body.client_message_id
      );
      if (existing) {
        return Response.json(
          {
            id: existing.id,
            session_id: sessionId,
            role: existing.role,
            author_type: existing.author_type,
            author_id: existing.author_id,
            created_at: existing.created_at,
            deduplicated: true,
          },
          { status: 200 }
        );
      }
    }

    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_name, token_count, created_at, author_type, author_id, metadata, client_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sessionId,
      body.role,
      body.content,
      body.tool_call_id ?? null,
      body.tool_name ?? null,
      body.token_count ?? null,
      now,
      authorType,
      authorId,
      body.metadata ? JSON.stringify(body.metadata) : "{}",
      body.client_message_id ?? null
    );

    // Update session updated_at
    execute(
      this.ctx.storage.sql as never,
      "UPDATE sessions SET updated_at = ? WHERE id = ?",
      now,
      sessionId
    );

    // Migration v37: bump the project's own "recent" ordering on any thread-linked message write
    // — ordinary chat in a project thread AND consult subthreads alike, since both land here via
    // this SAME choke point (a subthread is still a real `threads` row with `project_id` set).
    // Best-effort: a session with no linked thread (Home/assistant sessions, the common case)
    // simply finds nothing and this is a no-op.
    try {
      const linkedThread = queryOne<{ project_id: string | null }>(
        this.ctx.storage.sql as never,
        "SELECT project_id FROM threads WHERE session_id = ?",
        sessionId
      );
      if (linkedThread?.project_id) {
        execute(
          this.ctx.storage.sql as never,
          "UPDATE projects SET last_activity_at = ? WHERE id = ?",
          now,
          linkedThread.project_id
        );
      }
    } catch {
      /* recency ordering is a nicety, never blocks a real message write */
    }

    return Response.json(
      {
        id,
        session_id: sessionId,
        role: body.role,
        author_type: authorType,
        author_id: authorId,
        created_at: now,
        ...(body.metadata ? { metadata: body.metadata } : {}),
      },
      { status: 201 }
    );
  }

  /**
   * Truncate a session's transcript from one message onward (that message included).
   *
   * This is what makes "edit your last message and re-ask" honest. The client used to slice its
   * OWN array and then send a fresh message, which looked right until a reload re-read the server
   * transcript and rendered the original question, the original answer, the edited question and
   * the new answer — four bubbles for what the user experienced as one correction.
   *
   * "Everything after" is resolved by SQLite's implicit `rowid` — insertion order — NOT by
   * `created_at`. Two messages CAN share a timestamp (it is a millisecond ISO string, and an
   * agent's write-back can land in the same millisecond as the message it answers), and `id` is a
   * random UUID, so the `created_at`/`id` tie-break getMessages uses for stable *display* order is
   * arbitrary as a *deletion* boundary: the assistant's reply could sort before the user message
   * being replaced and survive, leaving an answer to a question that no longer exists. `rowid` is
   * monotonic per insert and has no such tie.
   *
   * `end_user_id`, when present, is the caller's own verified id (the proxy derives it from
   * claims and never from the query string) — an end user may only truncate their own session.
   */
  private truncateMessages(
    sessionId: string,
    params: URLSearchParams
  ): Response {
    const fromId = params.get("from");
    if (!fromId) {
      return Response.json(
        {
          error_code: "invalid_request",
          message: "from (a message id) is required",
        },
        { status: 400 }
      );
    }
    const endUserId = params.get("end_user_id");

    const session = queryOne<SessionRow>(
      this.ctx.storage.sql as never,
      "SELECT end_user_id FROM sessions WHERE id = ?",
      sessionId
    );
    // Same 404-on-mismatch shape as getMessages: an end user must never be able to tell the
    // difference between "that session does not exist" and "it exists but is someone else's".
    if (!session || (endUserId && session.end_user_id !== endUserId)) {
      return Response.json(
        { error_code: "not_found", message: "Session not found" },
        { status: 404 }
      );
    }

    const anchor = queryOne<{ rid: number }>(
      this.ctx.storage.sql as never,
      "SELECT rowid AS rid FROM messages WHERE id = ? AND session_id = ?",
      fromId,
      sessionId
    );
    // Already gone (a double-submit, or a retry after a partial failure) is a no-op success, not
    // an error — the caller's intent, "these messages should not be here", already holds.
    if (!anchor) return Response.json({ deleted: 0 });

    const doomed = queryAll<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM messages WHERE session_id = ? AND rowid >= ?",
      sessionId,
      anchor.rid
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM messages WHERE session_id = ? AND rowid >= ?",
      sessionId,
      anchor.rid
    );

    return Response.json({ deleted: doomed.length });
  }

  private getMessages(sessionId: string, params: URLSearchParams): Response {
    // Agent context reads must identify the complete structural scope. This prevents a valid
    // session id from being used as a global transcript fallback for a sibling project/thread.
    const scopeSpace = params.get("scope_space_id");
    const scopeProject = params.get("scope_project_id");
    const scopeThread = params.get("scope_thread_id");
    if (scopeSpace || scopeProject || scopeThread) {
      const scoped = queryOne<{ space_id: string; project_id: string | null; thread_id: string | null }>(
        this.ctx.storage.sql as never,
        `SELECT s.space_id, t.project_id, COALESCE(t.session_id, s.id) AS thread_id
         FROM sessions s LEFT JOIN threads t ON t.session_id = s.id
         WHERE s.id = ?`,
        sessionId
      );
      if (!scoped || scoped.space_id !== scopeSpace || (scoped.project_id ?? "") !== (scopeProject ?? "") || (scoped.thread_id ?? sessionId) !== scopeThread) {
        return Response.json({ error_code: "not_found", message: "Thread transcript not found" }, { status: 404 });
      }
    }
    // Cap raised from 200 to 500 so the context-usage endpoint's own `?limit=500` is honoured
    // instead of being silently clamped: that caller sums every message's length to report "% of
    // context used", and clamping made it UNDER-report on exactly the long conversations where the
    // number matters, which in turn suppressed the auto-compaction it drives.
    const limit = Math.min(Number.parseInt(params.get("limit") ?? "50"), 500);
    const before = params.get("before");
    // `before` is a created_at timestamp, which is only millisecond-granular — several messages
    // written in the same millisecond share one value, so `created_at < before` drops every one of
    // them at once and a paging client silently loses messages. `before_id` names an exact message
    // instead and pages by its rowid (insertion order), which cannot collide. Both are accepted:
    // before_id wins when given, `before` stays supported for any caller already using it.
    const beforeId = params.get("before_id");
    const endUserId = params.get("end_user_id");

    // S0.1: If end_user_id is provided (product_end_user call), verify the caller owns this session
    // before returning its messages
    if (endUserId) {
      const session = queryOne<SessionRow>(
        this.ctx.storage.sql as never,
        "SELECT end_user_id FROM sessions WHERE id = ?",
        sessionId
      );
      if (!session || session.end_user_id !== endUserId) {
        return Response.json(
          { error_code: "not_found", message: "Session not found" },
          { status: 404 }
        );
      }
    }

    // G-D01 wanted a STABLE order when messages share a timestamp, and `id` delivered that — the
    // same input always came back the same way. But `id` is a random UUID, so stable is not the
    // same as CORRECT: two messages written in the same millisecond (a question and the answer
    // written straight back to it) came out in whichever order their UUIDs happened to sort,
    // which is how a reply could render above the question it answers. `rowid` is insertion
    // order, so it is both stable and right. `created_at` stays the primary key of the sort for
    // the `before` cursor's sake (it is a timestamp the client sends back to us); rowid only
    // replaces the arbitrary tie-break.
    // A transcript loads from the END. Both branches select DESC (newest first) so LIMIT keeps the
    // page nearest the cursor, then reverse back to chronological order for the response — the
    // client renders the same ascending array either way.
    //
    // The no-cursor branch used to be `ORDER BY created_at ASC ... LIMIT 50`, i.e. the OLDEST page.
    // Reproduced live: a 55-message session reloaded to messages 1-50 and every newer turn was
    // invisible, so the conversation could never be continued from the UI. apps/shell sends neither
    // `limit` nor `before`, so that branch is the only one any real client takes.
    // Resolve before_id to its rowid up front; an id that isn't in this session is treated as no
    // cursor at all rather than silently returning an empty page.
    const beforeRowid = beforeId
      ? queryOne<{ rid: number }>(
          this.ctx.storage.sql as never,
          "SELECT rowid AS rid FROM messages WHERE id = ? AND session_id = ?",
          beforeId,
          sessionId
        )?.rid
      : undefined;

    const rows = (
      beforeRowid !== undefined
        ? queryAll<MessageRow>(
            this.ctx.storage.sql as never,
            `SELECT * FROM messages WHERE session_id = ? AND rowid < ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            sessionId,
            beforeRowid,
            limit
          )
        : before
          ? queryAll<MessageRow>(
              this.ctx.storage.sql as never,
              `SELECT * FROM messages WHERE session_id = ? AND created_at < ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
              sessionId,
              before,
              limit
            )
          : queryAll<MessageRow>(
              this.ctx.storage.sql as never,
              `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
              sessionId,
              limit
            )
    ).reverse();

    // metadata is stored as a raw JSON string column (matching sessions.metadata's own
    // convention) — parsed here so the client never has to double-decode it. A malformed value
    // (shouldn't happen — only this route's own JSON.stringify ever writes it) degrades to {}
    // rather than breaking the whole message list.
    const data = rows.map((r) => {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(
          (r as unknown as { metadata?: string }).metadata ?? "{}"
        );
      } catch {
        /* default {} */
      }
      return { ...r, metadata };
    });

    return Response.json({ data, count: data.length });
  }

  private async updateSession(
    request: Request,
    sessionId: string
  ): Promise<Response> {
    const body = await request.json<{
      status?: string;
      metadata?: Record<string, unknown>;
    }>();
    const now = new Date().toISOString();

    if (body.status) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
        body.status,
        now,
        sessionId
      );
    }
    if (body.metadata) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(body.metadata),
        now,
        sessionId
      );
    }
    return Response.json({ id: sessionId, updated_at: now });
  }

  // §A1 connector default-vs-personal switch — {connector_id: "business"|"personal"} for a
  // session, no entry meaning "business" (today's implicit default). Read by NaelaoAgentDO once
  // per run (best-effort — a failure here means "resolve as business", never blocks a run) and
  // written by the shell's Connectors popover.
  private getConnectorMode(sessionId: string): Response {
    const rows = queryAll<{ connector_id: string; mode: string }>(
      this.ctx.storage.sql as never,
      "SELECT connector_id, mode FROM connector_account_mode WHERE session_id = ?",
      sessionId
    );
    const modes: Record<string, string> = {};
    for (const r of rows) modes[r.connector_id] = r.mode;
    return Response.json({ modes });
  }

  private async setConnectorMode(
    request: Request,
    sessionId: string
  ): Promise<Response> {
    const body = await request
      .json<{ connector_id?: string; mode?: string }>()
      .catch(() => null);
    if (
      !body?.connector_id ||
      (body.mode !== "business" && body.mode !== "personal")
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "connector_id and mode ('business'|'personal') are required",
        },
        { status: 400 }
      );
    }
    if (body.mode === "business") {
      // Business is the implicit default — delete rather than store a redundant row, so a fresh
      // read-out (getConnectorMode) and "was this ever switched" both stay simple.
      execute(
        this.ctx.storage.sql as never,
        "DELETE FROM connector_account_mode WHERE session_id = ? AND connector_id = ?",
        sessionId,
        body.connector_id
      );
      return Response.json({ ok: true, mode: "business" });
    }
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO connector_account_mode (session_id, connector_id, mode) VALUES (?, ?, 'personal')
       ON CONFLICT(session_id, connector_id) DO UPDATE SET mode = 'personal', updated_at = datetime('now')`,
      sessionId,
      body.connector_id
    );
    return Response.json({ ok: true, mode: "personal" });
  }

  private getAgentState(sessionId: string): Response {
    const state = queryOne<AgentStateRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM agent_state WHERE session_id = ?",
      sessionId
    );
    if (!state) {
      return Response.json(
        { error_code: "not_found", message: "State not found" },
        { status: 404 }
      );
    }
    return Response.json({
      session_id: state.session_id,
      current_fsm_state: state.current_fsm_state,
      goal_stack: JSON.parse(state.goal_stack) as unknown[],
      context: JSON.parse(state.context_json) as unknown,
    });
  }

  private async putAgentState(
    request: Request,
    sessionId: string
  ): Promise<Response> {
    const body = await request.json<{
      current_fsm_state?: string;
      goal_stack?: unknown[];
      context?: Record<string, unknown>;
    }>();
    const now = new Date().toISOString();

    execute(
      this.ctx.storage.sql as never,
      `UPDATE agent_state
       SET current_fsm_state = COALESCE(?, current_fsm_state),
           goal_stack = COALESCE(?, goal_stack),
           context_json = COALESCE(?, context_json),
           updated_at = ?
       WHERE session_id = ?`,
      body.current_fsm_state ?? null,
      body.goal_stack ? JSON.stringify(body.goal_stack) : null,
      body.context ? JSON.stringify(body.context) : null,
      now,
      sessionId
    );
    return Response.json({ session_id: sessionId, updated_at: now });
  }

  // G-F03: POST /invalidate-user — clear both positive and negative deny-cache entries
  private async handleInvalidateUser(request: Request): Promise<Response> {
    const body = await request.json<{ user_id: string; space_id: string }>();
    if (!body.user_id || !body.space_id) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "user_id and space_id are required",
        },
        { status: 400 }
      );
    }
    this.invalidateUserCache(body.user_id, body.space_id);
    return Response.json({ invalidated: true });
  }

  // G-F03: Block a user — add to deny cache and optionally mark in SQLite
  denyUser(userId: string, spaceId: string): void {
    this.cacheDeny(userId, spaceId);
  }

  // G-AO30: Return all messages for a given end_user_id across all sessions in this space.
  // Used by the spaces worker to build a GDPR Art. 15 data export package.
  private getUserMessages(params: URLSearchParams): Response {
    const userId = params.get("user_id");
    if (!userId) {
      return Response.json(
        { error_code: "bad_request", message: "user_id is required" },
        { status: 400 }
      );
    }

    const sessions = queryAll<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM sessions WHERE end_user_id = ?",
      userId
    );

    if (sessions.length === 0) {
      return Response.json({ messages: [], sessions: [] });
    }

    const sessionIds = sessions.map((s) => s.id);
    // Fetch all messages across all user sessions; use positional placeholders
    const placeholders = sessionIds.map(() => "?").join(",");
    const messages = queryAll<MessageRow>(
      this.ctx.storage.sql as never,
      `SELECT m.* FROM messages m WHERE m.session_id IN (${placeholders}) ORDER BY m.created_at ASC, m.id ASC`,
      ...sessionIds
    );

    return Response.json({ messages, sessions: sessionIds });
  }

  // G-AO31: Delete all sessions and messages for a given end_user_id within this space.
  // Returns counts of deleted rows for the audit trail.
  private eraseUserData(params: URLSearchParams): Response {
    const userId = params.get("user_id");
    if (!userId) {
      return Response.json(
        { error_code: "bad_request", message: "user_id is required" },
        { status: 400 }
      );
    }

    const sessions = queryAll<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM sessions WHERE end_user_id = ?",
      userId
    );

    let messagesDeleted = 0;
    let sessionsDeleted = 0;

    for (const session of sessions) {
      // Delete messages first (FK constraint)
      execute(
        this.ctx.storage.sql as never,
        "DELETE FROM messages WHERE session_id = ?",
        session.id
      );
      messagesDeleted++;

      execute(
        this.ctx.storage.sql as never,
        "DELETE FROM agent_state WHERE session_id = ?",
        session.id
      );
      execute(
        this.ctx.storage.sql as never,
        "DELETE FROM sessions WHERE id = ?",
        session.id
      );
      sessionsDeleted++;
    }

    // Also remove injection attempt records for this user
    execute(
      this.ctx.storage.sql as never,
      "DELETE FROM injection_attempts WHERE end_user_id = ?",
      userId
    );

    // F-49 (intentional — do NOT "complete" this by deleting threads): erasure removes an
    // end-user's ACCOUNT data (their sessions, messages, agent_state, injection records), NOT the
    // structural `threads` table. Threads are the builder's own space structure (linked to
    // projects, sub-agents, channels), not per-end-user account data — deleting them here would
    // corrupt the builder's workspace, not honor a user's erasure. A future refactor must not add
    // a `DELETE FROM threads` here on the assumption the erasure is "incomplete".

    const erasedAt = new Date().toISOString();
    console.log(
      `[gdpr][erasure] user=${userId} sessions=${sessionsDeleted} messages=${messagesDeleted} at=${erasedAt}`
    );

    return Response.json({
      erased: true,
      sessions_deleted: sessionsDeleted,
      messages_deleted: messagesDeleted,
      erased_at: erasedAt,
    });
  }

  // ── agent_definitions methods ────────────────────────────────────────────────

  private listAgentDefinitions(params: URLSearchParams): Response {
    const spaceId = params.get("space_id");
    interface AgentDefRow {
      id: string;
      space_id: string;
      name: string;
      description: string;
      config_json: string;
      version: number;
      enabled: number;
      created_at: string;
      updated_at: string;
    }
    const rows = spaceId
      ? queryAll<AgentDefRow>(
          this.ctx.storage.sql as never,
          "SELECT * FROM agent_definitions WHERE space_id = ? ORDER BY created_at ASC",
          spaceId
        )
      : queryAll<AgentDefRow>(
          this.ctx.storage.sql as never,
          "SELECT * FROM agent_definitions ORDER BY created_at ASC"
        );
    return Response.json({
      data: rows.map((r) => ({
        ...r,
        config: JSON.parse(r.config_json) as unknown,
      })),
    });
  }

  private async createAgentDefinition(request: Request): Promise<Response> {
    const body = await request.json<{
      id?: string;
      space_id: string;
      name: string;
      description?: string;
      config: Record<string, unknown>;
    }>();
    if (!body.space_id || !body.name || !body.config) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "space_id, name, and config are required",
        },
        { status: 400 }
      );
    }
    const id = body.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO agent_definitions (id, space_id, name, description, config_json, version, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         config_json = excluded.config_json,
         version = agent_definitions.version + 1,
         updated_at = excluded.updated_at`,
      id,
      body.space_id,
      body.name,
      body.description ?? "",
      JSON.stringify(body.config),
      now,
      now
    );
    return Response.json(
      { id, space_id: body.space_id, name: body.name, created_at: now },
      { status: 201 }
    );
  }

  private getAgentDefinition(id: string): Response {
    interface AgentDefRow {
      id: string;
      space_id: string;
      name: string;
      description: string;
      config_json: string;
      version: number;
      enabled: number;
      created_at: string;
      updated_at: string;
    }
    const row = queryOne<AgentDefRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM agent_definitions WHERE id = ?",
      id
    );
    if (!row) {
      return Response.json(
        { error_code: "not_found", message: "Agent definition not found" },
        { status: 404 }
      );
    }
    return Response.json({
      ...row,
      config: JSON.parse(row.config_json) as unknown,
    });
  }

  private async updateAgentDefinition(
    id: string,
    request: Request
  ): Promise<Response> {
    const body = await request.json<{
      name?: string;
      description?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    }>();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `UPDATE agent_definitions SET
         name        = COALESCE(?, name),
         description = COALESCE(?, description),
         config_json = COALESCE(?, config_json),
         enabled     = COALESCE(?, enabled),
         version     = version + 1,
         updated_at  = ?
       WHERE id = ?`,
      body.name ?? null,
      body.description ?? null,
      body.config ? JSON.stringify(body.config) : null,
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : null,
      now,
      id
    );
    return Response.json({ id, updated_at: now });
  }

  private deleteAgentDefinition(id: string): Response {
    execute(
      this.ctx.storage.sql as never,
      "DELETE FROM agent_definitions WHERE id = ?",
      id
    );
    return Response.json({ deleted: true, id });
  }

  // ── space_members methods ────────────────────────────────────────────────────

  private listMembers(params: URLSearchParams): Response {
    const spaceId = params.get("space_id");
    interface MemberRow {
      space_id: string;
      user_id: string;
      role: string;
      joined_at: string;
    }
    const rows = spaceId
      ? queryAll<MemberRow>(
          this.ctx.storage.sql as never,
          "SELECT * FROM space_members WHERE space_id = ? ORDER BY joined_at ASC",
          spaceId
        )
      : [];
    return Response.json({ data: rows });
  }

  private async addMember(request: Request): Promise<Response> {
    const body = await request.json<{
      space_id: string;
      user_id: string;
      role?: string;
    }>();
    if (!body.space_id || !body.user_id) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "space_id and user_id are required",
        },
        { status: 400 }
      );
    }
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(space_id, user_id) DO UPDATE SET role = excluded.role`,
      body.space_id,
      body.user_id,
      body.role ?? "member",
      now
    );
    return Response.json(
      {
        space_id: body.space_id,
        user_id: body.user_id,
        role: body.role ?? "member",
      },
      { status: 201 }
    );
  }

  private removeMember(userId: string, spaceId: string): Response {
    // G-SEC (found while tracing owner-membership, A1.16.11): this used to DELETE by user_id
    // alone. One SpaceDO can host multiple space rows (a sub-space/department registry, see
    // A1.16.9's threads/agent-definitions gating) — an unscoped delete removed a member from
    // EVERY space in that DO at once, not just the one the caller meant to remove them from.
    if (!spaceId) {
      return Response.json(
        { error_code: "bad_request", message: "space_id is required" },
        { status: 400 }
      );
    }
    execute(
      this.ctx.storage.sql as never,
      "DELETE FROM space_members WHERE space_id = ? AND user_id = ?",
      spaceId,
      userId
    );
    return Response.json({ deleted: true, space_id: spaceId, user_id: userId });
  }

  // ── Projects (thread grouping) ──────────────────────────────────────────────

  /** When both are set, default_agent_id must be one of allowed_agent_ids — a project can't
   *  default to an agent its own thread-level "switch agent" allowlist excludes. A null/empty
   *  allowed_agent_ids means unrestricted, so there's nothing to check against. */
  private static validateAgentBinding(
    defaultAgentId: string | null | undefined,
    allowedAgentIds: string[] | null | undefined
  ): string | null {
    if (
      defaultAgentId &&
      allowedAgentIds &&
      allowedAgentIds.length > 0 &&
      !allowedAgentIds.includes(defaultAgentId)
    ) {
      return `default_agent_id '${defaultAgentId}' must be included in allowed_agent_ids`;
    }
    return null;
  }

  // §A1.17 Phase T1: a 'private' project is filtered out unless the viewer is a project_member
  // or the space's own owner/admin (checkCrossSpace's existing owner-override precedent) —
  // 'public' projects (and every project, when no viewer_id is given — internal/legacy callers
  // that predate visibility) are unaffected.
  private listProjects(params: URLSearchParams): Response {
    const spaceId = params.get("space_id") ?? "";
    const viewerId = params.get("viewer_id") ?? "";
    const rows = queryAll<{
      id: string;
      space_id: string;
      name: string;
      description: string;
      status: string;
      default_agent_id: string | null;
      max_threads: number;
      allowed_agent_ids: string | null;
      visibility: string;
      created_by: string | null;
      created_at: string;
      last_activity_at: string | null;
      kind: string;
      is_singleton_kind: number;
      template_mode: TemplateMode;
      viewport_config: string;
    }>(
      this.ctx.storage.sql as never,
      // F-40: `kind` is surfaced so the frontend project-page shell can mount the natively-built
      // panel for that kind (WalletLedgerPanel etc.) via a switch at the mount point.
      //
      // ORDER BY created_at DESC (newest first) — this used to omit DESC entirely, which both
      // sorted OLDEST-first (the opposite of the "recents" ordering the Sessions list already
      // uses, ORDER BY updated_at DESC) and never actually used idx_projects_space's own
      // (space_id, created_at DESC) index, which was built expecting exactly this direction. The
      // reported symptom — a project a person just created/uses looking "lost" in the sidebar's
      // collapsed-to-a-few list (item 66) — is exactly what oldest-first ordering produces, since
      // the newest, most relevant project is the one most likely to be hidden behind "show more".
      // Migration v37 closed the gap this comment used to describe: last_activity_at (touched by
      // appendMessage on every thread-linked message write — ordinary project chat AND consult
      // subthreads alike) now takes precedence over created_at, so a project an assistant just
      // consulted an agent about really does come back to the top, not just one a human typed in.
      "SELECT id, space_id, name, description, status, default_agent_id, max_threads, allowed_agent_ids, visibility, created_by, created_at, last_activity_at, kind, is_singleton_kind, template_mode, viewport_config FROM projects WHERE space_id = ? AND status != 'archived' ORDER BY COALESCE(last_activity_at, created_at) DESC",
      spaceId
    );
    const manager = params.get("space_manager") === "1";
    const visible = rows.filter(
      (r) =>
        r.visibility === "public" ||
        manager ||
        (viewerId !== "" &&
          (this.getProjectMemberRole(r.id, viewerId) !== null ||
            this.isSpaceOwnerOrAdmin(viewerId, r.space_id)))
    );
    return Response.json({
      data: visible.map((r) => ({
        ...r,
        allowed_agent_ids: safeJsonParseAgentIds(r.allowed_agent_ids),
        viewport_config: safeJsonParseObj(r.viewport_config),
      })),
      count: visible.length,
    });
  }

  private async createProject(request: Request): Promise<Response> {
    const body = await request.json<{
      space_id: string;
      name: string;
      description?: string;
      tenant_id?: string;
      default_agent_id?: string;
      max_threads?: number;
      allowed_agent_ids?: string[];
      visibility?: "public" | "private";
      created_by?: string;
      kind?: string;
      /** Set ONLY by the spaces worker's own POST /spaces/:spaceId/projects handler, derived from
       *  the verified absence of an authenticated caller (no x-naelao-user-id) — never read from
       *  a client body field. True for the provisioner's seedWallet call and other genuinely
       *  system-initiated creates. See the role check below: defense in depth means a MISSING
       *  created_by must never itself imply privilege. */
      system_caller?: boolean;
      lifecycle?: "finite" | "continuous";
      template_mode?: TemplateMode;
      execution_ceiling?: number;
    }>();
    if (!body.space_id || !body.name) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "space_id and name are required",
        },
        { status: 400 }
      );
    }
    if (body.lifecycle !== undefined && body.lifecycle !== "finite" && body.lifecycle !== "continuous") {
      return Response.json({ error_code: "bad_request", message: "lifecycle must be 'finite' or 'continuous'" }, { status: 400 });
    }
    if (body.template_mode !== undefined && body.template_mode !== "autonomous_operator" && body.template_mode !== "autonomous_venture_os" && body.template_mode !== "cowork_studio") {
      return Response.json({ error_code: "bad_request", message: "template_mode must be 'autonomous_venture_os' or 'cowork_studio'" }, { status: 400 });
    }
    if (
      body.max_threads !== undefined &&
      (!Number.isInteger(body.max_threads) || body.max_threads < 0)
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "max_threads must be a non-negative integer",
        },
        { status: 400 }
      );
    }
    if (
      body.visibility !== undefined &&
      body.visibility !== "public" &&
      body.visibility !== "private"
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "visibility must be 'public' or 'private'",
        },
        { status: 400 }
      );
    }
    const bindingError = SpaceDO.validateAgentBinding(
      body.default_agent_id,
      body.allowed_agent_ids
    );
    if (bindingError)
      return Response.json(
        { error_code: "bad_request", message: bindingError },
        { status: 400 }
      );

    // F-33/F-35: `kind` support (default 'workspace', unchanged for existing callers). Validate
    // against the Business Feature Projects registry; role-gate feature kinds; stamp
    // is_singleton_kind so the DB partial unique index (F-32) is the real singleton guarantee.
    const kind = body.kind ?? "workspace";
    const projectKindManifest = getProjectKindManifest(kind);
    if (!isKnownProjectKind(kind) && !projectKindManifest) {
      return Response.json(
        {
          error_code: "bad_request",
          message: `Unknown project kind '${kind}'`,
        },
        { status: 400 }
      );
    }
    const requestedTier = body.execution_ceiling ?? projectKindManifest?.allowedLadderTiers.at(-1) ?? 5;
    if (!Number.isInteger(requestedTier) || requestedTier < 1 || requestedTier > 6 || (projectKindManifest && !projectKindManifest.allowedLadderTiers.includes(requestedTier))) {
      return Response.json({ error_code: "invalid_ladder_tier", message: `Tier ${requestedTier} is not allowed for '${kind}'` }, { status: 400 });
    }
    const templateMode = body.template_mode ?? projectKindManifest?.defaultAutonomy ?? "cowork_studio";
    const viewportConfig = projectKindManifest ? defaultViewportFor(projectKindManifest.kind) : { component: "WorkspaceViewport", copilotPlacement: "side_panel", canvasPrimary: true };
    const featureKind = getBusinessFeatureKind(kind);
    let isSingletonKind = 0;
    if (featureKind) {
      // Role check BEFORE the singleton check, so a non-privileged member gets "not allowed"
      // rather than leaking whether a singleton of this kind already exists. The creator's
      // space-level role is authoritative (created_by → space_members).
      //
      // Fail CLOSED on a missing created_by: it must NEVER itself imply privilege. Only the
      // explicit, server-derived system_caller marker (see the field's own doc comment above —
      // never a client-suppliable value) may create a feature-kind project without a resolvable
      // creator, matching the provisioner's seedWallet call. Any other caller with no created_by
      // is denied outright, so a future route that forwards a client body into createProject
      // without forcing created_by can never silently inherit owner-level privilege.
      if (!body.created_by) {
        if (!body.system_caller) {
          return Response.json(
            {
              error_code: "forbidden",
              message: `Creating a '${kind}' project requires a resolvable creator`,
            },
            { status: 403 }
          );
        }
      } else {
        const callerRole =
          queryOne<{ role: string }>(
            this.ctx.storage.sql as never,
            "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?",
            body.space_id,
            body.created_by
          )?.role ?? "";
        if (!roleMeetsMinimum(callerRole, featureKind.minCreationRole)) {
          return Response.json(
            {
              error_code: "forbidden",
              message: `Creating a '${kind}' project requires at least the '${featureKind.minCreationRole}' role`,
            },
            { status: 403 }
          );
        }
      }
      isSingletonKind = featureKind.singleton ? 1 : 0;
      // Pre-check for a friendlier 409 (the partial unique index is the real guarantee below).
      if (isSingletonKind) {
        const existing = queryOne<{ id: string }>(
          this.ctx.storage.sql as never,
          "SELECT id FROM projects WHERE space_id = ? AND kind = ? AND is_singleton_kind = 1 AND status = 'active'",
          body.space_id,
          kind
        );
        if (existing) {
          return Response.json(
            {
              error_code: "duplicate_singleton_project",
              message: `A '${kind}' project already exists for this space`,
              existing_project_id: existing.id,
            },
            { status: 409 }
          );
        }
      }
    }

    // Check BEFORE inserting — createProject is idempotent on (space_id, name), and
    // project.created should only fire on a genuinely NEW project, not a re-run of bootstrap.
    const alreadyExisted = !!queryOne<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM projects WHERE space_id = ? AND name = ?",
      body.space_id,
      body.name
    );
    // Space collaboration (A1.8): before creating a genuinely new project, check for a
    // likely-duplicate among the space's existing active projects (name similarity, not just
    // exact match). This is a HEADS-UP, never a block — the member's project is still created;
    // the space is informed so an admin/assistant can reconcile ("this already exists").
    let possibleDuplicates: Array<{ id: string; name: string }> = [];
    if (!alreadyExisted) {
      const activeProjects = queryAll<{ id: string; name: string }>(
        this.ctx.storage.sql as never,
        "SELECT id, name FROM projects WHERE space_id = ? AND status != 'archived'",
        body.space_id
      );
      possibleDuplicates = findPossibleDuplicateProjects(
        body.name,
        activeProjects
      );
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const allowedAgentIdsJson =
      body.allowed_agent_ids && body.allowed_agent_ids.length > 0
        ? JSON.stringify(body.allowed_agent_ids)
        : null;
    try {
      execute(
        this.ctx.storage.sql as never,
        `INSERT INTO projects (id, space_id, name, description, status, kind, is_singleton_kind, default_agent_id, max_threads, allowed_agent_ids, visibility, created_by, created_at, lifecycle, execution_ceiling, template_mode, viewport_config)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(space_id, name) DO NOTHING`,
        id,
        body.space_id,
        body.name,
        body.description ?? "",
        kind,
        isSingletonKind,
        body.default_agent_id ?? null,
        body.max_threads ?? 0,
        allowedAgentIdsJson,
        body.visibility ?? "public",
        body.created_by ?? null,
        now,
        body.lifecycle ?? "finite",
        requestedTier,
        templateMode,
        JSON.stringify(viewportConfig)
      );
    } catch (err) {
      // F-32: the partial unique index (space_id, kind) WHERE is_singleton_kind=1 fired — a
      // concurrent create raced past the pre-check above. Translate to the same 409 with the
      // winner's id so the caller gets a real constraint guarantee, not just an app-level check.
      if (
        isSingletonKind &&
        /UNIQUE|constraint/i.test((err as Error).message)
      ) {
        const existing = queryOne<{ id: string }>(
          this.ctx.storage.sql as never,
          "SELECT id FROM projects WHERE space_id = ? AND kind = ? AND is_singleton_kind = 1 AND status = 'active'",
          body.space_id,
          kind
        );
        return Response.json(
          {
            error_code: "duplicate_singleton_project",
            message: `A '${kind}' project already exists for this space`,
            existing_project_id: existing?.id,
          },
          { status: 409 }
        );
      }
      throw err;
    }
    const row = queryOne<{
      id: string;
      name: string;
      status: string;
      default_agent_id: string | null;
      max_threads: number;
      allowed_agent_ids: string | null;
      visibility: string;
      created_by: string | null;
      created_at: string;
      kind: string;
      execution_ceiling: number;
      template_mode: TemplateMode;
      viewport_config: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT id, name, status, default_agent_id, max_threads, allowed_agent_ids, visibility, created_by, created_at, kind, execution_ceiling, template_mode, viewport_config FROM projects WHERE space_id = ? AND name = ?",
      body.space_id,
      body.name
    );
    // The creator is always an implicit project_members owner — so a private project the creator
    // just made is immediately visible to them in listProjects' viewer_id filter, without a
    // separate follow-up call.
    if (!alreadyExisted && row && body.created_by) {
      execute(
        this.ctx.storage.sql as never,
        `INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)
         ON CONFLICT(project_id, user_id) DO NOTHING`,
        row.id,
        body.created_by,
        now
      );
    }
    if (!alreadyExisted && row) {
      const tenantId =
        body.tenant_id ?? request.headers.get("x-naelao-tenant-id") ?? "";
      // Awaited (not fire-and-forget) — same reasoning as mirrorThread elsewhere in this
      // build: an un-awaited promise can be abandoned mid-flight once this response is sent
      // and the DO's request context is free to tear down. fireMatchingTriggers is itself
      // best-effort/non-throwing, so this never fails project creation.
      await this.fireMatchingTriggers(
        {
          type: "project.created",
          space_id: body.space_id,
          project_id: row.id,
          occurred_at: Date.now(),
        },
        tenantId
      );
      // §A1.17 Phase V: live-sync this to any connected client — never blocks/fails project
      // creation (broadcastSpaceEvent is itself best-effort/non-throwing).
      await broadcastSpaceEvent(
        this.env,
        tenantId,
        body.space_id,
        "project.created",
        { project_id: row.id, name: row.name }
      );
      if (possibleDuplicates.length > 0) {
        // A builder can wire this event to a no-code trigger (e.g. a notifications script) to
        // actually broadcast the heads-up to the space's admin/assistant — the dedup detection
        // itself never assumes a specific notification channel.
        await this.fireMatchingTriggers(
          {
            type: "project.possible_duplicate",
            space_id: body.space_id,
            project_id: row.id,
            occurred_at: Date.now(),
            payload: {
              new_project_name: row.name,
              candidates: possibleDuplicates,
            },
          },
          tenantId
        );
      }
    }
    const responseRow = row
      ? {
          ...row,
          allowed_agent_ids: safeJsonParseAgentIds(row.allowed_agent_ids),
          viewport_config: safeJsonParseObj(row.viewport_config),
        }
      : {
          id,
          name: body.name,
          status: "active",
          default_agent_id: body.default_agent_id ?? null,
          max_threads: body.max_threads ?? 0,
          allowed_agent_ids: body.allowed_agent_ids ?? null,
          created_at: now,
          kind,
          execution_ceiling: requestedTier,
          template_mode: templateMode,
          viewport_config: viewportConfig,
        };
    return Response.json(
      // `created` distinguishes a genuine insert from the `ON CONFLICT(space_id, name) DO NOTHING`
      // no-op on a name collision — this endpoint always returned 201 either way, with no field a
      // caller could use to tell them apart. Real, previously-documented-but-unfixed bug: a
      // template's bootstrap (seedTemplateProjects) runs both at provision time AND again when an
      // end user finishes the onboarding wizard (bootstrap/complete) — the second pass's project
      // "creates" all silently succeeded as no-ops, and since `res.ok` was true either way, the
      // caller had no way to skip re-seeding a starter thread for each one, producing exactly two
      // starter threads per templated project. `created` is what closes that for real.
      {
        ...responseRow,
        possible_duplicates: possibleDuplicates,
        created: !alreadyExisted,
      },
      { status: 201 }
    );
  }

  // ── Presence (space collaboration, A1.8) ────────────────────────────────────
  // Heartbeat-based, not WebSocket-based: a client calls /presence periodically while a member
  // has a project/thread open; listPresence filters by a freshness window so a closed tab or
  // crashed client just ages out rather than appearing present forever.
  private async heartbeatPresence(request: Request): Promise<Response> {
    const body = await request.json<{
      space_id: string;
      user_id: string;
      project_id?: string;
      thread_id?: string;
      file_path?: string;
      cursor_line?: number;
      cursor_col?: number;
      tenant_id?: string;
    }>();
    if (!body.space_id || !body.user_id) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "space_id and user_id are required",
        },
        { status: 400 }
      );
    }
    const now = Date.now();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO presence (space_id, user_id, project_id, thread_id, last_seen_at, file_path, cursor_line, cursor_col) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(space_id, user_id) DO UPDATE SET project_id = excluded.project_id, thread_id = excluded.thread_id,
       last_seen_at = excluded.last_seen_at, file_path = excluded.file_path,
       cursor_line = excluded.cursor_line, cursor_col = excluded.cursor_col`,
      body.space_id,
      body.user_id,
      body.project_id ?? null,
      body.thread_id ?? null,
      now,
      body.file_path ?? null,
      Number.isInteger(body.cursor_line) ? body.cursor_line! : null,
      Number.isInteger(body.cursor_col) ? body.cursor_col! : null
    );
    // §A1.17 Phase V: live-sync presence too — online/offline transitions appear live instead of
    // only on the next GET /presence poll. Best-effort, never blocks the heartbeat response.
    await broadcastSpaceEvent(
      this.env,
      body.tenant_id ?? "",
      body.space_id,
      "presence.update",
      {
        user_id: body.user_id,
        project_id: body.project_id ?? null,
        thread_id: body.thread_id ?? null,
        file_path: body.file_path ?? null,
        cursor_line: body.cursor_line ?? null,
        cursor_col: body.cursor_col ?? null,
      }
    );
    // Opportunistic prune: presence's PK is (space_id, user_id), so a row only ever grows the
    // table when a NEW user heartbeats for the first time — but that row then lives forever
    // (isPresenceFresh only filters GET /presence, it never deletes). A space with high churn
    // (departed team members, one-time invitees) would accumulate a stale row per historical
    // user indefinitely. No alarm/cron needed for this: every heartbeat opportunistically
    // sweeps its own space's rows older than 24h — far past isPresenceFresh's ~90s window, so
    // this only removes rows that were never going to show as "active" again anyway.
    execute(
      this.ctx.storage.sql as never,
      "DELETE FROM presence WHERE space_id = ? AND last_seen_at < ?",
      body.space_id,
      now - 60_000
    );
    return Response.json({ ok: true, last_seen_at: now });
  }

  private listPresence(params: URLSearchParams): Response {
    const spaceId = params.get("space_id") ?? "";
    const projectId = params.get("project_id");
    const rows = projectId
      ? queryAll<{
          user_id: string;
          project_id: string | null;
          thread_id: string | null;
          last_seen_at: number; file_path: string | null; cursor_line: number | null; cursor_col: number | null;
        }>(
          this.ctx.storage.sql as never,
          "SELECT user_id, project_id, thread_id, last_seen_at, file_path, cursor_line, cursor_col FROM presence WHERE space_id = ? AND project_id = ?",
          spaceId,
          projectId
        )
      : queryAll<{
          user_id: string;
          project_id: string | null;
          thread_id: string | null;
          last_seen_at: number; file_path: string | null; cursor_line: number | null; cursor_col: number | null;
        }>(
          this.ctx.storage.sql as never,
          "SELECT user_id, project_id, thread_id, last_seen_at, file_path, cursor_line, cursor_col FROM presence WHERE space_id = ?",
          spaceId
        );
    const now = Date.now();
    const active = rows.filter((r) => r.last_seen_at >= now - 60_000);
    return Response.json({
      data: active,
      count: active.length,
      freshness_window_ms: 60_000,
    });
  }

  /** Append under the DO's single-writer input gate. The timestamp is stored verbatim and is part
   * of the authenticated message, making alteration, deletion, or reordering detectable. */
  async appendProvenanceEntry(request: Request): Promise<Response> {
    const entry = await request.json<{
      human_trigger_id?: string; assistant_actor_id?: string; project_executor_id?: string;
      git_commit_oid?: string; task_id?: string; created_at?: string;
    }>();
    if (!entry.human_trigger_id || !entry.assistant_actor_id || !entry.project_executor_id ||
        !entry.git_commit_oid || !/^[a-f0-9]{40,64}$/i.test(entry.git_commit_oid)) {
      return Response.json({ error: "valid actor ids and git_commit_oid are required" }, { status: 400 });
    }
    const createdAt = entry.created_at ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(createdAt))) return Response.json({ error: "invalid created_at" }, { status: 400 });
    const latest = queryOne<{ entry_hash: string }>(this.ctx.storage.sql as never,
      "SELECT entry_hash FROM provenance_ledger ORDER BY rowid DESC LIMIT 1");
    const prevHash = latest?.entry_hash ?? PROVENANCE_GENESIS_HASH;
    const entryHash = await provenanceHmac(this.env.PLATFORM_SECRET, [prevHash, entry.human_trigger_id,
      entry.assistant_actor_id, entry.project_executor_id, entry.git_commit_oid, createdAt]);
    execute(this.ctx.storage.sql as never,
      `INSERT INTO provenance_ledger (entry_hash, prev_hash, human_trigger_id, assistant_actor_id,
       project_executor_id, git_commit_oid, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      entryHash, prevHash, entry.human_trigger_id, entry.assistant_actor_id, entry.project_executor_id,
      entry.git_commit_oid, entry.task_id ?? null, createdAt);
    return Response.json({ ...entry, task_id: entry.task_id ?? null, created_at: createdAt,
      prev_hash: prevHash, entry_hash: entryHash }, { status: 201 });
  }

  async verifyProvenanceLedger(): Promise<{ valid: boolean; entries: number; invalid_entry_hash?: string }> {
    const rows = queryAll<{ entry_hash: string; prev_hash: string; human_trigger_id: string;
      assistant_actor_id: string; project_executor_id: string; git_commit_oid: string; created_at: string }>(
      this.ctx.storage.sql as never, "SELECT * FROM provenance_ledger ORDER BY rowid ASC");
    let previous = PROVENANCE_GENESIS_HASH;
    for (const row of rows) {
      const expected = await provenanceHmac(this.env.PLATFORM_SECRET, [previous, row.human_trigger_id,
        row.assistant_actor_id, row.project_executor_id, row.git_commit_oid, row.created_at]);
      if (row.prev_hash !== previous || row.entry_hash !== expected) {
        return { valid: false, entries: rows.length, invalid_entry_hash: row.entry_hash };
      }
      previous = row.entry_hash;
    }
    return { valid: true, entries: rows.length };
  }

  // ── Customer-bot project config (no-code, admin-configured) ─────────────────
  private getProject(projectId: string, params?: URLSearchParams): Response {
    const row = queryOne<{
      id: string;
      space_id: string;
      name: string;
      description: string;
      status: string;
      kind: string;
      execution_ceiling: number;
      daily_spend_cap_credits: number;
      channel_config: string;
      default_agent_id: string | null;
      max_threads: number;
      allowed_agent_ids: string | null;
      visibility: string;
      created_by: string | null;
      created_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM projects WHERE id = ?",
      projectId
    );
    if (!row)
      return Response.json(
        { error_code: "not_found", message: "Project not found" },
        { status: 404 }
      );
    // Internal mutation paths call this without params to serialize the row they just changed;
    // all externally routed reads supply a server-derived viewer_id.
    const viewerId = params?.get("viewer_id") ?? "";
    const isSpaceManager = params?.get("space_manager") === "1";
    if (
      params !== undefined &&
      row.visibility === "private" &&
      !isSpaceManager &&
      (!viewerId ||
        (this.getProjectMemberRole(projectId, viewerId) === null &&
          !this.isSpaceOwnerOrAdmin(viewerId, row.space_id)))
    ) {
      // Deliberately identical to a missing id: callers cannot use status, body, or wording as
      // an existence oracle for confidential workstations.
      return Response.json(
        { error_code: "not_found", message: "Project not found" },
        { status: 404 }
      );
    }
    return Response.json({
      ...row,
      channel_config: safeJsonParseObj(row.channel_config),
      allowed_agent_ids: safeJsonParseAgentIds(row.allowed_agent_ids),
    });
  }

  private getAutomationAccess(
    projectId: string,
    params: URLSearchParams
  ): Response {
    const spaceId = params.get("space_id") ?? "";
    const userId = params.get("user_id") ?? "";
    const project = queryOne<{ space_id: string; status: string }>(
      this.ctx.storage.sql as never,
      "SELECT space_id, status FROM projects WHERE id = ?",
      projectId
    );
    if (
      !project ||
      project.space_id !== spaceId ||
      project.status !== "active"
    ) {
      return Response.json(
        { error_code: "not_found", message: "Project not found in this space" },
        { status: 404 }
      );
    }
    const role = this.getProjectMemberRole(projectId, userId);
    const allowed =
      params.get("space_manager") === "1" ||
      this.isSpaceOwnerOrAdmin(userId, project.space_id) ||
      role === "owner" ||
      role === "editor";
    if (!allowed)
      return Response.json(
        {
          error_code: "forbidden",
          message: "Caller cannot manage this project",
        },
        { status: 403 }
      );
    return Response.json({
      project_id: projectId,
      space_id: spaceId,
      can_manage: true,
    });
  }

  private async updateProject(
    projectId: string,
    request: Request
  ): Promise<Response> {
    const body = await request
      .json<{
        kind?: "workspace" | "customer_bot" | "wallet";
        execution_ceiling?: number;
        daily_spend_cap_credits?: number;
        channel_config?: Record<string, unknown>;
        name?: string;
        description?: string;
        show_sub_threads?: boolean;
        status?: "active" | "archived";
        /** Which agent runs here by default (template-seeded or admin-assigned). null clears it —
         *  a project is never permanently bound to one agent; the builder/Space Assistant can
         *  always reassign or unset it. */
        default_agent_id?: string | null;
        /** 0/omitted = unlimited. Caps "real" conversations (primary threads + channel
         *  sessions) — never counts ephemeral sub-agent fan-out threads. */
        max_threads?: number;
        /** The thread-level "switch agent" allowlist. null/[] clears it (unrestricted — any
         *  space agent). When set, default_agent_id (existing or in this same PATCH) must be
         *  a member. */
        allowed_agent_ids?: string[] | null;
        /** §A1.17 Phase T1: 'private' (default) is visible only to project_members + the space's
         *  own owner/admin; 'public' is visible to every space member. */
        visibility?: "public" | "private";
        /** §A1.17 Phase T3: opts a project into the hard single-active-thread lock. */
        exclusive_mode?: boolean;
        /** Sole human on-call recipient for project failures. null falls back to lead assistant. */
        lead_user_id?: string | null;
        lifecycle?: "finite" | "continuous";
      }>()
      .catch(() => ({}) as Record<string, never>);

    const existing = queryOne<{
      id: string;
      space_id: string;
      default_agent_id: string | null;
      allowed_agent_ids: string | null;
    }>(
      this.ctx.storage.sql as never,
      "SELECT id, space_id, default_agent_id, allowed_agent_ids FROM projects WHERE id = ?",
      projectId
    );
    if (!existing)
      return Response.json(
        { error_code: "not_found", message: "Project not found" },
        { status: 404 }
      );

    if (
      body.max_threads !== undefined &&
      (!Number.isInteger(body.max_threads) || body.max_threads < 0)
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "max_threads must be a non-negative integer",
        },
        { status: 400 }
      );
    }
    // Cross-validate against the EFFECTIVE post-patch state, not just what's in this one PATCH
    // body — a caller might only send default_agent_id while allowed_agent_ids stays as
    // whatever's already stored (or vice versa).
    const effectiveDefaultAgentId =
      body.default_agent_id !== undefined
        ? body.default_agent_id
        : existing.default_agent_id;
    const effectiveAllowedAgentIds =
      body.allowed_agent_ids !== undefined
        ? body.allowed_agent_ids
        : safeJsonParseAgentIds(existing.allowed_agent_ids);
    const bindingError = SpaceDO.validateAgentBinding(
      effectiveDefaultAgentId,
      effectiveAllowedAgentIds
    );
    if (bindingError)
      return Response.json(
        { error_code: "bad_request", message: bindingError },
        { status: 400 }
      );

    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "archived") {
        return Response.json(
          {
            error_code: "bad_request",
            message: "status must be 'active' or 'archived'",
          },
          { status: 400 }
        );
      }
      // Archiving removes a project from listProjects and from dedup candidates (both filter
      // on status != 'archived') without deleting its threads/history.
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET status = ? WHERE id = ?",
        body.status,
        projectId
      );
    }
    if (body.lead_user_id !== undefined) {
      execute(this.ctx.storage.sql as never, "UPDATE projects SET lead_user_id = ? WHERE id = ?", body.lead_user_id?.trim() || null, projectId);
    }
    if (body.lifecycle !== undefined) {
      if (body.lifecycle !== "finite" && body.lifecycle !== "continuous") {
        return Response.json({ error_code: "bad_request", message: "lifecycle must be 'finite' or 'continuous'" }, { status: 400 });
      }
      execute(this.ctx.storage.sql as never, "UPDATE projects SET lifecycle = ? WHERE id = ?", body.lifecycle, projectId);
    }
    if (body.kind !== undefined) {
      // F-33: validate against the registry (not a hardcoded set) and stamp is_singleton_kind so
      // the singleton index applies even when kind is set via PATCH (the legacy seedWallet path).
      if (!isKnownProjectKind(body.kind)) {
        return Response.json(
          {
            error_code: "bad_request",
            message: `Unknown project kind '${body.kind}'`,
          },
          { status: 400 }
        );
      }
      const fk = getBusinessFeatureKind(body.kind);
      const singleton = fk?.singleton ? 1 : 0;
      if (singleton) {
        const dup = queryOne<{ id: string }>(
          this.ctx.storage.sql as never,
          "SELECT id FROM projects WHERE space_id = ? AND kind = ? AND is_singleton_kind = 1 AND status = 'active' AND id != ?",
          existing.space_id,
          body.kind,
          projectId
        );
        if (dup) {
          return Response.json(
            {
              error_code: "duplicate_singleton_project",
              message: `A '${body.kind}' project already exists for this space`,
              existing_project_id: dup.id,
            },
            { status: 409 }
          );
        }
      }
      try {
        execute(
          this.ctx.storage.sql as never,
          "UPDATE projects SET kind = ?, is_singleton_kind = ? WHERE id = ?",
          body.kind,
          singleton,
          projectId
        );
      } catch (err) {
        if (singleton && /UNIQUE|constraint/i.test((err as Error).message)) {
          const dup = queryOne<{ id: string }>(
            this.ctx.storage.sql as never,
            "SELECT id FROM projects WHERE space_id = ? AND kind = ? AND is_singleton_kind = 1 AND status = 'active' AND id != ?",
            existing.space_id,
            body.kind,
            projectId
          );
          return Response.json(
            {
              error_code: "duplicate_singleton_project",
              message: `A '${body.kind}' project already exists for this space`,
              existing_project_id: dup?.id,
            },
            { status: 409 }
          );
        }
        throw err;
      }
    }
    if (body.execution_ceiling !== undefined) {
      if (
        !Number.isInteger(body.execution_ceiling) ||
        body.execution_ceiling < 1 ||
        body.execution_ceiling > 6
      ) {
        return Response.json(
          {
            error_code: "bad_request",
            message: "execution_ceiling must be an integer 1-6",
          },
          { status: 400 }
        );
      }
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET execution_ceiling = ? WHERE id = ?",
        body.execution_ceiling,
        projectId
      );
    }
    if (body.daily_spend_cap_credits !== undefined) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET daily_spend_cap_credits = ? WHERE id = ?",
        Math.max(0, body.daily_spend_cap_credits),
        projectId
      );
    }
    if (body.channel_config !== undefined) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET channel_config = ? WHERE id = ?",
        JSON.stringify(body.channel_config),
        projectId
      );
    }
    if (body.name !== undefined) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET name = ? WHERE id = ?",
        body.name,
        projectId
      );
    }
    if (body.description !== undefined) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET description = ? WHERE id = ?",
        body.description,
        projectId
      );
    }
    if (body.show_sub_threads !== undefined) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET show_sub_threads = ? WHERE id = ?",
        body.show_sub_threads ? 1 : 0,
        projectId
      );
    }
    if (body.default_agent_id !== undefined) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET default_agent_id = ? WHERE id = ?",
        body.default_agent_id,
        projectId
      );
    }
    if (body.max_threads !== undefined) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET max_threads = ? WHERE id = ?",
        body.max_threads,
        projectId
      );
    }
    if (body.allowed_agent_ids !== undefined) {
      const json =
        body.allowed_agent_ids && body.allowed_agent_ids.length > 0
          ? JSON.stringify(body.allowed_agent_ids)
          : null;
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET allowed_agent_ids = ? WHERE id = ?",
        json,
        projectId
      );
    }
    if (body.visibility !== undefined) {
      if (body.visibility !== "public" && body.visibility !== "private") {
        return Response.json(
          {
            error_code: "bad_request",
            message: "visibility must be 'public' or 'private'",
          },
          { status: 400 }
        );
      }
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET visibility = ? WHERE id = ?",
        body.visibility,
        projectId
      );
    }
    if (body.exclusive_mode !== undefined) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET exclusive_mode = ? WHERE id = ?",
        body.exclusive_mode ? 1 : 0,
        projectId
      );
    }
    // §A1.17 Phase V: live-sync — best-effort, never blocks the PATCH response. tenant_id rides
    // the query string (see the spaces-worker route's comment for why not a header/body field).
    const patchTenantId =
      new URL(request.url).searchParams.get("tenant_id") ?? "";
    await broadcastSpaceEvent(
      this.env,
      patchTenantId,
      existing.space_id,
      "project.updated",
      { project_id: projectId }
    );
    return this.getProject(projectId);
  }

  private isSpaceOwnerOrAdmin(userId: string, spaceId?: string): boolean {
    if (!userId) return false;
    const row = queryOne<{ role: string }>(
      this.ctx.storage.sql as never,
      spaceId
        ? "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?"
        : "SELECT role FROM space_members WHERE user_id = ?",
      ...(spaceId ? [spaceId, userId] : [userId])
    );
    if (row?.role === "owner" || row?.role === "admin") return true;
    if (!spaceId) return false;
    const child = queryOne<{ parent_id: string | null; depth: number }>(
      this.ctx.storage.sql as never,
      "SELECT parent_id, depth FROM spaces WHERE id = ? AND status = 'active'",
      spaceId
    );
    if (child?.depth !== 1 || !child.parent_id) return false;
    const inherited = queryOne<{ role: string }>(
      this.ctx.storage.sql as never,
      "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?",
      child.parent_id,
      userId
    );
    return inherited?.role === "owner" || inherited?.role === "admin";
  }

  // §A1.17 Phase T1: real per-project membership ACL — a routing/authorization table, not just a
  // "who's active" list (that's `presence`). Role gates member management itself: owner/editor
  // can add/remove, viewer cannot (enforced by the caller passing `actingRole`, resolved from
  // this SAME table one level up, mirroring how `requireBusinessMembership` resolves a role
  // before checking it against a per-route minimum).
  private listProjectMembers(projectId: string): Response {
    const rows = queryAll<{
      project_id: string;
      user_id: string;
      role: string;
      added_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM project_members WHERE project_id = ? ORDER BY added_at",
      projectId
    );
    return Response.json({ data: rows, count: rows.length });
  }

  private getProjectMemberRole(
    projectId: string,
    userId: string
  ): "owner" | "editor" | "viewer" | null {
    if (!userId) return null;
    const row = queryOne<{ role: string }>(
      this.ctx.storage.sql as never,
      "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
      projectId,
      userId
    );
    return (row?.role as "owner" | "editor" | "viewer" | undefined) ?? null;
  }

  private async addProjectMember(
    projectId: string,
    request: Request
  ): Promise<Response> {
    const body = await request
      .json<{ user_id?: string; role?: string; assistant_mode?: string; tenant_id?: string }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.user_id)
      return Response.json(
        { error_code: "bad_request", message: "user_id is required" },
        { status: 400 }
      );
    const role = body.role ?? "viewer";
    if (!["owner", "editor", "viewer"].includes(role)) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "role must be one of owner, editor, viewer",
        },
        { status: 400 }
      );
    }
    // F-36: per (project, user) clamp on what an assistant acting ON BEHALF OF this user may do.
    const assistantMode = body.assistant_mode ?? "inherit";
    if (!["inherit", "read_only", "none"].includes(assistantMode)) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "assistant_mode must be one of inherit, read_only, none",
        },
        { status: 400 }
      );
    }
    const project = queryOne<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM projects WHERE id = ?",
      projectId
    );
    if (!project)
      return Response.json(
        { error_code: "not_found", message: "Project not found" },
        { status: 404 }
      );
    const beforeMode = this.getProjectMode(projectId);
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO project_members (project_id, user_id, role, assistant_mode, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, assistant_mode = excluded.assistant_mode`,
      projectId,
      body.user_id,
      role,
      assistantMode,
      new Date().toISOString()
    );
    const mode = this.getProjectMode(projectId);
    if (mode !== beforeMode) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE projects SET mode = ? WHERE id = ?",
        mode,
        projectId
      );
      if (mode === "multiplayer_office") {
        const projectRow = queryOne<{ space_id: string }>(
          this.ctx.storage.sql as never,
          "SELECT space_id FROM projects WHERE id = ?",
          projectId
        );
        const tenantId = body.tenant_id ?? request.headers.get("x-naelao-tenant-id") ?? "";
        if (projectRow) {
          await broadcastSpaceEvent(this.env, tenantId, projectRow.space_id, "project.promoted_to_multiplayer", {
            project_id: projectId,
            mode,
            member_count: 2,
          });
        }
      }
    }
    return Response.json(
      {
        project_id: projectId,
        user_id: body.user_id,
        role,
        assistant_mode: assistantMode,
        mode,
      },
      { status: 201 }
    );
  }

  /** Resolve from live membership so promotion is correct even for legacy/imported rows. */
  private getProjectMode(projectId: string): "solo_cockpit" | "multiplayer_office" {
    const row = queryOne<{ count: number }>(
      this.ctx.storage.sql as never,
      "SELECT COUNT(*) AS count FROM project_members WHERE project_id = ?",
      projectId
    );
    return (row?.count ?? 0) <= 1 ? "solo_cockpit" : "multiplayer_office";
  }

  /**
   * F-36 — the whole security model, one place: the effective role an assistant has in a project
   * when acting ON BEHALF OF user U. INVARIANT: never MORE than U's own project_members role.
   *   - 'inherit' (default): assistant's effective role = U's role.
   *   - 'read_only': clamps to 'viewer' even if U is owner/editor.
   *   - 'none': null (zero access — the assistant won't touch this project for U; U must use it directly).
   * When there is NO acting user (cron / trigger / autonomous heartbeat — no human in the loop),
   * callers pass userId="" and this returns null; the dispatch path then falls back to the
   * assistant's own base grant (documented at the enforcement point), NOT this per-user clamp.
   */
  private resolveAssistantEffectiveRole(
    projectId: string,
    userId: string
  ): "owner" | "editor" | "viewer" | null {
    if (!userId) return null; // no acting user — not this clamp's job (see doc above)
    const row = queryOne<{ role: string; assistant_mode: string }>(
      this.ctx.storage.sql as never,
      "SELECT role, assistant_mode FROM project_members WHERE project_id = ? AND user_id = ?",
      projectId,
      userId
    );
    if (!row) {
      // U isn't a member — but the space owner/admin has implicit access, and an assistant acting
      // for them inherits it (mode can't clamp what isn't a project_members row; a builder wanting
      // to clamp must add an explicit row). Fail closed for a plain non-member.
      return this.isSpaceOwnerOrAdmin(userId) ? "owner" : null;
    }
    if (row.assistant_mode === "none") return null;
    if (row.assistant_mode === "read_only") return "viewer";
    return row.role as "owner" | "editor" | "viewer";
  }

  private removeProjectMember(projectId: string, userId: string): Response {
    execute(
      this.ctx.storage.sql as never,
      "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
      projectId,
      userId
    );
    return Response.json({ removed: true });
  }

  // §A1.17 Phase T3: hybrid thread locking, hard half. Soft locking (the default) is just the
  // existing `lock` prebuilt used by scripts that mutate shared project state — no engine change
  // needed here. This endpoint is the opt-in hard "exclusive mode": a client acquires the lock
  // when a user opens/focuses a thread (not on every message — see the migration-v23 comment for
  // why message-level enforcement isn't wired), and a DIFFERENT thread trying to activate while
  // one is already active gets a 409 with who holds it, never a silent block — `take_over`
  // reassigns explicitly so this can never deadlock a project.
  private async activateProjectThread(
    projectId: string,
    request: Request
  ): Promise<Response> {
    const body = await request
      .json<{
        thread_id?: string;
        user_id?: string;
        take_over?: boolean;
        tenant_id?: string;
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.thread_id)
      return Response.json(
        { error_code: "bad_request", message: "thread_id is required" },
        { status: 400 }
      );
    const project = queryOne<{
      id: string;
      space_id: string;
      exclusive_mode: number;
      active_thread_id: string | null;
      active_thread_since: string | null;
    }>(
      this.ctx.storage.sql as never,
      "SELECT id, space_id, exclusive_mode, active_thread_id, active_thread_since FROM projects WHERE id = ?",
      projectId
    );
    if (!project)
      return Response.json(
        { error_code: "not_found", message: "Project not found" },
        { status: 404 }
      );

    if (!project.exclusive_mode) {
      return Response.json({
        exclusive_mode: false,
        activated: true,
        thread_id: body.thread_id,
      });
    }
    if (
      project.active_thread_id &&
      project.active_thread_id !== body.thread_id &&
      !body.take_over
    ) {
      return Response.json(
        {
          error_code: "thread_locked",
          active_thread_id: project.active_thread_id,
          active_since: project.active_thread_since,
        },
        { status: 409 }
      );
    }
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      "UPDATE projects SET active_thread_id = ?, active_thread_since = ? WHERE id = ?",
      body.thread_id,
      now,
      projectId
    );
    // §A1.17 Phase V: live-sync the lock transition — a collaborator viewing this project sees
    // who just took it over without polling. Best-effort, never blocks the activation response.
    await broadcastSpaceEvent(
      this.env,
      body.tenant_id ?? "",
      project.space_id,
      "thread.activated",
      {
        project_id: projectId,
        thread_id: body.thread_id,
        user_id: body.user_id ?? null,
      }
    );
    return Response.json({
      exclusive_mode: true,
      activated: true,
      thread_id: body.thread_id,
      active_since: now,
    });
  }

  // ── Memory OS project-shared layers (§A1.17 Phase U) ────────────────────────
  // Layers 3 (facts)/4 (fabric)/6 (wiki), promoted here so every agent thread bound to the SAME
  // project shares them — Layer 5 (episodic/semantic) deliberately stays per-(thread,agentId) in
  // NaelaoAgentDO's own memory-os.ts tables, untouched. Mirrors memory-os.ts's own SQL shape and
  // merge logic (LIKE-based text match, trust-score refresh on remember, relevance scoring for
  // fabric) but scoped by project_id instead of user_id — the agents-worker side composes this
  // with the local per-agent store via a hybrid MemoryStore (project-memory-client.ts).

  private async rememberProjectFact(
    projectId: string,
    request: Request
  ): Promise<Response> {
    const body = await request
      .json<{ entity?: string; relation?: string; attribute?: string }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.entity || !body.relation || !body.attribute) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "entity, relation, and attribute are required",
        },
        { status: 400 }
      );
    }
    const now = new Date().toISOString();
    const existing = queryOne<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM project_facts WHERE project_id = ? AND entity = ? AND relation = ?",
      projectId,
      body.entity,
      body.relation
    );
    if (existing) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE project_facts SET attribute = ?, trust_score = 1.0, updated_at = ? WHERE id = ?",
        body.attribute,
        now,
        existing.id
      );
      return Response.json({ id: existing.id });
    }
    const id = crypto.randomUUID();
    execute(
      this.ctx.storage.sql as never,
      "INSERT INTO project_facts (id, project_id, entity, relation, attribute, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      projectId,
      body.entity,
      body.relation,
      body.attribute,
      now,
      now
    );
    return Response.json({ id }, { status: 201 });
  }

  private recallProjectFacts(
    projectId: string,
    params: URLSearchParams
  ): Response {
    const q = params.get("q") ?? "";
    const limit = Math.min(
      Number.parseInt(params.get("limit") ?? "5", 10) || 5,
      50
    );
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = queryAll<{
      id: string;
      entity: string;
      relation: string;
      attribute: string;
      trust_score: number;
    }>(
      this.ctx.storage.sql as never,
      `SELECT id, entity, relation, attribute, trust_score FROM project_facts
       WHERE project_id = ? AND (entity LIKE ? ESCAPE '\\' OR relation LIKE ? ESCAPE '\\' OR attribute LIKE ? ESCAPE '\\')
       ORDER BY trust_score DESC LIMIT ?`,
      projectId,
      like,
      like,
      like,
      limit
    );
    return Response.json({ data: rows });
  }

  private deleteProjectFact(projectId: string, factId: string): Response {
    execute(
      this.ctx.storage.sql as never,
      "DELETE FROM project_facts WHERE id = ? AND project_id = ?",
      factId,
      projectId
    );
    return Response.json({ deleted: true });
  }

  private async recordProjectFabric(
    projectId: string,
    request: Request
  ): Promise<Response> {
    const body = await request
      .json<{
        session_id?: string;
        summary?: string;
        key_insights?: string[];
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.session_id || !body.summary) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "session_id and summary are required",
        },
        { status: 400 }
      );
    }
    const id = crypto.randomUUID();
    execute(
      this.ctx.storage.sql as never,
      "INSERT INTO project_fabric (id, project_id, session_id, summary, key_insights, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      projectId,
      body.session_id,
      body.summary,
      JSON.stringify(body.key_insights ?? []),
      new Date().toISOString()
    );
    return Response.json({ id }, { status: 201 });
  }

  private recallProjectFabric(
    projectId: string,
    params: URLSearchParams
  ): Response {
    const q = (params.get("q") ?? "").toLowerCase().trim();
    const limit = Math.min(
      Number.parseInt(params.get("limit") ?? "5", 10) || 5,
      50
    );
    const rows = queryAll<{
      id: string;
      session_id: string;
      summary: string;
      key_insights: string;
      created_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM project_fabric WHERE project_id = ? ORDER BY created_at DESC LIMIT 100",
      projectId
    );
    const scored = rows.map((r) => {
      const haystack = `${r.summary} ${r.key_insights}`.toLowerCase();
      let score = 0;
      if (q) {
        if (haystack.includes(q)) score = 1;
        else {
          const terms = new Set(q.split(/\s+/).filter((t) => t.length > 2));
          const hayTerms = new Set(haystack.split(/\s+/));
          let hits = 0;
          for (const t of terms) if (hayTerms.has(t)) hits++;
          score = terms.size > 0 ? hits / terms.size : 0;
        }
      }
      return { ...r, score };
    });
    const data = scored
      .filter((r) => r.score > 0.7)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return Response.json({ data });
  }

  private briefProjectFabric(
    projectId: string,
    params: URLSearchParams
  ): Response {
    const limit = Math.min(
      Number.parseInt(params.get("limit") ?? "5", 10) || 5,
      50
    );
    const rows = queryAll<{
      id: string;
      session_id: string;
      summary: string;
      key_insights: string;
      created_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM project_fabric WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      projectId,
      limit
    );
    return Response.json({ data: rows });
  }

  private async upsertProjectWikiConcept(
    projectId: string,
    request: Request
  ): Promise<Response> {
    const body = await request
      .json<{
        concept?: string;
        definition?: string;
        relationships?: string[];
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.concept || !body.definition) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "concept and definition are required",
        },
        { status: 400 }
      );
    }
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO project_wiki (project_id, concept, definition, relationships, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, concept) DO UPDATE SET definition = excluded.definition, relationships = excluded.relationships, updated_at = excluded.updated_at`,
      projectId,
      body.concept,
      body.definition,
      JSON.stringify(body.relationships ?? []),
      new Date().toISOString()
    );
    return Response.json({ concept: body.concept });
  }

  private lookupProjectWikiConcept(
    projectId: string,
    concept: string
  ): Response {
    const row = queryOne<{
      concept: string;
      definition: string;
      relationships: string;
      updated_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM project_wiki WHERE project_id = ? AND concept = ?",
      projectId,
      concept
    );
    return Response.json({ data: row ?? null });
  }

  private searchProjectWiki(
    projectId: string,
    params: URLSearchParams
  ): Response {
    const q = params.get("q") ?? "";
    const limit = Math.min(
      Number.parseInt(params.get("limit") ?? "5", 10) || 5,
      50
    );
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = queryAll<{
      concept: string;
      definition: string;
      relationships: string;
      updated_at: string;
    }>(
      this.ctx.storage.sql as never,
      `SELECT * FROM project_wiki WHERE project_id = ? AND (concept LIKE ? ESCAPE '\\' OR definition LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?`,
      projectId,
      like,
      like,
      limit
    );
    return Response.json({ data: rows });
  }

  // ── Authoritative per-project daily spend (F9) ──────────────────────────────────────────
  // Every agent-DO thread against a project (each its own NaelaoAgentDO instance) debits
  // through this one SpaceDO instead of keeping its own zero-based local tally — single
  // writer, so concurrent threads on the same customer-bot project share one real total.
  private getProjectSpend(
    projectId: string,
    params: URLSearchParams
  ): Response {
    const project = queryOne<{ daily_spend_cap_credits: number }>(
      this.ctx.storage.sql as never,
      "SELECT daily_spend_cap_credits FROM projects WHERE id = ?",
      projectId
    );
    if (!project)
      return Response.json(
        { error_code: "not_found", message: "Project not found" },
        { status: 404 }
      );
    const day = params.get("day") ?? todaySpendKey();
    const row = queryOne<{ credits: number }>(
      this.ctx.storage.sql as never,
      "SELECT credits FROM project_spend WHERE project_id = ? AND day = ?",
      projectId,
      day
    );
    const spentToday = row?.credits ?? 0;
    const cap = project.daily_spend_cap_credits;
    return Response.json({
      project_id: projectId,
      day,
      spent_today: spentToday,
      cap,
      capped: cap > 0 && spentToday >= cap,
    });
  }

  // POST /projects/:projectId/spend { credits } — adds `credits` (if any) to today's tally and
  // returns the updated total. Called with credits=0 as a pure pre-run gate check, and again
  // post-run with the actual token cost — both trips serialized through this single DO, so
  // spend recorded by one thread is immediately visible to the next thread's gate check.
  private async debitProjectSpend(
    projectId: string,
    request: Request
  ): Promise<Response> {
    const project = queryOne<{ daily_spend_cap_credits: number }>(
      this.ctx.storage.sql as never,
      "SELECT daily_spend_cap_credits FROM projects WHERE id = ?",
      projectId
    );
    if (!project)
      return Response.json(
        { error_code: "not_found", message: "Project not found" },
        { status: 404 }
      );
    const body = await request
      .json<{ credits?: number }>()
      .catch(() => ({}) as Record<string, never>);
    const credits =
      typeof body.credits === "number" && body.credits > 0 ? body.credits : 0;
    const day = todaySpendKey();
    if (credits > 0) {
      execute(
        this.ctx.storage.sql as never,
        `INSERT INTO project_spend (project_id, day, credits) VALUES (?, ?, ?)
         ON CONFLICT (project_id, day) DO UPDATE SET credits = credits + excluded.credits`,
        projectId,
        day,
        credits
      );
    }
    const row = queryOne<{ credits: number }>(
      this.ctx.storage.sql as never,
      "SELECT credits FROM project_spend WHERE project_id = ? AND day = ?",
      projectId,
      day
    );
    const spentToday = row?.credits ?? 0;
    const cap = project.daily_spend_cap_credits;
    return Response.json({
      project_id: projectId,
      day,
      spent_today: spentToday,
      cap,
      capped: cap > 0 && spentToday >= cap,
    });
  }

  // ── Builder observability surface (security audit follow-up) ───────────────
  // POST /agent-activity — internal only (NaelaoAgentDO posts one row per run completion/
  // failure and per approval request/resolution). Never blocks the caller's own response on a
  // write failure — see NaelaoAgentDO's logAgentActivity, which wraps every call in its own
  // best-effort try/catch, same posture as notifyApprovalRequested.
  private async recordAgentActivity(request: Request): Promise<Response> {
    const body = await request
      .json<{
        space_id: string;
        project_id?: string | null;
        thread_id?: string | null;
        agent_id: string;
        event_type:
          | "run_completed"
          | "run_failed"
          | "approval_requested"
          | "approval_resolved"
          | "moderation_blocked";
        summary?: string;
        tokens_used?: number | null;
        cost_credits?: number | null;
        /** Classification from @naelao/events classifyFailure — set by the agent DO at the moment
         *  of failure, so the diagnostics rollup never has to re-parse free text. */
        failure_kind?: string | null;
        /** The thread and run this happened in, so a reader can actually go and continue it. */
        session_id?: string | null;
        run_id?: string | null;
        /** What woke this run: chat, heartbeat, scheduled_job, connector_poll, trigger. */
        trigger_source?: string | null;
      }>()
      .catch(() => null);
    if (!body?.space_id || !body.agent_id || !body.event_type) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "space_id, agent_id, event_type are required",
        },
        { status: 400 }
      );
    }
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO agent_activity_log (id, space_id, project_id, thread_id, agent_id, event_type, summary, tokens_used, cost_credits,
                                       failure_kind, session_id, run_id, trigger_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      body.space_id,
      body.project_id ?? null,
      body.thread_id ?? null,
      body.agent_id,
      body.event_type,
      (body.summary ?? "").slice(0, 2000),
      body.tokens_used ?? null,
      body.cost_credits ?? null,
      isFailureKind(body.failure_kind) ? body.failure_kind : null,
      body.session_id ?? null,
      body.run_id ?? null,
      body.trigger_source ?? null
    );
    return Response.json({ ok: true }, { status: 201 });
  }

  // GET /agent-activity?project_id=&limit= — builder-facing paginated read (newest first), gated
  // builder-only at the spaces-worker route (product_end_user callers never reach this).
  private listAgentActivity(params: URLSearchParams): Response {
    const projectId = params.get("project_id");
    const limit = Math.min(
      Math.max(Number.parseInt(params.get("limit") ?? "50", 10) || 50, 1),
      200
    );
    // failure_kind / event_type are the drill-down the diagnostics summary points at: the summary
    // says "4 tool_error failures in Lead Generation", and this is how the assistant then reads
    // those four rows specifically instead of paging the whole log looking for them.
    const failureKind = params.get("failure_kind");
    const eventType = params.get("event_type");

    const where: string[] = [];
    const binds: Array<string | number> = [];
    if (projectId) {
      where.push("project_id = ?");
      binds.push(projectId);
    }
    if (failureKind && isFailureKind(failureKind)) {
      where.push("failure_kind = ?");
      binds.push(failureKind);
    }
    if (eventType) {
      where.push("event_type = ?");
      binds.push(eventType);
    }
    binds.push(limit);

    const rows = queryAll(
      this.ctx.storage.sql as never,
      `SELECT * FROM agent_activity_log${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT ?`,
      ...binds
    );
    return Response.json({ data: rows, count: rows.length });
  }

  // ── Notifications inbox ─────────────────────────────────────────────────────
  // POST /notifications — either a CREATE (kind/title present, called internal-only by
  // NaelaoAgentDO — see its createSpaceNotification helper) or a mark-read ACTION
  // ({action:"mark_read", notification_id}, reachable by any business member for their own
  // space's notifications). The spaces-worker route restricts a caller without an internal HMAC
  // token to ONLY the mark_read shape (see index.ts) — this method still checks defensively so a
  // bug at that layer can't turn into a forged notification.
  private async createOrActOnNotification(request: Request): Promise<Response> {
    const body = await request
      .json<{
        action?: string;
        notification_id?: string;
        space_id?: string;
        project_id?: string | null;
        kind?: string;
        title?: string;
        body?: string;
        severity?: "info" | "warning" | "critical";
        source_agent_id?: string | null;
        related_id?: string | null;
        recipient_user_id?: string | null;
      }>()
      .catch(() => null);
    if (!body)
      return Response.json(
        { error_code: "bad_request", message: "Invalid body" },
        { status: 400 }
      );

    if (body.action === "mark_read") {
      if (!body.notification_id) {
        return Response.json(
          { error_code: "bad_request", message: "notification_id is required" },
          { status: 400 }
        );
      }
      execute(
        this.ctx.storage.sql as never,
        "UPDATE notifications SET status = 'read', read_at = datetime('now') WHERE id = ? AND status != 'read'",
        body.notification_id
      );
      return Response.json({ ok: true });
    }

    // Internal-only in practice (the heartbeat sweep, after it actually sends the channel
    // message) — marks a row so it's never re-escalated on the next sweep. Deliberately does NOT
    // require internal auth at this DO layer (the spaces-worker route in front of it does), same
    // posture as mark_read.
    if (body.action === "mark_delivered") {
      if (!body.notification_id) {
        return Response.json(
          { error_code: "bad_request", message: "notification_id is required" },
          { status: 400 }
        );
      }
      execute(
        this.ctx.storage.sql as never,
        "UPDATE notifications SET delivered_at = datetime('now') WHERE id = ? AND delivered_at IS NULL",
        body.notification_id
      );
      return Response.json({ ok: true });
    }

    if (!body.space_id || !body.kind || !body.title) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "space_id, kind, title are required",
        },
        { status: 400 }
      );
    }
    const id = crypto.randomUUID();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO notifications (id, space_id, project_id, kind, title, body, severity, source_agent_id, related_id, recipient_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      body.space_id,
      body.project_id ?? null,
      body.kind,
      body.title.slice(0, 300),
      (body.body ?? "").slice(0, 2000),
      body.severity ?? "info",
      body.source_agent_id ?? null,
      body.related_id ?? null,
      body.recipient_user_id ?? null
    );
    return Response.json({ ok: true, id }, { status: 201 });
  }

  // GET /notifications?status=&limit=&undelivered_only=&stale_after_minutes= — the same read path
  // serves both the business-member-facing inbox (status/limit only) and the heartbeat sweep's
  // "what still needs escalating to a channel" query (undelivered_only + stale_after_minutes),
  // rather than a second route — see the dispatcher comment above for why.
  // project_id filtering: the assistant/Home chat view wants ALL notifications (the Space
  // Assistant oversees the whole business), so omitting project_id keeps the prior unfiltered
  // behavior. A project thread's own sidebar wants only THAT project's agent's notifications —
  // pass project_id to scope to it. There's no "assistant-only" (project_id IS NULL) mode here,
  // unlike scheduled_jobs/channel_links, because the ask for this tab was explicitly "all
  // notifications" for the assistant view, not "just the space-level ones."
  private listNotifications(params: URLSearchParams): Response {
    const status = params.get("status");
    const projectId = params.get("project_id");
    const limit = Math.min(
      Math.max(Number.parseInt(params.get("limit") ?? "50", 10) || 50, 1),
      200
    );
    if (params.get("undelivered_only") === "true") {
      const staleMinutesRaw = Number.parseInt(
        params.get("stale_after_minutes") ?? "15",
        10
      );
      const staleMinutes =
        Number.isFinite(staleMinutesRaw) && staleMinutesRaw >= 0
          ? staleMinutesRaw
          : 15;
      const rows = queryAll(
        this.ctx.storage.sql as never,
        `SELECT * FROM notifications
         WHERE status = 'unread' AND delivered_at IS NULL
           AND created_at <= datetime('now', ?)
         ORDER BY created_at ASC LIMIT ?`,
        `-${staleMinutes} minutes`,
        limit
      );
      return Response.json({ data: rows, count: rows.length });
    }
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (status) {
      clauses.push("status = ?");
      args.push(status);
    }
    if (projectId) {
      clauses.push("project_id = ?");
      args.push(projectId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = queryAll(
      this.ctx.storage.sql as never,
      `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ?`,
      ...args,
      limit
    );
    return Response.json({ data: rows, count: rows.length });
  }

  // ── §A1 Harness Excellence Phase HX2: signals + session token-budget guard ─────
  // GET /agent-signals?project_id=&window_hours= — explicit signals computed on read from
  // agent_activity_log (item 40's cross-DO observability mirror). No new ingestion: error
  // rate and avg/total cost are a straight rollup; "regenerations" (a proxy for the user
  // hitting retry/regenerate) is computed in application code from ordered per-thread rows
  // rather than a SQL window function, since DO SQLite's window-function support isn't
  // something this codebase otherwise relies on and the row counts here are always small.
  private computeAgentSignals(params: URLSearchParams): Response {
    const projectId = params.get("project_id");
    const windowHours = Math.min(
      Math.max(
        Number.parseInt(params.get("window_hours") ?? "24", 10) || 24,
        1
      ),
      24 * 30
    );
    const since = `datetime('now', '-${windowHours} hours')`;

    const rollup = projectId
      ? queryAll<{
          event_type: string;
          cnt: number;
          avg_cost: number | null;
          total_cost: number | null;
        }>(
          this.ctx.storage.sql as never,
          `SELECT event_type, COUNT(*) as cnt, AVG(cost_credits) as avg_cost, SUM(cost_credits) as total_cost
           FROM agent_activity_log WHERE project_id = ? AND created_at >= ${since} GROUP BY event_type`,
          projectId
        )
      : queryAll<{
          event_type: string;
          cnt: number;
          avg_cost: number | null;
          total_cost: number | null;
        }>(
          this.ctx.storage.sql as never,
          `SELECT event_type, COUNT(*) as cnt, AVG(cost_credits) as avg_cost, SUM(cost_credits) as total_cost
           FROM agent_activity_log WHERE created_at >= ${since} GROUP BY event_type`
        );

    const byType = new Map(rollup.map((r) => [r.event_type, r]));
    const runsCompleted = byType.get("run_completed")?.cnt ?? 0;
    const runsFailed = byType.get("run_failed")?.cnt ?? 0;
    const runsTotal = runsCompleted + runsFailed;
    const completedRow = byType.get("run_completed");

    // Regeneration proxy: 2+ run_completed/run_failed events on the SAME thread within 5
    // minutes of each other. Small result sets expected (bounded by the window above), so an
    // in-memory pass over ordered rows is simpler and more portable than a SQL window function.
    const threadRows = projectId
      ? queryAll<{ thread_id: string | null; created_at: string }>(
          this.ctx.storage.sql as never,
          `SELECT thread_id, created_at FROM agent_activity_log
           WHERE project_id = ? AND created_at >= ${since} AND event_type IN ('run_completed','run_failed')
           ORDER BY thread_id, created_at ASC`,
          projectId
        )
      : queryAll<{ thread_id: string | null; created_at: string }>(
          this.ctx.storage.sql as never,
          `SELECT thread_id, created_at FROM agent_activity_log
           WHERE created_at >= ${since} AND event_type IN ('run_completed','run_failed')
           ORDER BY thread_id, created_at ASC`
        );
    const REGEN_WINDOW_MS = 5 * 60 * 1000;
    let regenerations = 0;
    let prevThread: string | null = null;
    let prevMs = 0;
    for (const row of threadRows) {
      if (!row.thread_id) continue;
      // Safe here specifically: agent_activity_log.created_at is written ONLY by this table's own
      // `datetime('now')` default, i.e. SQLite's bare "YYYY-MM-DD HH:MM:SS", which V8 parses with
      // a Z appended. Do not copy this pattern to a column an application also writes explicitly:
      // scheduled_jobs binds new Date().toISOString() over its identical default, so the same
      // line there produced "…Z" + "Z" = NaN and silently disabled every schedule on the platform.
      const ms = Date.parse(row.created_at + "Z");
      if (row.thread_id === prevThread && ms - prevMs <= REGEN_WINDOW_MS)
        regenerations++;
      prevThread = row.thread_id;
      prevMs = ms;
    }

    return Response.json({
      window_hours: windowHours,
      runs_total: runsTotal,
      runs_completed: runsCompleted,
      runs_failed: runsFailed,
      error_rate: runsTotal > 0 ? runsFailed / runsTotal : 0,
      avg_cost_credits: completedRow?.avg_cost ?? 0,
      total_cost_credits: completedRow?.total_cost ?? 0,
      approvals_requested: byType.get("approval_requested")?.cnt ?? 0,
      regenerations,
    });
  }

  /**
   * GET /agent-diagnostics?window_hours= — the whole business in one bounded summary.
   *
   * The Space Assistant is woken by a heartbeat, a cron, a channel message — and each of those
   * used to arrive with no idea what had happened since last time. It could read
   * /agent-activity, but that is raw rows: "48 events" is not something to act on, and reading
   * enough of them to find the pattern costs more context than the whole wake-up is worth.
   *
   * So this is deliberately a SUMMARY, not a feed. Counts, the failure kinds that actually
   * occurred, the per-project shape of it, and — the part that makes it actionable — the ids
   * needed to go deeper: which thread stopped, which run to continue, which project to read.
   * Drilling down is a separate, explicit call the assistant makes only where it sees something
   * wrong (GET /agent-activity?failure_kind=, project_journal.read, the interrupted-run route).
   *
   * Everything is capped: at most 8 projects, 6 recent failures, 5 stalls. A brief that grows
   * with the business stops being a brief.
   */
  private computeAgentDiagnostics(params: URLSearchParams): Response {
    const windowHours = Math.min(
      Math.max(
        Number.parseInt(params.get("window_hours") ?? "24", 10) || 24,
        1
      ),
      24 * 30
    );
    const since = `datetime('now', '-${windowHours} hours')`;
    const sql = this.ctx.storage.sql as never;

    const byType = queryAll<{
      event_type: string;
      cnt: number;
      tokens: number | null;
      credits: number | null;
    }>(
      sql,
      `SELECT event_type, COUNT(*) as cnt, SUM(tokens_used) as tokens, SUM(cost_credits) as credits
         FROM agent_activity_log WHERE created_at >= ${since} GROUP BY event_type`
    );
    const counts: Record<string, number> = {};
    let totalTokens = 0;
    let totalCredits = 0;
    for (const r of byType) {
      counts[r.event_type] = r.cnt;
      totalTokens += r.tokens ?? 0;
      totalCredits += r.credits ?? 0;
    }

    // Why runs failed, most common first. This is the single most useful line in the brief: an
    // agent that knows its failures were all quota_exhausted behaves very differently from one
    // whose failures were all tool_error, and neither behaviour is reachable from a bare count.
    const failures = queryAll<{ failure_kind: string | null; cnt: number }>(
      sql,
      `SELECT failure_kind, COUNT(*) as cnt FROM agent_activity_log
        WHERE event_type = 'run_failed' AND created_at >= ${since}
        GROUP BY failure_kind ORDER BY cnt DESC LIMIT 8`
    ).map((r) => ({ kind: r.failure_kind ?? "unknown", count: r.cnt }));

    // Where the work is, per project — including which projects are burning tokens without
    // finishing anything, which is exactly the "which project thread stopped and why" question.
    const projects = queryAll<{
      project_id: string | null;
      completed: number;
      failed: number;
      tokens: number | null;
      credits: number | null;
    }>(
      sql,
      `SELECT project_id,
              SUM(CASE WHEN event_type = 'run_completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN event_type = 'run_failed'    THEN 1 ELSE 0 END) as failed,
              SUM(tokens_used) as tokens, SUM(cost_credits) as credits
         FROM agent_activity_log
        WHERE created_at >= ${since} AND event_type IN ('run_completed','run_failed')
        GROUP BY project_id
        ORDER BY (failed * 3 + completed) DESC LIMIT 8`
    );

    // Project names, so the brief reads as "Lead Generation stalled" and not a bare uuid the
    // assistant would have to spend another call resolving.
    const nameById = new Map<string, string>();
    for (const p of queryAll<{ id: string; name: string }>(
      sql,
      `SELECT id, name FROM projects`
    )) {
      nameById.set(p.id, p.name);
    }

    // The stalls worth resuming: the most recent failures that still name a thread. Capped hard —
    // this is a pointer list, not a log.
    const stalls = queryAll<{
      project_id: string | null;
      thread_id: string | null;
      session_id: string | null;
      run_id: string | null;
      failure_kind: string | null;
      summary: string;
      trigger_source: string | null;
      created_at: string;
      tokens_used: number | null;
    }>(
      sql,
      `SELECT project_id, thread_id, session_id, run_id, failure_kind, summary, trigger_source, created_at, tokens_used
         FROM agent_activity_log
        WHERE event_type = 'run_failed' AND created_at >= ${since}
        ORDER BY created_at DESC LIMIT 6`
    ).map((r) => ({
      project_id: r.project_id,
      project_name: r.project_id ? (nameById.get(r.project_id) ?? null) : null,
      thread_id: r.thread_id,
      session_id: r.session_id,
      run_id: r.run_id,
      failure_kind: r.failure_kind ?? "unknown",
      // The summary is already capped at 2000 on write; 240 is what fits a brief without turning
      // it into a log dump. The full text stays available via /agent-activity.
      summary: (r.summary ?? "").slice(0, 240),
      woken_by: r.trigger_source,
      tokens_used: r.tokens_used,
      at: r.created_at,
    }));

    // How many wake-ups never got anywhere. A recurring "the heartbeat fired and immediately hit
    // a limit" pattern is invisible in a per-run view and obvious here.
    const wakeFailures = queryAll<{
      trigger_source: string | null;
      cnt: number;
    }>(
      sql,
      `SELECT trigger_source, COUNT(*) as cnt FROM agent_activity_log
        WHERE event_type = 'run_failed' AND created_at >= ${since}
          AND trigger_source IS NOT NULL AND trigger_source != 'chat'
        GROUP BY trigger_source ORDER BY cnt DESC LIMIT 5`
    ).map((r) => ({
      trigger: r.trigger_source ?? "unknown",
      failed_runs: r.cnt,
    }));

    const unreadNotifications =
      queryOne<{ cnt: number }>(
        sql,
        `SELECT COUNT(*) as cnt FROM notifications WHERE status = 'unread'`
      )?.cnt ?? 0;
    const criticalUnread =
      queryOne<{ cnt: number }>(
        sql,
        `SELECT COUNT(*) as cnt FROM notifications WHERE status = 'unread' AND severity = 'critical'`
      )?.cnt ?? 0;

    const runsCompleted = counts["run_completed"] ?? 0;
    const runsFailed = counts["run_failed"] ?? 0;
    const runsTotal = runsCompleted + runsFailed;

    return Response.json({
      window_hours: windowHours,
      runs: {
        total: runsTotal,
        completed: runsCompleted,
        failed: runsFailed,
        error_rate:
          runsTotal > 0 ? Number((runsFailed / runsTotal).toFixed(3)) : 0,
      },
      spend: { tokens_used: totalTokens, credits: totalCredits },
      approvals: {
        requested: counts["approval_requested"] ?? 0,
        resolved: counts["approval_resolved"] ?? 0,
        // A gap here means work is parked on a person who hasn't answered.
        outstanding: Math.max(
          0,
          (counts["approval_requested"] ?? 0) -
            (counts["approval_resolved"] ?? 0)
        ),
      },
      moderation_blocked: counts["moderation_blocked"] ?? 0,
      failures_by_kind: failures,
      wake_failures: wakeFailures,
      projects: projects.map((p) => ({
        project_id: p.project_id,
        name: p.project_id
          ? (nameById.get(p.project_id) ?? null)
          : "(space assistant)",
        completed: p.completed,
        failed: p.failed,
        tokens_used: p.tokens ?? 0,
        credits: p.credits ?? 0,
      })),
      recent_stalls: stalls,
      notifications: {
        unread: unreadNotifications,
        unread_critical: criticalUnread,
      },
    });
  }

  // GET /business-analytics?window=7d|30d|90d — the Analytics page's data (apps/shell's Settings-
  // adjacent business dashboard, mirroring the mockup's Analytics view). Pure aggregate — counts,
  // sums, and per-day/per-agent rollups, never a raw row with a session id, thread id, or summary
  // text attached — which is what makes this safe for ANY business member, unlike the
  // builder-only agent-activity/agent-diagnostics endpoints this shares its table with.
  //
  // "Heartbeat pass/fail": only FAILURES are ever logged for an idle heartbeat tick (see
  // handleAgentTick in workers/agents — a heartbeat with nothing to do writes nothing, since
  // logging a no-op tick for every space every hour platform-wide would dwarf the table for zero
  // signal). So "passes" here honestly means "wake-ups that did real work and it completed", not
  // "every tick that happened to run" — there is no record of a silent, work-free tick succeeding,
  // and this deliberately does not invent one.
  private computeBusinessAnalytics(params: URLSearchParams): Response {
    const windowDays =
      params.get("window") === "30d"
        ? 30
        : params.get("window") === "90d"
          ? 90
          : 7;
    const since = `datetime('now', '-${windowDays} days')`;
    const prevSince = `datetime('now', '-${windowDays * 2} days')`;
    const sql = this.ctx.storage.sql as never;

    const byType = queryAll<{
      event_type: string;
      cnt: number;
      tokens: number | null;
      credits: number | null;
    }>(
      sql,
      `SELECT event_type, COUNT(*) as cnt, SUM(tokens_used) as tokens, SUM(cost_credits) as credits
         FROM agent_activity_log WHERE created_at >= ${since} GROUP BY event_type`
    );
    const counts: Record<string, number> = {};
    let totalTokens = 0;
    let totalCredits = 0;
    for (const r of byType) {
      counts[r.event_type] = r.cnt;
      totalTokens += r.tokens ?? 0;
      totalCredits += r.credits ?? 0;
    }
    const runsCompleted = counts["run_completed"] ?? 0;
    const runsFailed = counts["run_failed"] ?? 0;
    const runsTotal = runsCompleted + runsFailed;

    // Prior window, for the "vs last period" deltas the mockup's cards show — a real comparison,
    // not a fabricated percentage.
    const prevCredits =
      queryOne<{ credits: number | null }>(
        sql,
        `SELECT SUM(cost_credits) as credits FROM agent_activity_log
        WHERE created_at >= ${prevSince} AND created_at < ${since}`
      )?.credits ?? 0;
    const prevRuns =
      queryOne<{ cnt: number }>(
        sql,
        `SELECT COUNT(*) as cnt FROM agent_activity_log
        WHERE created_at >= ${prevSince} AND created_at < ${since} AND event_type IN ('run_completed','run_failed')`
      )?.cnt ?? 0;

    // Per-agent breakdown for the mockup's "Usage by Agent" table — runs/credits/success rate.
    // No avg-duration column exists on this table (nothing measures wall time per run today), so
    // this deliberately omits that field rather than fabricating one.
    const byAgent = queryAll<{
      agent_id: string;
      completed: number;
      failed: number;
      credits: number | null;
      tokens: number | null;
    }>(
      sql,
      `SELECT agent_id,
              SUM(CASE WHEN event_type = 'run_completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN event_type = 'run_failed'    THEN 1 ELSE 0 END) as failed,
              SUM(cost_credits) as credits, SUM(tokens_used) as tokens
         FROM agent_activity_log
        WHERE created_at >= ${since} AND event_type IN ('run_completed','run_failed')
        GROUP BY agent_id ORDER BY (completed + failed) DESC LIMIT 12`
    );

    // Daily credit usage for the bar chart — one row per day even when a day had zero activity,
    // computed in application code rather than a SQL date-series generator DO SQLite doesn't have.
    const dailyRows = queryAll<{
      day: string;
      credits: number | null;
      runs: number;
    }>(
      sql,
      `SELECT substr(created_at, 1, 10) as day, SUM(cost_credits) as credits, COUNT(*) as runs
         FROM agent_activity_log
        WHERE created_at >= ${since} AND event_type IN ('run_completed','run_failed')
        GROUP BY day`
    );
    const dailyByDay = new Map(
      dailyRows.map((r) => [r.day, { credits: r.credits ?? 0, runs: r.runs }])
    );
    const daily: { day: string; credits: number; runs: number }[] = [];
    const bucketDays = Math.min(windowDays, 30); // cap the series at 30 points even for the 90d window
    const step = windowDays / bucketDays;
    for (let i = bucketDays - 1; i >= 0; i--) {
      const d = new Date(
        Date.now() - Math.round(i * step) * 24 * 60 * 60 * 1000
      );
      const key = d.toISOString().slice(0, 10);
      const found = dailyByDay.get(key);
      daily.push({
        day: key,
        credits: found?.credits ?? 0,
        runs: found?.runs ?? 0,
      });
    }

    // Heartbeat/scheduled wake-ups: failures by trigger, honestly labeled per the header comment
    // above (no fabricated "pass" count for a silent no-op tick).
    const wakeFailures = queryAll<{
      trigger_source: string | null;
      cnt: number;
    }>(
      sql,
      `SELECT trigger_source, COUNT(*) as cnt FROM agent_activity_log
        WHERE event_type = 'run_failed' AND created_at >= ${since}
          AND trigger_source IS NOT NULL AND trigger_source != 'chat'
        GROUP BY trigger_source ORDER BY cnt DESC LIMIT 8`
    ).map((r) => ({ trigger: r.trigger_source ?? "unknown", failed: r.cnt }));
    const wakeCompleted =
      queryOne<{ cnt: number }>(
        sql,
        `SELECT COUNT(*) as cnt FROM agent_activity_log
        WHERE event_type = 'run_completed' AND created_at >= ${since}
          AND trigger_source IS NOT NULL AND trigger_source != 'chat'`
      )?.cnt ?? 0;
    const wakeFailedTotal = wakeFailures.reduce((sum, w) => sum + w.failed, 0);

    const projectsTotal =
      queryOne<{ cnt: number }>(
        sql,
        `SELECT COUNT(*) as cnt FROM projects WHERE status != 'archived'`
      )?.cnt ?? 0;
    const threadsTotal =
      queryOne<{ cnt: number }>(sql, `SELECT COUNT(*) as cnt FROM threads`)
        ?.cnt ?? 0;

    return Response.json({
      window_days: windowDays,
      runs: {
        total: runsTotal,
        completed: runsCompleted,
        failed: runsFailed,
        success_rate:
          runsTotal > 0 ? Number((runsCompleted / runsTotal).toFixed(3)) : null,
        vs_prior_period:
          prevRuns > 0
            ? Number((((runsTotal - prevRuns) / prevRuns) * 100).toFixed(1))
            : null,
      },
      credits: {
        used: totalCredits,
        vs_prior_period:
          prevCredits > 0
            ? Number(
                (((totalCredits - prevCredits) / prevCredits) * 100).toFixed(1)
              )
            : null,
      },
      tokens_used: totalTokens,
      by_agent: byAgent.map((a) => ({
        agent_id: a.agent_id,
        runs: a.completed + a.failed,
        completed: a.completed,
        failed: a.failed,
        success_rate:
          a.completed + a.failed > 0
            ? Number((a.completed / (a.completed + a.failed)).toFixed(3))
            : null,
        credits: a.credits ?? 0,
      })),
      daily,
      heartbeats: {
        completed_with_work: wakeCompleted,
        failed: wakeFailedTotal,
        by_trigger: wakeFailures,
      },
      structure: { projects: projectsTotal, threads: threadsTotal },
    });
  }

  // POST /signal-events — internal only (implicit signals: user-frustration / agent-forgot
  // markers detected by @naelao/events' detectImplicitSignals against a run's goal text).
  // Mirrors recordAgentActivity's shape/posture exactly — never blocks the caller's own run.
  private async recordSignalEvent(request: Request): Promise<Response> {
    const body = await request
      .json<{
        space_id: string;
        project_id?: string | null;
        thread_id?: string | null;
        agent_id: string;
        signal_type: string;
        detail?: string;
      }>()
      .catch(() => null);
    if (!body?.space_id || !body.agent_id || !body.signal_type) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "space_id, agent_id, signal_type are required",
        },
        { status: 400 }
      );
    }
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO agent_signal_events (id, space_id, project_id, thread_id, agent_id, signal_type, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      body.space_id,
      body.project_id ?? null,
      body.thread_id ?? null,
      body.agent_id,
      body.signal_type,
      (body.detail ?? "").slice(0, 500)
    );
    return Response.json({ ok: true }, { status: 201 });
  }

  // GET /signal-events?project_id=&signal_type=&limit= — builder-facing paginated read.
  private listSignalEvents(params: URLSearchParams): Response {
    const projectId = params.get("project_id");
    const signalType = params.get("signal_type");
    const limit = Math.min(
      Math.max(Number.parseInt(params.get("limit") ?? "50", 10) || 50, 1),
      200
    );
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (projectId) {
      clauses.push("project_id = ?");
      args.push(projectId);
    }
    if (signalType) {
      clauses.push("signal_type = ?");
      args.push(signalType);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = queryAll(
      this.ctx.storage.sql as never,
      `SELECT * FROM agent_signal_events ${where} ORDER BY created_at DESC LIMIT ?`,
      ...args,
      limit
    );
    return Response.json({ data: rows, count: rows.length });
  }

  // POST /session-spend — internal only: increments a session's cumulative credit tally.
  // Upsert rather than a blind INSERT since the same session accumulates across many runs.
  private async incrementSessionSpend(request: Request): Promise<Response> {
    const body = await request
      .json<{
        session_id: string;
        space_id: string;
        project_id?: string | null;
        credits: number;
      }>()
      .catch(() => null);
    if (
      !body?.session_id ||
      !body.space_id ||
      typeof body.credits !== "number"
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "session_id, space_id, credits are required",
        },
        { status: 400 }
      );
    }
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO session_spend (session_id, space_id, project_id, credits_used, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         credits_used = credits_used + excluded.credits_used,
         updated_at = datetime('now')`,
      body.session_id,
      body.space_id,
      body.project_id ?? null,
      Math.max(0, Math.round(body.credits))
    );
    return Response.json({ ok: true }, { status: 201 });
  }

  // GET /session-spend/:sessionId — read the current tally; a session with no rows yet (never
  // ran, or the budget guard is off) reads as an honest zeroed default, not a 404.
  private getSessionSpend(sessionId: string): Response {
    const row = queryOne<{
      session_id: string;
      space_id: string;
      project_id: string | null;
      credits_used: number;
      warned_80: number;
      updated_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM session_spend WHERE session_id = ?",
      sessionId
    );
    if (!row) {
      return Response.json({
        session_id: sessionId,
        credits_used: 0,
        warned_80: false,
      });
    }
    return Response.json({
      session_id: row.session_id,
      credits_used: row.credits_used,
      warned_80: row.warned_80 === 1,
      updated_at: row.updated_at,
    });
  }

  // POST /session-spend/:sessionId/continue — a human approved continuing past the ceiling.
  // Resets the tally to 0 (a fresh spending cycle) rather than tracking an ever-growing
  // "extensions" count — simpler mental model, and the next cycle re-crosses the SAME ceiling
  // rather than a compounding one, so nothing needs the un-bounded-growth edge case guarded.
  private continueSessionSpend(sessionId: string): Response {
    // A no-op UPDATE (0 rows) when the session has no spend record yet is fine — there's
    // nothing to reset. Never creates a placeholder row (which would need a fake space_id).
    execute(
      this.ctx.storage.sql as never,
      `UPDATE session_spend SET credits_used = 0, warned_80 = 0, updated_at = datetime('now') WHERE session_id = ?`,
      sessionId
    );
    return Response.json({ ok: true });
  }

  // POST /session-spend/:sessionId/mark-warned — idempotent single-fire flag.
  private markSessionSpendWarned(sessionId: string): Response {
    execute(
      this.ctx.storage.sql as never,
      `UPDATE session_spend SET warned_80 = 1, updated_at = datetime('now') WHERE session_id = ?`,
      sessionId
    );
    return Response.json({ ok: true });
  }

  // ── Launchpad Wallet (user-directed feature) ────────────────────────────────
  // A project flagged kind='wallet' carries a stored-value balance in wallet_ledger — an
  // append-only ledger (balance is SUM(delta_cents), never a cached column), same
  // never-double-credit-on-replay shape as ProductUserDO's credit_ledger. Every op below 404s
  // for a project that isn't actually kind='wallet' — deliberately strict, since these are
  // money-adjacent ops and a workspace/customer_bot project should never accumulate a balance
  // by accident. See wallet.ts (script-engine prebuilt) for the agent-facing surface and the
  // full custody-boundary writeup this feature keeps to.
  private requireWalletProject(projectId: string): { space_id: string } | null {
    const row = queryOne<{ space_id: string; kind: string }>(
      this.ctx.storage.sql as never,
      "SELECT space_id, kind FROM projects WHERE id = ?",
      projectId
    );
    if (!row || row.kind !== "wallet") return null;
    return { space_id: row.space_id };
  }

  private walletBalance(projectId: string): number {
    const row = queryOne<{ bal: number | null }>(
      this.ctx.storage.sql as never,
      "SELECT SUM(delta_cents) AS bal FROM wallet_ledger WHERE project_id = ?",
      projectId
    );
    return row?.bal ?? 0;
  }

  private findWalletProject(spaceId: string): Response {
    if (!spaceId) return Response.json({ project_id: null });
    const row = queryOne<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM projects WHERE space_id = ? AND kind = 'wallet' AND status != 'archived' ORDER BY created_at ASC LIMIT 1",
      spaceId
    );
    return Response.json({ project_id: row?.id ?? null });
  }

  // External revenue tracker (Whop-native business cut): the revenue-tracker prebuilt reports
  // a period's observed gross revenue here (upsert — re-tracking the same period overwrites the
  // prior observation, since more of a period's payments can complete between checks).
  // F-27: a correction NO LONGER reverts billed→0 and re-bills the full figure. `billed_cents`
  // (what was actually charged) persists across corrections; the checkout bills only
  // max(0, cut(new_revenue) − billed_cents), so correcting 100k→120k bills the 20k×cut delta, not
  // the full 120k×cut on top of what was already collected. We only update revenue_cents/tracked_at
  // here — billed/billed_cents are owned by the mark-billed/unmark-billed payment webhooks.
  private async recordExternalRevenue(request: Request): Promise<Response> {
    const body = await request
      .json<{
        space_id?: string;
        period?: string;
        provider?: string;
        revenue_cents?: number;
      }>()
      .catch(() => ({}) as Record<string, never>);
    const spaceId = body.space_id ?? "";
    const period = body.period ?? "";
    const provider = body.provider ?? "whop";
    const revenueCents = Number.isFinite(body.revenue_cents)
      ? Math.max(0, Math.round(body.revenue_cents!))
      : Number.NaN;
    if (
      !spaceId ||
      !/^\d{4}-\d{2}$/.test(period) ||
      !Number.isFinite(revenueCents)
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message:
            "space_id, period ('YYYY-MM'), and revenue_cents are required",
        },
        { status: 400 }
      );
    }

    execute(
      this.ctx.storage.sql as never,
      // On a first observation, billed/billed_cents default to 0/0 (fully billable). On a re-track
      // (correction), ONLY revenue_cents + tracked_at change — the accumulated billed_cents stays,
      // which is exactly what makes the checkout's delta computation correct.
      `INSERT INTO external_revenue_snapshots (id, space_id, period, provider, revenue_cents, billed, tracked_at)
       VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
       ON CONFLICT(space_id, period, provider) DO UPDATE SET
         revenue_cents = excluded.revenue_cents, tracked_at = excluded.tracked_at`,
      crypto.randomUUID(),
      spaceId,
      period,
      provider,
      revenueCents
    );
    const row = queryOne<{ billed: number; billed_cents: number }>(
      this.ctx.storage.sql as never,
      "SELECT billed, billed_cents FROM external_revenue_snapshots WHERE space_id = ? AND period = ? AND provider = ?",
      spaceId,
      period,
      provider
    );
    return Response.json(
      {
        space_id: spaceId,
        period,
        provider,
        revenue_cents: revenueCents,
        billed: row?.billed === 1,
        billed_cents: row?.billed_cents ?? 0,
      },
      { status: 201 }
    );
  }

  private getExternalRevenue(params: URLSearchParams): Response {
    const spaceId = params.get("space_id") ?? "";
    if (!spaceId)
      return Response.json(
        { error_code: "bad_request", message: "space_id is required" },
        { status: 400 }
      );
    const provider = params.get("provider") ?? "whop";
    const period = params.get("period");

    if (period) {
      const row = queryOne<{
        revenue_cents: number;
        billed: number;
        billed_cents: number;
        pending_checkout_at: string | null;
        tracked_at: string;
      }>(
        this.ctx.storage.sql as never,
        "SELECT revenue_cents, billed, billed_cents, pending_checkout_at, tracked_at FROM external_revenue_snapshots WHERE space_id = ? AND period = ? AND provider = ?",
        spaceId,
        period,
        provider
      );
      if (!row)
        return Response.json({
          space_id: spaceId,
          period,
          provider,
          revenue_cents: 0,
          billed: false,
          billed_cents: 0,
          pending_checkout_at: null,
          tracked_at: null,
        });
      return Response.json({
        space_id: spaceId,
        period,
        provider,
        revenue_cents: row.revenue_cents,
        billed: row.billed === 1,
        billed_cents: row.billed_cents,
        pending_checkout_at: row.pending_checkout_at,
        tracked_at: row.tracked_at,
      });
    }

    const rows = queryAll<{
      period: string;
      revenue_cents: number;
      billed: number;
      billed_cents: number;
      pending_checkout_at: string | null;
      tracked_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT period, revenue_cents, billed, billed_cents, pending_checkout_at, tracked_at FROM external_revenue_snapshots WHERE space_id = ? AND provider = ? ORDER BY period DESC LIMIT 24",
      spaceId,
      provider
    );
    return Response.json({
      space_id: spaceId,
      provider,
      snapshots: rows.map((r) => ({
        period: r.period,
        revenue_cents: r.revenue_cents,
        billed: r.billed === 1,
        billed_cents: r.billed_cents,
        pending_checkout_at: r.pending_checkout_at,
        tracked_at: r.tracked_at,
      })),
      last_tracked_at: rows[0]?.tracked_at ?? null,
    });
  }

  // Marks specific periods billed after a successful revenue-cut surcharge payment (the billing
  // worker's webhook handler calls this, never the tracker) — distinct from recordExternalRevenue
  // (which upserts a REVENUE OBSERVATION) since this only ever flips the billed flag, never
  // touches revenue_cents. Idempotent: an already-billed period is a no-op.
  private async markRevenueBilled(request: Request): Promise<Response> {
    const body = await request
      .json<{
        space_id?: string;
        periods?: string[];
        charges?: number[];
        provider?: string;
      }>()
      .catch(() => ({}) as Record<string, never>);
    const spaceId = body.space_id ?? "";
    const provider = body.provider ?? "whop";
    const periods = Array.isArray(body.periods)
      ? body.periods.filter((p) => /^\d{4}-\d{2}$/.test(p))
      : [];
    if (!spaceId || periods.length === 0) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "space_id and at least one valid period are required",
        },
        { status: 400 }
      );
    }
    // F-27: `charges` (parallel to periods) is the delta actually charged for each period — ADDED
    // to billed_cents so a later correction bills only the new delta. A caller that omits charges
    // (legacy) falls back to marking the period fully billed (billed_cents = revenue_cents, a
    // ceiling that's never re-billed). F-31: clear pending_checkout_at now that it's paid.
    const charges = Array.isArray(body.charges) ? body.charges : [];
    periods.forEach((period, i) => {
      const charge = Number.isFinite(charges[i])
        ? Math.max(0, Math.round(charges[i]!))
        : null;
      if (charge !== null) {
        execute(
          this.ctx.storage.sql as never,
          "UPDATE external_revenue_snapshots SET billed = 1, billed_cents = billed_cents + ?, pending_checkout_at = NULL WHERE space_id = ? AND period = ? AND provider = ?",
          charge,
          spaceId,
          period,
          provider
        );
      } else {
        execute(
          this.ctx.storage.sql as never,
          "UPDATE external_revenue_snapshots SET billed = 1, billed_cents = revenue_cents, pending_checkout_at = NULL WHERE space_id = ? AND period = ? AND provider = ?",
          spaceId,
          period,
          provider
        );
      }
    });
    return Response.json({
      space_id: spaceId,
      provider,
      billed_periods: periods,
    });
  }

  // F-29: the inverse of markRevenueBilled — the billing worker calls this when a revenue-cut
  // surcharge payment is refunded, so the periods it covered revert to unbilled and become
  // re-billable on the next checkout. Idempotent: an already-unbilled period is a no-op.
  private async markRevenueUnbilled(request: Request): Promise<Response> {
    const body = await request
      .json<{
        space_id?: string;
        periods?: string[];
        charges?: number[];
        provider?: string;
      }>()
      .catch(() => ({}) as Record<string, never>);
    const spaceId = body.space_id ?? "";
    const provider = body.provider ?? "whop";
    const periods = Array.isArray(body.periods)
      ? body.periods.filter((p) => /^\d{4}-\d{2}$/.test(p))
      : [];
    if (!spaceId || periods.length === 0) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "space_id and at least one valid period are required",
        },
        { status: 400 }
      );
    }
    // F-27: reverse exactly the charge that was collected (billed_cents -= charge), so a refunded
    // surcharge re-opens only that much for re-billing — not the whole period from scratch. Legacy
    // callers (no charges) zero billed_cents. billed flips to 0 once nothing is left charged.
    const charges = Array.isArray(body.charges) ? body.charges : [];
    periods.forEach((period, i) => {
      const charge = Number.isFinite(charges[i])
        ? Math.max(0, Math.round(charges[i]!))
        : null;
      if (charge !== null) {
        execute(
          this.ctx.storage.sql as never,
          "UPDATE external_revenue_snapshots SET billed_cents = MAX(0, billed_cents - ?) WHERE space_id = ? AND period = ? AND provider = ?",
          charge,
          spaceId,
          period,
          provider
        );
      } else {
        execute(
          this.ctx.storage.sql as never,
          "UPDATE external_revenue_snapshots SET billed_cents = 0 WHERE space_id = ? AND period = ? AND provider = ?",
          spaceId,
          period,
          provider
        );
      }
      execute(
        this.ctx.storage.sql as never,
        "UPDATE external_revenue_snapshots SET billed = CASE WHEN billed_cents > 0 THEN 1 ELSE 0 END WHERE space_id = ? AND period = ? AND provider = ?",
        spaceId,
        period,
        provider
      );
    });
    return Response.json({
      space_id: spaceId,
      provider,
      unbilled_periods: periods,
    });
  }

  // F-31: mark periods as having an in-flight surcharge checkout (skipped for ~24h so two checkouts
  // minted before either is paid don't both bill the same periods). The billing worker calls this
  // right after minting a checkout URL. Cleared on pay (mark-billed) or refund. A stale pending
  // (>24h) is treated as abandoned and re-billable by the checkout's own filter.
  private async markRevenuePending(request: Request): Promise<Response> {
    const body = await request
      .json<{ space_id?: string; periods?: string[]; provider?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const spaceId = body.space_id ?? "";
    const provider = body.provider ?? "whop";
    const periods = Array.isArray(body.periods)
      ? body.periods.filter((p) => /^\d{4}-\d{2}$/.test(p))
      : [];
    if (!spaceId || periods.length === 0) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "space_id and at least one valid period are required",
        },
        { status: 400 }
      );
    }
    for (const period of periods) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE external_revenue_snapshots SET pending_checkout_at = datetime('now') WHERE space_id = ? AND period = ? AND provider = ?",
        spaceId,
        period,
        provider
      );
    }
    return Response.json({
      space_id: spaceId,
      provider,
      pending_periods: periods,
    });
  }

  private getWalletBalance(projectId: string): Response {
    const project = this.requireWalletProject(projectId);
    if (!project)
      return Response.json(
        { error_code: "not_found", message: "Not a wallet project" },
        { status: 404 }
      );
    // `credited_cents` is what makes a NEVER-FUNDED wallet distinguishable from a DEPLETED one.
    // Both are a zero balance, and the run gate used to block on the balance alone — so a business
    // created five seconds ago, whose wallet is auto-provisioned empty by design, was refused all
    // project-agent work with "top up to keep this agent running" before its owner had done
    // anything. Reproduced live on a real business. See checkProjectWallet in NaelaoAgentDO.
    const credited = queryOne<{ total: number | null }>(
      this.ctx.storage.sql as never,
      "SELECT SUM(delta_cents) AS total FROM wallet_ledger WHERE project_id = ? AND delta_cents > 0",
      projectId
    );
    return Response.json({
      project_id: projectId,
      balance_cents: this.walletBalance(projectId),
      credited_cents: credited?.total ?? 0,
      currency: "USD",
    });
  }

  private async creditWallet(
    projectId: string,
    request: Request
  ): Promise<Response> {
    const project = this.requireWalletProject(projectId);
    if (!project)
      return Response.json(
        { error_code: "not_found", message: "Not a wallet project" },
        { status: 404 }
      );
    const tenantId = new URL(request.url).searchParams.get("tenant_id") ?? "";
    const body = await request
      .json<{
        cents?: number;
        reason?: string;
        idempotency_key?: string;
        currency?: string;
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (!Number.isFinite(body.cents) || (body.cents ?? 0) <= 0) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "cents must be a positive number",
        },
        { status: 400 }
      );
    }
    // walletBalance/getWalletBalance sum delta_cents across the whole ledger with no currency
    // filter — a single-currency ledger (USD only) is the only thing that's actually correct
    // today. Rather than silently accept a non-USD row that a currency-blind SUM would then
    // conflate with USD balances (cf. the builder-payout multi-currency bug, item 39), reject it
    // outright with a clear error until multi-currency wallets are actually built (which would
    // need per-currency balances/gates, not just a per-row column).
    if (body.currency && body.currency !== "USD") {
      return Response.json(
        {
          error_code: "unsupported_currency",
          message: "Wallet ledger is single-currency (USD) only",
        },
        { status: 400 }
      );
    }
    if (body.idempotency_key) {
      const existing = queryOne<{ balance_after_cents: number }>(
        this.ctx.storage.sql as never,
        "SELECT balance_after_cents FROM wallet_ledger WHERE project_id = ? AND idempotency_key = ?",
        projectId,
        body.idempotency_key
      );
      if (existing)
        return Response.json({
          balance_cents: existing.balance_after_cents,
          deduplicated: true,
        });
    }
    const credit = Math.floor(body.cents!);
    const balanceAfter = this.walletBalance(projectId) + credit;
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO wallet_ledger (id, project_id, space_id, delta_cents, currency, reason, balance_after_cents, idempotency_key)
       VALUES (?, ?, ?, ?, 'USD', ?, ?, ?)`,
      crypto.randomUUID(),
      projectId,
      project.space_id,
      credit,
      body.reason ?? "top_up",
      balanceAfter,
      body.idempotency_key ?? null
    );
    await this.fireMatchingTriggers(
      {
        type: "wallet.credited",
        space_id: project.space_id,
        project_id: projectId,
        occurred_at: Date.now(),
        payload: { cents: credit, balance_cents: balanceAfter },
      },
      tenantId
    );
    await broadcastSpaceEvent(
      this.env,
      tenantId,
      project.space_id,
      "wallet.credited",
      { project_id: projectId, balance_cents: balanceAfter }
    );
    return Response.json({ balance_cents: balanceAfter }, { status: 201 });
  }

  // Fails CLOSED: an over-draw is rejected (402), never silently allowed to go negative — same
  // contract as ProductUserDO's /credits/deduct.
  private async debitWallet(
    projectId: string,
    request: Request
  ): Promise<Response> {
    const project = this.requireWalletProject(projectId);
    if (!project)
      return Response.json(
        { error_code: "not_found", message: "Not a wallet project" },
        { status: 404 }
      );
    const tenantId = new URL(request.url).searchParams.get("tenant_id") ?? "";
    const body = await request
      .json<{ cents?: number; reason?: string; idempotency_key?: string }>()
      .catch(() => ({}) as Record<string, never>);
    if (!Number.isFinite(body.cents) || (body.cents ?? 0) <= 0) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "cents must be a positive number",
        },
        { status: 400 }
      );
    }
    if (body.idempotency_key) {
      const existing = queryOne<{ balance_after_cents: number }>(
        this.ctx.storage.sql as never,
        "SELECT balance_after_cents FROM wallet_ledger WHERE project_id = ? AND idempotency_key = ?",
        projectId,
        body.idempotency_key
      );
      if (existing)
        return Response.json({
          balance_cents: existing.balance_after_cents,
          deduplicated: true,
        });
    }
    const debit = Math.ceil(body.cents!);
    const balance = this.walletBalance(projectId);
    if (debit > balance) {
      return Response.json(
        { error_code: "insufficient_balance", balance_cents: balance },
        { status: 402 }
      );
    }
    const balanceAfter = balance - debit;
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO wallet_ledger (id, project_id, space_id, delta_cents, currency, reason, balance_after_cents, idempotency_key)
       VALUES (?, ?, ?, ?, 'USD', ?, ?, ?)`,
      crypto.randomUUID(),
      projectId,
      project.space_id,
      -debit,
      body.reason ?? "wallet_charge",
      balanceAfter,
      body.idempotency_key ?? null
    );
    await this.fireMatchingTriggers(
      {
        type: "wallet.debited",
        space_id: project.space_id,
        project_id: projectId,
        occurred_at: Date.now(),
        payload: {
          cents: debit,
          balance_cents: balanceAfter,
          reason: body.reason ?? null,
        },
      },
      tenantId
    );
    await broadcastSpaceEvent(
      this.env,
      tenantId,
      project.space_id,
      "wallet.debited",
      { project_id: projectId, balance_cents: balanceAfter }
    );
    // Low-balance signal (fixed $5 threshold) — lets a builder wire a no-code trigger to prompt
    // a top-up before the wallet actually runs dry and starts rejecting debits.
    if (balanceAfter < 500) {
      await this.fireMatchingTriggers(
        {
          type: "wallet.low_balance",
          space_id: project.space_id,
          project_id: projectId,
          occurred_at: Date.now(),
          payload: { balance_cents: balanceAfter },
        },
        tenantId
      );
    }
    return Response.json({ balance_cents: balanceAfter }, { status: 200 });
  }

  private listWalletHistory(
    projectId: string,
    params: URLSearchParams
  ): Response {
    const project = this.requireWalletProject(projectId);
    if (!project)
      return Response.json(
        { error_code: "not_found", message: "Not a wallet project" },
        { status: 404 }
      );
    const limit = Math.min(
      Number.parseInt(params.get("limit") ?? "50", 10) || 50,
      200
    );
    const rows = queryAll<{
      id: string;
      delta_cents: number;
      currency: string;
      reason: string;
      balance_after_cents: number;
      created_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT id, delta_cents, currency, reason, balance_after_cents, created_at FROM wallet_ledger WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
      projectId,
      limit
    );
    return Response.json({ data: rows });
  }

  // ── project_rules — no-code "after the customer says X, this happens" triggers ─────────
  private listProjectRules(projectId: string): Response {
    const rows = queryAll<{
      id: string;
      project_id: string;
      trigger_pattern: string;
      action: string;
      reply_text: string | null;
      script_name: string | null;
      enabled: number;
      priority: number;
      created_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM project_rules WHERE project_id = ? ORDER BY priority DESC, created_at",
      projectId
    );
    return Response.json({ data: rows, count: rows.length });
  }

  private async createProjectRule(
    projectId: string,
    request: Request
  ): Promise<Response> {
    const project = queryOne<{ id: string; space_id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id, space_id FROM projects WHERE id = ?",
      projectId
    );
    if (!project)
      return Response.json(
        { error_code: "not_found", message: "Project not found" },
        { status: 404 }
      );

    const body = await request
      .json<{
        trigger_pattern: string;
        action: "reply" | "run_script" | "human_takeover";
        reply_text?: string;
        script_name?: string;
        priority?: number;
      }>()
      .catch(() => ({}) as Record<string, never>);

    if (!body.trigger_pattern || !body.action) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "trigger_pattern and action are required",
        },
        { status: 400 }
      );
    }
    if (!["reply", "run_script", "human_takeover"].includes(body.action)) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "action must be 'reply', 'run_script', or 'human_takeover'",
        },
        { status: 400 }
      );
    }
    if (body.action === "reply" && !body.reply_text) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "reply_text is required when action is 'reply'",
        },
        { status: 400 }
      );
    }
    if (body.action === "run_script" && !body.script_name) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "script_name is required when action is 'run_script'",
        },
        { status: 400 }
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO project_rules (id, project_id, space_id, trigger_pattern, action, reply_text, script_name, enabled, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      id,
      projectId,
      project.space_id,
      body.trigger_pattern,
      body.action,
      body.reply_text ?? null,
      body.script_name ?? null,
      body.priority ?? 0,
      now
    );
    return Response.json(
      {
        id,
        project_id: projectId,
        trigger_pattern: body.trigger_pattern,
        action: body.action,
        created_at: now,
      },
      { status: 201 }
    );
  }

  private deleteProjectRule(projectId: string, ruleId: string): Response {
    execute(
      this.ctx.storage.sql as never,
      "DELETE FROM project_rules WHERE id = ? AND project_id = ?",
      ruleId,
      projectId
    );
    return Response.json({ deleted: true });
  }

  // ── Container Marketplace slots (§A1.17 Phase L) ────────────────────────────────────────
  // Catalogue validation (does image_id exist? is it available? does the space's plan allow
  // another slot?) happens at the spaces-worker route level, which owns the cross-worker
  // catalogue lookup (mirrors project templates' own split: SpaceDO is dumb CRUD, the worker
  // layer holds business rules). This DO still enforces a hard sanity ceiling independently —
  // defense in depth, same precedent as reserved-capabilities.ts's belt-and-suspenders checks.
  private static readonly MAX_SLOTS_PER_PROJECT_HARD_CEILING = 10;

  private listContainerSlots(projectId: string): Response {
    const rows = queryAll<{
      id: string;
      project_id: string;
      image_id: string;
      slot_name: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM container_slots WHERE project_id = ? ORDER BY created_at",
      projectId
    );
    return Response.json({ data: rows, count: rows.length });
  }

  private async createContainerSlot(
    projectId: string,
    request: Request
  ): Promise<Response> {
    const project = queryOne<{ id: string; space_id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id, space_id FROM projects WHERE id = ?",
      projectId
    );
    if (!project)
      return Response.json(
        { error_code: "not_found", message: "Project not found" },
        { status: 404 }
      );

    const body = await request
      .json<{ image_id: string; slot_name?: string }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.image_id)
      return Response.json(
        { error_code: "bad_request", message: "image_id is required" },
        { status: 400 }
      );

    const existing = queryAll<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM container_slots WHERE project_id = ?",
      projectId
    );
    if (existing.length >= SpaceDO.MAX_SLOTS_PER_PROJECT_HARD_CEILING) {
      return Response.json(
        {
          error_code: "slot_limit_reached",
          message: `A project may not exceed ${SpaceDO.MAX_SLOTS_PER_PROJECT_HARD_CEILING} container slots`,
        },
        { status: 409 }
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO container_slots (id, project_id, space_id, image_id, slot_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?)`,
      id,
      projectId,
      project.space_id,
      body.image_id,
      body.slot_name ?? "",
      now,
      now
    );
    return Response.json(
      {
        id,
        project_id: projectId,
        image_id: body.image_id,
        status: "provisioning",
        created_at: now,
      },
      { status: 201 }
    );
  }

  private deleteContainerSlot(projectId: string, slotId: string): Response {
    execute(
      this.ctx.storage.sql as never,
      "DELETE FROM container_slots WHERE id = ? AND project_id = ?",
      slotId,
      projectId
    );
    return Response.json({ deleted: true });
  }

  // ── Local-machine-as-container permission grants (§A1.17 Phase M) ───────────────
  // Business-rule validation (grant_type shape, directory/commands requirements) lives in the
  // spaces worker, same split as container-slots above; this DO independently enforces a hard
  // per-space ceiling as defense in depth.
  private static readonly MAX_LOCAL_GRANTS_PER_SPACE_HARD_CEILING = 25;

  // §A1.17 Phase S: filterUserId narrows the list to one user's own grants — the spaces-worker
  // route sets this from the CALLER's own verified identity for a product_end_user (a business
  // member), never a client-supplied field, so one member can't browse another's local-machine
  // grants (directory paths are sensitive). A builder/owner JWT caller sees the whole space's
  // grants unfiltered, unchanged from before this pass.
  // filterProjectId mirrors local-machine.ts's own grant-resolution rule exactly (a grant with
  // project_id NULL applies space-wide/to any project; one with project_id set applies only to
  // that project) — so a project-scoped panel sees the grants that would actually apply to a run
  // in that project, not a naive exact-match that would hide the space-wide ones.
  private listLocalGrants(
    spaceId: string,
    filterUserId?: string,
    filterProjectId?: string
  ): Response {
    const conditions = ["space_id = ?"];
    const params: unknown[] = [spaceId];
    if (filterUserId) {
      conditions.push("user_id = ?");
      params.push(filterUserId);
    }
    if (filterProjectId) {
      conditions.push("(project_id IS NULL OR project_id = ?)");
      params.push(filterProjectId);
    }
    const rows = queryAll<{
      id: string;
      space_id: string;
      project_id: string | null;
      user_id: string;
      grant_type: string;
      directory: string | null;
      commands_json: string;
      created_at: string;
    }>(
      this.ctx.storage.sql as never,
      `SELECT * FROM local_grants WHERE ${conditions.join(" AND ")} ORDER BY created_at`,
      ...params
    );
    const data = rows.map((r) => ({
      ...r,
      commands: JSON.parse(r.commands_json || "[]") as string[],
    }));
    return Response.json({ data, count: data.length });
  }

  private async createLocalGrant(
    spaceId: string,
    request: Request
  ): Promise<Response> {
    const body = await request
      .json<{
        user_id: string;
        grant_type: string;
        directory?: string | null;
        commands?: string[];
        project_id?: string | null;
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.user_id || !body.grant_type) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "user_id and grant_type are required",
        },
        { status: 400 }
      );
    }

    const existing = queryAll<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM local_grants WHERE space_id = ?",
      spaceId
    );
    if (existing.length >= SpaceDO.MAX_LOCAL_GRANTS_PER_SPACE_HARD_CEILING) {
      return Response.json(
        {
          error_code: "grant_limit_reached",
          message: `A space may not exceed ${SpaceDO.MAX_LOCAL_GRANTS_PER_SPACE_HARD_CEILING} local grants`,
        },
        { status: 409 }
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO local_grants (id, space_id, project_id, user_id, grant_type, directory, commands_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      spaceId,
      body.project_id ?? null,
      body.user_id,
      body.grant_type,
      body.directory ?? null,
      JSON.stringify(body.commands ?? []),
      now
    );
    return Response.json(
      {
        id,
        space_id: spaceId,
        project_id: body.project_id ?? null,
        user_id: body.user_id,
        grant_type: body.grant_type,
        created_at: now,
      },
      { status: 201 }
    );
  }

  private deleteLocalGrant(spaceId: string, grantId: string): Response {
    execute(
      this.ctx.storage.sql as never,
      "DELETE FROM local_grants WHERE id = ? AND space_id = ?",
      grantId,
      spaceId
    );
    return Response.json({ deleted: true });
  }

  // ── Space Assistant approval policy ──────────────────────────────────────────
  // "Same access as the owning user, but ask before acting unless the user has explicitly
  // trusted this action." always_ask (default) gates everything except auto_approved_actions;
  // yolo skips asking entirely. User-controlled, never settable by the assistant itself —
  // only this space-worker route (owner-authenticated) can change it.
  private getAssistantPolicy(spaceId: string): Response {
    const row = queryOne<{
      space_id: string;
      approval_mode: string;
      auto_approved_actions: string;
      updated_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM assistant_policy WHERE space_id = ?",
      spaceId
    );
    if (!row) {
      return Response.json({
        space_id: spaceId,
        approval_mode: "always_ask",
        auto_approved_actions: [],
      });
    }
    return Response.json({
      ...row,
      auto_approved_actions: safeJsonParseArr(row.auto_approved_actions),
    });
  }

  private async updateAssistantPolicy(
    spaceId: string,
    request: Request
  ): Promise<Response> {
    const body = await request
      .json<{
        approval_mode?: "always_ask" | "yolo";
        auto_approved_actions?: string[];
      }>()
      .catch(() => ({}) as Record<string, never>);

    if (
      body.approval_mode !== undefined &&
      body.approval_mode !== "always_ask" &&
      body.approval_mode !== "yolo"
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "approval_mode must be 'always_ask' or 'yolo'",
        },
        { status: 400 }
      );
    }

    const existing = queryOne<{
      approval_mode: string;
      auto_approved_actions: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT approval_mode, auto_approved_actions FROM assistant_policy WHERE space_id = ?",
      spaceId
    );
    const approvalMode =
      body.approval_mode ?? existing?.approval_mode ?? "always_ask";
    const autoApproved =
      body.auto_approved_actions ??
      (existing ? safeJsonParseArr(existing.auto_approved_actions) : []);
    const now = new Date().toISOString();

    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO assistant_policy (space_id, approval_mode, auto_approved_actions, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(space_id) DO UPDATE SET approval_mode = excluded.approval_mode, auto_approved_actions = excluded.auto_approved_actions, updated_at = excluded.updated_at`,
      spaceId,
      approvalMode,
      JSON.stringify(autoApproved),
      now
    );
    return this.getAssistantPolicy(spaceId);
  }

  // ── Agent API keys (§A1.17 Phase O) ──────────────────────────────────────────
  // Mirrors BuilderAccountDO's api_keys pattern exactly (hash + short prefix persisted, raw
  // key returned exactly once at mint time and never stored). One space's agent_api_keys table
  // holds keys for every agent provisioned in this space — an agentId is not itself unique
  // cross-space, but this DO only ever sees its own space's rows.
  private async createAgentApiKey(agentId: string): Promise<Response> {
    const id = crypto.randomUUID();
    const rawKey = `nak_${crypto.randomUUID().replace(/-/g, "")}`;
    const keyHash = await sha256Hex(rawKey);
    const keyPrefix = rawKey.slice(0, 11); // "nak_" + 7 chars
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO agent_api_keys (id, agent_id, key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      agentId,
      keyHash,
      keyPrefix,
      now
    );
    return Response.json(
      {
        id,
        agent_id: agentId,
        key: rawKey,
        key_prefix: keyPrefix,
        created_at: now,
      },
      { status: 201 }
    );
  }

  private listAgentApiKeys(agentId: string): Response {
    const rows = queryAll<{
      id: string;
      agent_id: string;
      key_prefix: string;
      last_used_at: string | null;
      revoked_at: string | null;
      created_at: string;
    }>(
      this.ctx.storage.sql as never,
      `SELECT id, agent_id, key_prefix, last_used_at, revoked_at, created_at FROM agent_api_keys WHERE agent_id = ? ORDER BY created_at DESC`,
      agentId
    );
    return Response.json({ data: rows });
  }

  private revokeAgentApiKey(agentId: string, keyId: string): Response {
    execute(
      this.ctx.storage.sql as never,
      "UPDATE agent_api_keys SET revoked_at = ? WHERE id = ? AND agent_id = ? AND revoked_at IS NULL",
      new Date().toISOString(),
      keyId,
      agentId
    );
    return Response.json({ revoked: true, id: keyId });
  }

  /** POST /internal/agent-keys/verify — { space_id, key } -> { valid, agent_id?, approval_mode?,
   *  auto_approved_actions? }. The approval-policy fields are folded into the SAME round trip
   *  the router already makes to verify the key, rather than a second call per request. */
  private async verifyAgentApiKey(request: Request): Promise<Response> {
    const body = await request
      .json<{ space_id?: string; key?: string }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.key || !body.key.startsWith("nak_") || !body.space_id)
      return Response.json({ valid: false });
    const keyHash = await sha256Hex(body.key);
    const row = queryOne<{ id: string; agent_id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id, agent_id FROM agent_api_keys WHERE key_hash = ? AND revoked_at IS NULL",
      keyHash
    );
    if (!row) return Response.json({ valid: false });
    execute(
      this.ctx.storage.sql as never,
      "UPDATE agent_api_keys SET last_used_at = ? WHERE id = ?",
      new Date().toISOString(),
      row.id
    );
    const policy = this.resolveAgentPolicy(body.space_id, row.agent_id);
    return Response.json({ valid: true, agent_id: row.agent_id, ...policy });
  }

  /** Resolve an agent's effective approval policy: its own agent_policy_overrides row if one
   *  exists, else the space-wide assistant_policy row, else the fail-closed default
   *  (always_ask, nothing pre-approved) — same three-step fallback fetchAssistantPolicy already
   *  documents for the Space Assistant itself. */
  private resolveAgentPolicy(
    spaceId: string,
    agentId: string
  ): { approval_mode: "always_ask" | "yolo"; auto_approved_actions: string[] } {
    const override = queryOne<{
      approval_mode: string;
      auto_approved_actions: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT approval_mode, auto_approved_actions FROM agent_policy_overrides WHERE space_id = ? AND agent_id = ?",
      spaceId,
      agentId
    );
    if (override) {
      return {
        approval_mode: override.approval_mode as "always_ask" | "yolo",
        auto_approved_actions: safeJsonParseArr(
          override.auto_approved_actions
        ) as string[],
      };
    }
    const spaceWide = queryOne<{
      approval_mode: string;
      auto_approved_actions: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT approval_mode, auto_approved_actions FROM assistant_policy WHERE space_id = ?",
      spaceId
    );
    if (spaceWide) {
      return {
        approval_mode: spaceWide.approval_mode as "always_ask" | "yolo",
        auto_approved_actions: safeJsonParseArr(
          spaceWide.auto_approved_actions
        ) as string[],
      };
    }
    return { approval_mode: "always_ask", auto_approved_actions: [] };
  }

  private getAgentPolicy(spaceId: string, agentId: string): Response {
    const policy = this.resolveAgentPolicy(spaceId, agentId);
    return Response.json({ space_id: spaceId, agent_id: agentId, ...policy });
  }

  private async updateAgentPolicy(
    spaceId: string,
    agentId: string,
    request: Request
  ): Promise<Response> {
    const body = await request
      .json<{
        approval_mode?: "always_ask" | "yolo";
        auto_approved_actions?: string[];
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (
      body.approval_mode !== undefined &&
      body.approval_mode !== "always_ask" &&
      body.approval_mode !== "yolo"
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "approval_mode must be 'always_ask' or 'yolo'",
        },
        { status: 400 }
      );
    }
    const existing = this.resolveAgentPolicy(spaceId, agentId);
    const approvalMode = body.approval_mode ?? existing.approval_mode;
    const autoApproved =
      body.auto_approved_actions ?? existing.auto_approved_actions;
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO agent_policy_overrides (space_id, agent_id, approval_mode, auto_approved_actions, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(space_id, agent_id) DO UPDATE SET approval_mode = excluded.approval_mode, auto_approved_actions = excluded.auto_approved_actions, updated_at = excluded.updated_at`,
      spaceId,
      agentId,
      approvalMode,
      JSON.stringify(autoApproved),
      now
    );
    return this.getAgentPolicy(spaceId, agentId);
  }

  // ── Threads (spec-canonical) ─────────────────────────────────────────────────
  // A sub-agent run or a channel conversation mirrors in here as an ordinary thread —
  // thread_kind='sub_agent'/'channel' plus parent_thread_id, not a separate concept. Default
  // listing hides them (thread_kind != 'primary') so a project's builder-facing thread list
  // isn't flooded by a 16-way sub-agent fan-out or a busy WhatsApp bot; a project can opt in
  // via show_sub_threads, or any caller can ask for them explicitly via include_sub_threads.
  private listThreads(params: URLSearchParams): Response {
    const spaceId = params.get("space_id") ?? "";
    const projectId = params.get("project_id");
    const viewerId = params.get("viewer_id") ?? "";
    const isSpaceManager = params.get("space_manager") === "1";
    const includeSystem = params.get("include_system") === "true";
    if (projectId) {
      const project = queryOne<{ id: string; space_id: string; visibility: string }>(
        this.ctx.storage.sql as never,
        "SELECT id, space_id, visibility FROM projects WHERE id = ? AND space_id = ? AND status != 'archived'",
        projectId,
        spaceId
      );
      if (
        !project ||
        (project.visibility === "private" &&
          !isSpaceManager &&
          (!viewerId ||
            (this.getProjectMemberRole(projectId, viewerId) === null &&
              !this.isSpaceOwnerOrAdmin(viewerId, project.space_id))))
      ) {
        return Response.json(
          { error_code: "not_found", message: "Project not found" },
          { status: 404 }
        );
      }
    }
    const parentThreadId = params.get("parent_thread_id");
    let showSubThreads = params.get("include_sub_threads") === "true";
    if (!showSubThreads && projectId) {
      const project = queryOne<{ show_sub_threads: number }>(
        this.ctx.storage.sql as never,
        "SELECT show_sub_threads FROM projects WHERE id = ?",
        projectId
      );
      showSubThreads = project?.show_sub_threads === 1;
    }

    const clauses = ["space_id = ?"];
    const args: unknown[] = [spaceId];
    if (projectId) {
      clauses.push("project_id = ?");
      args.push(projectId);
    }
    // An explicit parent_thread_id ask (the shell's "show what the assistant discussed with the
    // agent about this thread" panel, or the assistant's own thread.list op) is always answered
    // in full regardless of the project's show_sub_threads default — the caller named exactly
    // which subthreads it wants, not "give me everything hidden by default".
    if (parentThreadId) {
      clauses.push("parent_thread_id = ?");
      args.push(parentThreadId);
    } else if (!showSubThreads) {
      clauses.push("thread_kind = 'primary'");
    }
    if (!includeSystem) clauses.push("system_internal = 0");
    // Scratchpads never become visible through manager flags or broad project listings.
    if (viewerId) {
      clauses.push("(thread_tier != 'tier_4_scratchpad' OR created_by = ?)");
      args.push(viewerId);
    } else {
      clauses.push("thread_tier != 'tier_4_scratchpad'");
    }

    const rows = queryAll(
      this.ctx.storage.sql as never,
      `SELECT * FROM threads WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 200`,
      ...args
    );
    return Response.json({ data: rows, count: rows.length });
  }

  /**
   * projects.max_threads (0 = unlimited) caps how many "real" conversations a project hosts at
   * once — primary threads and channel sessions, deliberately NOT sub_agent fan-out (that's
   * already bounded by MAX_SUB_AGENTS_PER_SPAWN/ConcurrencyDO, and counting ephemeral
   * orchestration threads toward a builder-facing limit would be surprising). Only archived
   * threads don't count, so archiving old conversations reopens room under the cap.
   */
  private isThreadLimitReached(
    projectId: string | null | undefined,
    kind: string
  ): boolean {
    if (!projectId || kind === "sub_agent") return false;
    const project = queryOne<{ max_threads: number }>(
      this.ctx.storage.sql as never,
      "SELECT max_threads FROM projects WHERE id = ?",
      projectId
    );
    if (!project || project.max_threads <= 0) return false;
    const countRow = queryOne<{ n: number }>(
      this.ctx.storage.sql as never,
      "SELECT COUNT(*) as n FROM threads WHERE project_id = ? AND status = 'active' AND thread_kind IN ('primary','channel')",
      projectId
    );
    return (countRow?.n ?? 0) >= project.max_threads;
  }

  private async createThread(request: Request): Promise<Response> {
    const body = await request
      .json<{
        id?: string;
        space_id: string;
        user_id?: string;
        project_id: string;
        title?: string;
        parent_thread_id?: string;
        thread_kind?: "primary" | "sub_agent" | "channel";
        channel?: string;
        channel_session_id?: string;
        tenant_id?: string;
        session_id?: string;
        thread_tier?: "tier_1_team" | "tier_2_task" | "tier_3_consult" | "tier_4_scratchpad";
        created_by?: string;
        system_internal?: boolean;
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.space_id) {
      return Response.json(
        { error_code: "bad_request", message: "space_id is required" },
        { status: 400 }
      );
    }
    const kind = body.thread_kind ?? "primary";
    if (!["primary", "sub_agent", "channel"].includes(kind)) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "thread_kind must be 'primary', 'sub_agent', or 'channel'",
        },
        { status: 400 }
      );
    }
    const tier = body.thread_tier ?? (kind === "sub_agent" ? "tier_3_consult" : "tier_2_task");
    const validTiers = ["tier_1_team", "tier_2_task", "tier_3_consult", "tier_4_scratchpad"];
    if (!validTiers.includes(tier)) {
      return Response.json({ error_code: "bad_request", message: "invalid thread_tier" }, { status: 400 });
    }
    const createdBy = body.created_by ?? body.user_id ?? null;
    if (tier === "tier_4_scratchpad" && !createdBy) {
      return Response.json({ error_code: "bad_request", message: "Scratchpads require a creating user" }, { status: 400 });
    }
    const systemInternal = tier === "tier_3_consult" ? 1 : body.system_internal ? 1 : 0;
    const id = body.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const tenantId =
      body.tenant_id ?? request.headers.get("x-naelao-tenant-id") ?? "";
    // thread.created only fires for a genuinely NEW thread — never on the idempotent
    // update/re-mirror branches below (a webhook retry or a repeat mirrorThread() call must
    // not re-fire triggers for a thread that already existed).
    const fireCreated = (threadId: string, projectId: string | null) =>
      this.fireMatchingTriggers(
        {
          type: "thread.created",
          space_id: body.space_id,
          ...(projectId ? { project_id: projectId } : {}),
          thread_id: threadId,
          occurred_at: Date.now(),
        },
        tenantId
      );

    if (body.channel_session_id) {
      // Idempotent on channel_session_id — a channel's inbound webhook retries safely and
      // re-mirroring the same session never duplicates its thread. Explicit select-then-
      // insert/update rather than ON CONFLICT: the conflict target is a partial unique index
      // (WHERE channel_session_id IS NOT NULL), which isn't a reliably portable upsert target
      // across SQLite builds — this is unambiguous everywhere.
      const existing = queryOne<{ id: string }>(
        this.ctx.storage.sql as never,
        "SELECT id FROM threads WHERE channel_session_id = ?",
        body.channel_session_id
      );
      if (existing) {
        execute(
          this.ctx.storage.sql as never,
          "UPDATE threads SET updated_at = ? WHERE id = ?",
          now,
          existing.id
        );
        const row = queryOne(
          this.ctx.storage.sql as never,
          "SELECT * FROM threads WHERE id = ?",
          existing.id
        );
        return Response.json(row, { status: 201 });
      }
      if (this.isThreadLimitReached(body.project_id, kind)) {
        return Response.json(
          {
            error_code: "thread_limit_reached",
            message: "This project has reached its configured max_threads",
          },
          { status: 409 }
        );
      }
      execute(
        this.ctx.storage.sql as never,
        `INSERT INTO threads (id, space_id, user_id, project_id, title, status, parent_thread_id, thread_kind, channel, channel_session_id, session_id, created_at, updated_at, thread_tier, created_by, system_internal)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        body.space_id,
        body.user_id ?? null,
        body.project_id ?? null,
        body.title ?? null,
        body.parent_thread_id ?? null,
        kind,
        body.channel ?? null,
        body.channel_session_id,
        body.session_id ?? null,
        now,
        now,
        tier,
        createdBy,
        systemInternal
      );
      await fireCreated(id, body.project_id ?? null);
      const row = queryOne(
        this.ctx.storage.sql as never,
        "SELECT * FROM threads WHERE id = ?",
        id
      );
      return Response.json(row, { status: 201 });
    }

    const existingById = queryOne<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM threads WHERE id = ?",
      id
    );
    if (existingById) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE threads SET updated_at = ? WHERE id = ?",
        now,
        id
      );
    } else {
      if (this.isThreadLimitReached(body.project_id, kind)) {
        return Response.json(
          {
            error_code: "thread_limit_reached",
            message: "This project has reached its configured max_threads",
          },
          { status: 409 }
        );
      }
      execute(
        this.ctx.storage.sql as never,
        `INSERT INTO threads (id, space_id, user_id, project_id, title, status, parent_thread_id, thread_kind, channel, channel_session_id, session_id, created_at, updated_at, thread_tier, created_by, system_internal)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        body.space_id,
        body.user_id ?? null,
        body.project_id ?? null,
        body.title ?? null,
        body.parent_thread_id ?? null,
        kind,
        body.channel ?? null,
        body.channel_session_id ?? null,
        body.session_id ?? null,
        now,
        now,
        tier,
        createdBy,
        systemInternal
      );
      await fireCreated(id, body.project_id ?? null);
    }
    const row = queryOne(
      this.ctx.storage.sql as never,
      "SELECT * FROM threads WHERE id = ?",
      id
    );
    return Response.json(row, { status: 201 });
  }

  private getThread(threadId: string, viewerId = ""): Response {
    const row = queryOne<{ thread_tier: string; created_by: string | null } & Record<string, unknown>>(
      this.ctx.storage.sql as never,
      "SELECT * FROM threads WHERE id = ?",
      threadId
    );
    if (!row || (row.thread_tier === "tier_4_scratchpad" && row.created_by !== viewerId))
      return Response.json(
        { error_code: "not_found", message: "Thread not found" },
        { status: 404 }
      );
    return Response.json(row);
  }

  /**
   * PATCH /threads/:id — rename and/or archive a thread. There is no hard DELETE for a thread,
   * same convention `projects` already established (see updateProject): a thread's messages are
   * real conversation history, and destroying them because someone clicked "delete" is a worse
   * failure mode than leaving an inert archived row behind. `status: 'archived'` is what a
   * "delete this thread" action in the UI (or the assistant's own thread.delete op) actually
   * does — `isThreadLimitReached` already treats an archived thread as not counting toward a
   * project's max_threads, so archiving genuinely frees up room the same way a real delete would.
   */
  private async updateThread(
    threadId: string,
    request: Request
  ): Promise<Response> {
    const body = await request
      .json<{ title?: string; status?: "active" | "archived" }>()
      .catch(() => ({}) as Record<string, never>);
    if (
      body.status !== undefined &&
      body.status !== "active" &&
      body.status !== "archived"
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "status must be 'active' or 'archived'",
        },
        { status: 400 }
      );
    }
    const existing = queryOne<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM threads WHERE id = ?",
      threadId
    );
    if (!existing)
      return Response.json(
        { error_code: "not_found", message: "Thread not found" },
        { status: 404 }
      );

    const sets: string[] = [];
    const args: unknown[] = [];
    if (body.title !== undefined) {
      sets.push("title = ?");
      args.push(body.title);
    }
    if (body.status !== undefined) {
      sets.push("status = ?");
      args.push(body.status);
    }
    if (sets.length === 0) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "nothing to update — provide title and/or status",
        },
        { status: 400 }
      );
    }
    sets.push("updated_at = ?");
    args.push(new Date().toISOString());
    args.push(threadId);
    execute(
      this.ctx.storage.sql as never,
      `UPDATE threads SET ${sets.join(", ")} WHERE id = ?`,
      ...args
    );
    const row = queryOne(
      this.ctx.storage.sql as never,
      "SELECT * FROM threads WHERE id = ?",
      threadId
    );
    return Response.json(row);
  }

  // ── tasks (AVOS plan step 4 — a per-project task DAG) ──────────────────────────────────
  // Deliberately DUMB CRUD: whether a task's dependencies are actually satisfied before it may
  // move to in_progress is a business rule the `tasks` prebuilt script checks BEFORE calling
  // PATCH here (same separation project-coordination.ts's own validateModel/validateAgentId
  // already establish — a business rule lives with the agent-facing caller, not the store).
  private static readonly TASK_STATUSES = [
    "pending",
    "in_progress",
    "completed",
    "blocked",
    "cancelled",
  ] as const;

  private listTasks(params: URLSearchParams): Response {
    const spaceId = params.get("space_id") ?? "";
    const projectId = params.get("project_id");
    const threadId = params.get("thread_id");
    const status = params.get("status");
    const clauses = ["space_id = ?"];
    const args: unknown[] = [spaceId];
    if (projectId) {
      clauses.push("project_id = ?");
      args.push(projectId);
    }
    if (threadId) {
      clauses.push("thread_id = ?");
      args.push(threadId);
    }
    if (status) {
      clauses.push("status = ?");
      args.push(status);
    }
    const rows = queryAll<{ dependencies: string; file_paths?: string }>(
      this.ctx.storage.sql as never,
      `SELECT * FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC LIMIT 200`,
      ...args
    );
    return Response.json({
      data: rows.map((r) => ({
        ...r,
        dependencies: safeJsonParseArr(r.dependencies) as string[],
        file_paths: safeJsonParseArr(r.file_paths ?? "[]") as string[],
      })),
      count: rows.length,
    });
  }

  private async hibernateFiniteProjectIfComplete(taskId: string): Promise<void> {
    const task = queryOne<{ project_id: string | null; space_id: string }>(this.ctx.storage.sql as never,
      "SELECT project_id, space_id FROM tasks WHERE id = ?", taskId);
    if (!task?.project_id) return;
    const project = queryOne<{ lifecycle: string; status: string; name: string }>(this.ctx.storage.sql as never,
      "SELECT lifecycle, status, name FROM projects WHERE id = ?", task.project_id);
    if (!project || project.lifecycle !== "finite" || project.status === "HIBERNATED_COMPLETED") return;
    const remaining = queryOne<{ count: number }>(this.ctx.storage.sql as never,
      "SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND status != 'completed' AND status != 'cancelled'", task.project_id)?.count ?? 0;
    if (remaining !== 0) return;
    const now = new Date().toISOString();
    execute(this.ctx.storage.sql as never,
      "UPDATE projects SET status = 'HIBERNATED_COMPLETED', execution_status = 'HIBERNATED_COMPLETED', last_activity_at = ? WHERE id = ?",
      now, task.project_id);
    execute(this.ctx.storage.sql as never,
      `INSERT INTO notifications (id, space_id, project_id, kind, title, body, severity, related_id)
       VALUES (?, ?, ?, 'project.hibernated', ?, ?, 'info', ?)`,
      crypto.randomUUID(), task.space_id, task.project_id, `${project.name} completed`,
      JSON.stringify({ event: "project.hibernated", milestone: "All project DAG tasks completed", completed_at: now }), task.project_id);
    await this.ctx.storage.deleteAlarm();
    await broadcastSpaceEvent(this.env, "", task.space_id, "project.hibernated", {
      project_id: task.project_id, status: "HIBERNATED_COMPLETED", completed_at: now,
    });
    if (this.env.AGENTS_WORKER) {
      await this.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/projects/hibernate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ spaceId: task.space_id, projectId: task.project_id }),
      })).catch(() => undefined);
    }
  }

  private async createTask(request: Request): Promise<Response> {
    const body = await request
      .json<{
        id?: string;
        space_id: string;
        project_id?: string;
        thread_id?: string;
        title?: string;
        status?: string;
        dependencies?: string[];
        assigned_agent?: string;
        subtask_spec?: string;
        assigned_role?: string;
        model?: string;
        file_paths?: string[];
        budget_tokens?: number;
        prompt_text?: string;
        intent_embedding?: number[];
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.space_id)
      return Response.json(
        { error_code: "bad_request", message: "space_id is required" },
        { status: 400 }
      );
    if (!body.title)
      return Response.json(
        { error_code: "bad_request", message: "title is required" },
        { status: 400 }
      );
    const status = body.status ?? "pending";
    if (
      !SpaceDO.TASK_STATUSES.includes(
        status as (typeof SpaceDO.TASK_STATUSES)[number]
      )
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message: `status must be one of: ${SpaceDO.TASK_STATUSES.join(", ")}`,
        },
        { status: 400 }
      );
    }
    // The creation boundary owns de-duplication: callers cannot accidentally bypass it by
    // forgetting to invoke the advisory endpoint first. Explicit embeddings come from the
    // reasoner's provider; the deterministic lexical vector is the offline-safe fallback.
    if (body.project_id && (body.prompt_text || body.title)) {
      const dedupResponse = await this.checkActiveIntentDeduplication(new Request("http://space/intent-deduplicate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptText: body.prompt_text ?? body.title, projectId: body.project_id, embedding: body.intent_embedding }),
      }));
      const dedup = await dedupResponse.json<{ duplicate?: boolean; existingTaskId?: string; threadId?: string | null; similarity?: number; notice?: string }>();
      if (dedup.duplicate) return Response.json({ ...dedup, status: "DEDUPLICATED" }, { status: 200 });
    }
    const id = body.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO tasks (id, space_id, project_id, thread_id, title, status, dependencies, assigned_agent, subtask_spec, assigned_role, model, file_paths, budget_tokens, prompt_text, intent_embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      body.space_id,
      body.project_id ?? null,
      body.thread_id ?? null,
      body.title,
      status,
      JSON.stringify(
        Array.isArray(body.dependencies) ? body.dependencies.map(String) : []
      ),
      body.assigned_agent ?? null,
      body.subtask_spec ?? null,
      body.assigned_role ?? null,
      body.model ?? null,
      JSON.stringify(Array.isArray(body.file_paths) ? body.file_paths.map(String) : []),
      Math.max(1, Math.min(2000, Number(body.budget_tokens ?? 1800))),
      body.prompt_text ?? body.title,
      Array.isArray(body.intent_embedding) ? JSON.stringify(body.intent_embedding) : null,
      now,
      now
    );
    const row = queryOne<{ dependencies: string; file_paths?: string }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM tasks WHERE id = ?",
      id
    );
    return Response.json(
      { ...row, dependencies: safeJsonParseArr(row!.dependencies) as string[], file_paths: safeJsonParseArr(row!.file_paths ?? "[]") as string[] },
      { status: 201 }
    );
  }

  private async claimTaskLease(taskId: string, request: Request): Promise<Response> {
    const body = await request.json<{ assistantId?: string; assistant_id?: string; ttlMinutes?: number }>().catch(() => ({} as { assistantId?: string; assistant_id?: string; ttlMinutes?: number }));
    const assistantId = body.assistantId ?? body.assistant_id ?? "";
    if (!assistantId) return Response.json({ error_code: "bad_request", message: "assistantId is required" }, { status: 400 });
    const ttl = Math.max(1, Math.min(15, Number(body.ttlMinutes ?? 15)));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 60_000).toISOString();
    const claimed = queryOne<{ claimed_by: string; lease_expires_at: string }>(this.ctx.storage.sql as never,
      `UPDATE tasks SET claimed_by = ?, lease_expires_at = ?, status = 'in_progress', updated_at = ?
       WHERE id = ? AND (claimed_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)
       RETURNING claimed_by, lease_expires_at`,
      assistantId, expiresAt, now.toISOString(), taskId, now.toISOString());
    const row = queryOne<{ claimed_by: string | null; lease_expires_at: string | null; spectator_assistant_ids: string }>(
      this.ctx.storage.sql as never, "SELECT claimed_by, lease_expires_at, spectator_assistant_ids FROM tasks WHERE id = ?", taskId);
    if (!row) return Response.json({ error_code: "not_found", message: "Task not found" }, { status: 404 });
    if (!claimed) {
      const spectators = safeJsonParseArr(row.spectator_assistant_ids).map(String);
      if (!spectators.includes(assistantId)) spectators.push(assistantId);
      execute(this.ctx.storage.sql as never,
        "UPDATE tasks SET spectator_assistant_ids = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(spectators), now.toISOString(), taskId);
      console.info(`[TaskLease] ${assistantId} is spectating task ${taskId}; active lead is ${row.claimed_by ?? "unknown"}`);
      return Response.json({ success: false, claimedBy: row.claimed_by, leaseExpiresAt: row.lease_expires_at, status: "SPECTATING", activeLead: row.claimed_by });
    }
    return Response.json({ success: true, claimedBy: assistantId, leaseExpiresAt: expiresAt, status: "CLAIMED" });
  }

  private async checkActiveIntentDeduplication(request: Request): Promise<Response> {
    const body = await request.json<{ promptText?: string; projectId?: string; embedding?: number[] }>().catch(() => ({} as { promptText?: string; projectId?: string; embedding?: number[] }));
    if (!body.promptText || !body.projectId) return Response.json({ error_code: "bad_request", message: "promptText and projectId are required" }, { status: 400 });
    const embedding = Array.isArray(body.embedding) ? body.embedding : SpaceDO.lexicalIntentEmbedding(body.promptText);
    const rows = queryAll<{ id: string; thread_id: string | null; intent_embedding: string | null; prompt_text: string | null }>(this.ctx.storage.sql as never,
      "SELECT id, thread_id, intent_embedding, prompt_text FROM tasks WHERE project_id = ? AND status IN ('pending','in_progress','blocked')", body.projectId);
    let best: { id: string; thread: string | null; similarity: number } | undefined;
    for (const row of rows) {
      const candidate = row.intent_embedding ? safeJsonParseArr(row.intent_embedding).map(Number) : SpaceDO.lexicalIntentEmbedding(row.prompt_text ?? "");
      const similarity = SpaceDO.cosine(embedding, candidate);
      if (!best || similarity > best.similarity) best = { id: row.id, thread: row.thread_id, similarity };
    }
    if (best && best.similarity > 0.85) return Response.json({ duplicate: true, existingTaskId: best.id, threadId: best.thread, similarity: best.similarity, notice: `Work is already active in task ${best.id}${best.thread ? ` (thread ${best.thread})` : ""}.` });
    return Response.json({ duplicate: false, similarity: best?.similarity ?? 0 });
  }

  private static lexicalIntentEmbedding(text: string): number[] {
    const vector = new Array<number>(256).fill(0);
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let hash = 2166136261;
      for (const char of token) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      vector[(hash >>> 0) % vector.length]! += 1;
    }
    return vector;
  }

  private static cosine(a: number[], b: number[]): number {
    if (!a.length || a.length !== b.length) return 0;
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { const x = a[i] ?? 0, y = b[i] ?? 0; dot += x * y; aa += x * x; bb += y * y; }
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
  }

  private async triggerSponsorRfc(request: Request): Promise<Response> {
    const body = await request.json<{ projectId?: string; conflictingDirectives?: Array<{ sponsorId: string; directive: string }>; title?: string }>().catch(() => ({} as { projectId?: string; conflictingDirectives?: Array<{ sponsorId: string; directive: string }>; title?: string }));
    const directives = body.conflictingDirectives ?? [];
    if (!body.projectId || directives.length < 2 || new Set(directives.map(d => d.sponsorId)).size < 2) {
      return Response.json({ error_code: "bad_request", message: "conflicting directives from at least two sponsors are required" }, { status: 400 });
    }
    const project = queryOne<{ id: string; space_id: string }>(this.ctx.storage.sql as never, "SELECT id, space_id FROM projects WHERE id = ?", body.projectId);
    if (!project) return Response.json({ error_code: "not_found", message: "Project not found" }, { status: 404 });
    const id = crypto.randomUUID();
    const title = body.title?.trim() || "Sponsor alignment required";
    const now = new Date().toISOString();
    execute(this.ctx.storage.sql as never, "UPDATE projects SET execution_status = 'FROZEN_FOR_RFC' WHERE id = ?", body.projectId);
    execute(this.ctx.storage.sql as never, "UPDATE tasks SET status = 'blocked', updated_at = ? WHERE project_id = ? AND status IN ('pending','in_progress')", now, body.projectId);
    execute(this.ctx.storage.sql as never, "INSERT INTO rfcs (id, project_id, title, conflicting_directives_json, status, created_at) VALUES (?, ?, ?, ?, 'OPEN', ?)", id, body.projectId, title, JSON.stringify(directives), now);
    execute(this.ctx.storage.sql as never,
      "INSERT INTO notifications (id, space_id, project_id, kind, title, body, severity, related_id) VALUES (?, ?, ?, 'rfc_discussion_card', ?, ?, 'warning', ?)",
      crypto.randomUUID(), project.space_id, body.projectId, title, JSON.stringify({ type: "RFC_DISCUSSION_CARD", rfc_id: id, directives }), id);
    return Response.json({ id, projectId: body.projectId, status: "OPEN", executionStatus: "FROZEN_FOR_RFC" }, { status: 201 });
  }

  private async updateTask(
    taskId: string,
    request: Request
  ): Promise<Response> {
    const body = await request
      .json<{
        title?: string;
        status?: string;
        dependencies?: string[];
        assigned_agent?: string | null;
      }>()
      .catch(() => ({}) as Record<string, never>);
    const existing = queryOne<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM tasks WHERE id = ?",
      taskId
    );
    if (!existing)
      return Response.json(
        { error_code: "not_found", message: "Task not found" },
        { status: 404 }
      );
    if (
      body.status !== undefined &&
      !SpaceDO.TASK_STATUSES.includes(
        body.status as (typeof SpaceDO.TASK_STATUSES)[number]
      )
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message: `status must be one of: ${SpaceDO.TASK_STATUSES.join(", ")}`,
        },
        { status: 400 }
      );
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    if (body.title !== undefined) {
      sets.push("title = ?");
      args.push(body.title);
    }
    if (body.status !== undefined) {
      sets.push("status = ?");
      args.push(body.status);
    }
    if (body.dependencies !== undefined) {
      sets.push("dependencies = ?");
      args.push(JSON.stringify(body.dependencies.map(String)));
    }
    if (body.assigned_agent !== undefined) {
      sets.push("assigned_agent = ?");
      args.push(body.assigned_agent);
    }
    if (sets.length === 0) {
      return Response.json(
        {
          error_code: "bad_request",
          message:
            "nothing to update — provide title, status, dependencies, and/or assigned_agent",
        },
        { status: 400 }
      );
    }
    sets.push("updated_at = ?");
    args.push(new Date().toISOString());
    args.push(taskId);
    execute(
      this.ctx.storage.sql as never,
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
      ...args
    );
    if (body.status === "completed") await this.hibernateFiniteProjectIfComplete(taskId);
    const row = queryOne<{ dependencies: string }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM tasks WHERE id = ?",
      taskId
    );
    return Response.json({
      ...row,
      dependencies: safeJsonParseArr(row!.dependencies) as string[],
    });
  }

  private deleteTask(taskId: string): Response {
    const existing = queryOne<{ id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id FROM tasks WHERE id = ?",
      taskId
    );
    if (!existing)
      return Response.json(
        { error_code: "not_found", message: "Task not found" },
        { status: 404 }
      );
    execute(
      this.ctx.storage.sql as never,
      "DELETE FROM tasks WHERE id = ?",
      taskId
    );
    return Response.json({ ok: true, deleted: taskId });
  }

  private async createPullRequestCard(request: Request): Promise<Response> {
    const body = await request.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const spaceId = String(body["space_id"] ?? ""), projectId = String(body["project_id"] ?? "");
    const card = body["card"] as Record<string, unknown> | undefined;
    if (!spaceId || !projectId || !card || card["type"] !== "inline_pull_request")
      return Response.json({ error_code: "bad_request", message: "space_id, project_id and inline PR card are required" }, { status: 400 });
    const project = queryOne<{ id: string }>(this.ctx.storage.sql as never, "SELECT id FROM projects WHERE id = ? AND space_id = ? AND status != 'archived'", projectId, spaceId);
    if (!project) return Response.json({ error_code: "not_found", message: "Project not found" }, { status: 404 });
    const room = queryOne<{ id: string }>(this.ctx.storage.sql as never,
      "SELECT id FROM threads WHERE space_id = ? AND project_id = ? AND thread_tier = 'tier_1_team' AND status = 'active' ORDER BY created_at LIMIT 1", spaceId, projectId);
    const id = String(card["id"] ?? crypto.randomUUID()), now = new Date().toISOString();
    execute(this.ctx.storage.sql as never,
      `INSERT INTO pull_request_cards (id, space_id, project_id, thread_id, base_branch, fork_branch, title, author, reasoning, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, spaceId, projectId, room?.id ?? null, String(card["baseBranch"] ?? "main"), String(card["forkBranch"] ?? ""),
      String(card["title"] ?? "Pull request"), String(card["author"] ?? "agent"), String(card["reasoning"] ?? ""), JSON.stringify(card), now, now);
    const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
    await broadcastSpaceEvent(this.env, tenantId, spaceId, "workspace.pull_request", { project_id: projectId, thread_id: room?.id ?? null, card: { ...card, id } });
    return Response.json({ id, thread_id: room?.id ?? null, tier: "tier_1_team", card: { ...card, id } }, { status: 201 });
  }

  private listPullRequestCards(params: URLSearchParams): Response {
    const spaceId = params.get("space_id") ?? "", projectId = params.get("project_id") ?? "";
    const rows = queryAll<{ payload: string; status: string; thread_id: string | null }>(this.ctx.storage.sql as never,
      "SELECT payload, status, thread_id FROM pull_request_cards WHERE space_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 100", spaceId, projectId);
    return Response.json({ data: rows.map((row) => ({ ...JSON.parse(row.payload) as object, status: row.status, thread_id: row.thread_id })) });
  }

  // ── Event triggers (@naelao/events) — no-code "after X happens, run script Y" ─────────────
  private listEventTriggers(params: URLSearchParams): Response {
    const spaceId = params.get("space_id") ?? "";
    const projectId = params.get("project_id");
    const clauses = ["space_id = ?"];
    const args: unknown[] = [spaceId];
    if (projectId) {
      clauses.push("(project_id = ? OR project_id IS NULL)");
      args.push(projectId);
    }
    const rows = queryAll<EventTriggerRow>(
      this.ctx.storage.sql as never,
      `SELECT * FROM event_triggers WHERE ${clauses.join(" AND ")} ORDER BY priority DESC, created_at`,
      ...args
    );
    const data = rows.map(rowToTriggerRule);
    return Response.json({ data, count: data.length });
  }

  private async createEventTrigger(request: Request): Promise<Response> {
    const body = await request
      .json<{
        space_id: string;
        project_id?: string;
        event_type: string;
        condition?: TriggerCondition;
        script_name: string;
        params?: Record<string, unknown>;
        priority?: number;
      }>()
      .catch(() => ({}) as Record<string, never>);

    if (
      !body.space_id ||
      !body.project_id ||
      !body.event_type ||
      !body.script_name
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message:
            "space_id, project_id, event_type, and script_name are required",
        },
        { status: 400 }
      );
    }
    const project = queryOne<{ space_id: string; status: string }>(
      this.ctx.storage.sql as never,
      "SELECT space_id, status FROM projects WHERE id = ?",
      body.project_id
    );
    if (
      !project ||
      project.space_id !== body.space_id ||
      project.status !== "active"
    ) {
      return Response.json(
        { error_code: "not_found", message: "Project not found in this space" },
        { status: 404 }
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO event_triggers (id, space_id, project_id, event_type, condition, script_name, params, enabled, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      id,
      body.space_id,
      body.project_id,
      body.event_type,
      JSON.stringify(body.condition ?? { type: "always" }),
      body.script_name,
      JSON.stringify(body.params ?? {}),
      body.priority ?? 0,
      now
    );
    return Response.json(
      {
        id,
        space_id: body.space_id,
        project_id: body.project_id,
        event_type: body.event_type,
        script_name: body.script_name,
        created_at: now,
      },
      { status: 201 }
    );
  }

  private deleteEventTrigger(spaceId: string, triggerId: string): Response {
    execute(
      this.ctx.storage.sql as never,
      "DELETE FROM event_triggers WHERE id = ? AND space_id = ?",
      triggerId,
      spaceId
    );
    return Response.json({ deleted: true });
  }

  /**
   * Resolves what `last_active_thread_idle` needs: the most recently updated OTHER thread in
   * the SAME scope as the trigger (its project, or the whole space when the trigger is
   * space-wide), excluding the thread that fired the event. Scoped by construction — this
   * query can never see a different project's threads, so a project-scoped trigger can never
   * resolve (and therefore never fire against) a thread outside its own project.
   */
  private resolveLastActiveOtherThread(
    spaceId: string,
    projectId: string | undefined,
    excludeThreadId: string
  ): { id: string; updated_at_ms: number } | undefined {
    const clauses = ["space_id = ?", "id != ?", "thread_kind = 'primary'"];
    const args: unknown[] = [spaceId, excludeThreadId];
    if (projectId) {
      clauses.push("project_id = ?");
      args.push(projectId);
    }
    const row = queryOne<{ id: string; updated_at: string }>(
      this.ctx.storage.sql as never,
      `SELECT id, updated_at FROM threads WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      ...args
    );
    if (!row) return undefined;
    return { id: row.id, updated_at_ms: Date.parse(row.updated_at) };
  }

  /**
   * POST /internal/events/fire body — an external caller (outside this DO) supplying an event
   * for fireMatchingTriggers to evaluate. tenantId comes from the caller's own verified
   * internal token (requireInternalHmac already checked it matches x-naelao-tenant-id before
   * this request reached the DO), same trust boundary as every other internal-only route.
   *
   * Read from the QUERY STRING, not a header — forwardToSpaceDO (workers/spaces/src/index.ts)
   * builds a fresh Request carrying only content-type, the same reason /projects/:projectId's
   * own PATCH route already rides tenant_id on the query string (see that route's own comment).
   * A previous version of this method read x-naelao-tenant-id off request.headers, which
   * forwardToSpaceDO never actually sets — every real call (including the agents worker's
   * scheduled_job.disabled auto-disable event) would 400 here and never fire, undetected by
   * space-fire-external-event.test.ts because that suite calls doInstance.fetch() directly with
   * a hand-set header, never exercising the real HTTP round trip through the worker. Falls back
   * to the header too, in case some future caller reaches this DO directly with one set.
   */
  private async fireExternalEvent(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tenantId =
      request.headers.get("x-naelao-tenant-id") ||
      url.searchParams.get("tenant_id") ||
      "";
    const body = await request.json<{
      type: string;
      space_id: string;
      project_id?: string;
      thread_id?: string;
      occurred_at?: number;
      payload?: Record<string, unknown>;
    }>();
    if (!tenantId || !body.type || !body.space_id) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "type and space_id are required",
        },
        { status: 400 }
      );
    }
    await this.fireMatchingTriggers(
      {
        type: body.type,
        space_id: body.space_id,
        ...(body.project_id ? { project_id: body.project_id } : {}),
        ...(body.thread_id ? { thread_id: body.thread_id } : {}),
        occurred_at: body.occurred_at ?? Date.now(),
        ...(body.payload ? { payload: body.payload } : {}),
      },
      tenantId
    );
    return Response.json({ fired: true });
  }

  /**
   * Evaluates and fires every event_triggers row that matches `event` — best-effort, never
   * blocks or fails the state change (thread/project creation) that produced the event.
   * Firing means calling out to the agents worker's internal script.run route; the actual
   * work is entirely in whatever script the trigger names (@naelao/events: "the action is
   * always run_script, not a new action-type surface to keep in sync with the engine").
   */
  private async fireMatchingTriggers(
    event: EventEnvelope,
    tenantId: string
  ): Promise<void> {
    if (!this.env.AGENTS_WORKER || !tenantId) return;
    try {
      const rows = queryAll<EventTriggerRow>(
        this.ctx.storage.sql as never,
        "SELECT * FROM event_triggers WHERE space_id = ? AND event_type = ? AND enabled = 1",
        event.space_id,
        event.type
      );
      const rules = selectMatchingRules(rows.map(rowToTriggerRule), event);
      for (const rule of rules.slice(0, 5)) {
        // bound worst-case fan-out per single event
        let ctx: ConditionContext = {};
        if (rule.condition.type === "last_active_thread_idle") {
          const other = this.resolveLastActiveOtherThread(
            event.space_id,
            rule.project_id ?? undefined,
            event.thread_id ?? ""
          );
          if (other) ctx = { lastActiveOtherThread: other };
        }
        const result = evaluateCondition(rule.condition, ctx);
        if (!result.matched) continue;
        const params = buildFireParams(rule.action, event, result);
        // B3 fix: the static "x-naelao-internal: spaces-trigger" string was forgeable by
        // anyone who could reach the agents worker directly. Mint the same HMAC token
        // naelao-router's proxyTo attaches, verified by requireInternalHmac on the target route.
        const internalToken = await mintInternalToken(
          this.env.PLATFORM_SECRET,
          tenantId
        );
        await this.env.AGENTS_WORKER.fetch(
          new Request("http://agents-worker/internal/triggers/fire", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-naelao-tenant-id": tenantId,
              "x-naelao-internal-token": internalToken,
            },
            body: JSON.stringify({
              spaceId: event.space_id,
              tenantId,
              scriptName: rule.action.script_name,
              params,
              // The fired script inherits its trigger's own project scoping (e.g. so a
              // project's compact script reads/writes that project's workspace, not the
              // space-wide one) — never the event's, in case a space-wide trigger fires for a
              // project-scoped event.
              ...(rule.project_id ? { projectId: rule.project_id } : {}),
            }),
          })
        );
      }
    } catch {
      /* best-effort — a firing failure must never surface as a failure of the thing that happened */
    }
  }

  // G-AO17: Record a prompt injection attempt for a user and check if they are now rate-limited.
  // Rate limit: 3 attempts within 1 hour triggers block.
  private async recordInjectionAttempt(request: Request): Promise<Response> {
    const body = await request.json<{
      end_user_id: string;
      space_id: string;
    }>();
    if (!body.end_user_id) {
      return Response.json(
        { error_code: "bad_request", message: "end_user_id is required" },
        { status: 400 }
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      "INSERT INTO injection_attempts (id, space_id, end_user_id, detected_at) VALUES (?, ?, ?, ?)",
      id,
      body.space_id ?? "",
      body.end_user_id,
      now
    );

    // Count attempts within the last 1 hour
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const row = queryOne<{ cnt: number }>(
      this.ctx.storage.sql as never,
      "SELECT COUNT(*) as cnt FROM injection_attempts WHERE end_user_id = ? AND detected_at > ?",
      body.end_user_id,
      oneHourAgo
    );
    const count = row?.cnt ?? 0;
    const rateLimited = count >= 3;

    if (rateLimited) {
      // Cache the deny to fast-path future requests
      this.cacheDeny(body.end_user_id, body.space_id ?? "");
    }

    return Response.json({
      recorded: true,
      attempts_last_hour: count,
      rate_limited: rateLimited,
    });
  }

  // ── space registry / hierarchy methods (spec §10 SpaceDO + §49) ──────────────

  // POST /spaces — register/refresh the root space row. Idempotent: the provisioner
  // calls this at step N so the SpaceDO knows its own tenancy + agency_shell. depth=0.
  private async upsertRootSpace(request: Request): Promise<Response> {
    const body = await request.json<{
      id: string;
      name: string;
      space_type: string;
      tenancy_mode?: "single" | "team" | "saas";
      agency_shell?: boolean;
      parent_id?: string | null;
      depth?: number;
      settings?: Record<string, unknown>;
    }>();
    if (!body.id || !body.name || !body.space_type) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "id, name, space_type are required",
        },
        { status: 400 }
      );
    }
    if (body.space_type !== "launchpad") {
      return Response.json(
        {
          error_code: "invalid_hierarchy",
          message: "Only Launchpad spaces are supported",
        },
        { status: 400 }
      );
    }
    if (body.parent_id || (body.depth !== undefined && body.depth !== 0)) {
      return Response.json(
        {
          error_code: "invalid_hierarchy",
          message: "A root space cannot have a parent or non-zero depth",
        },
        { status: 400 }
      );
    }
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO spaces (id, parent_id, name, space_type, tenancy_mode, agency_shell, depth, scenario_type, status, settings, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, 0, NULL, 'active', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         space_type = excluded.space_type,
         tenancy_mode = excluded.tenancy_mode,
         agency_shell = excluded.agency_shell,
         settings = excluded.settings`,
      body.id,
      body.name,
      body.space_type,
      body.tenancy_mode ?? "team",
      body.agency_shell ? 1 : 0,
      JSON.stringify(body.settings ?? {}),
      new Date().toISOString()
    );
    return Response.json(
      { id: body.id, depth: 0, status: "active" },
      { status: 201 }
    );
  }

  private listSpaceRows(): Response {
    const rows = queryAll<SpaceRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM spaces WHERE status != 'deleted' ORDER BY depth ASC, created_at ASC"
    );
    return Response.json({ data: rows.map(this.serializeSpaceRow) });
  }

  // POST /sub-spaces — create an in-DO sub-space (department) for tenancy_mode='team'.
  // Enforces: parent exists, depth <= 2, mixed space_type only when parent.agency_shell,
  // end-user sessions (forceParentType=true) always inherit the parent's space_type.
  private async createSubSpaceRow(request: Request): Promise<Response> {
    const body = await request.json<{
      id?: string;
      parent_id: string;
      name: string;
      space_type?: string;
      scenario_type?: "organizational" | "agency-child" | "user-workspace";
      force_parent_type?: boolean;
      settings?: Record<string, unknown>;
    }>();
    if (!body.parent_id || !body.name) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "parent_id and name are required",
        },
        { status: 400 }
      );
    }

    const parent = queryOne<SpaceRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM spaces WHERE id = ? AND status != 'deleted'",
      body.parent_id
    );
    if (!parent) {
      return Response.json(
        { error_code: "not_found", message: "Parent space not found" },
        { status: 404 }
      );
    }

    if (parent.space_type !== "launchpad") {
      return Response.json(
        {
          error_code: "invalid_hierarchy",
          message: "Departments require a Launchpad parent",
        },
        { status: 400 }
      );
    }
    if (body.space_type && body.space_type !== "launchpad") {
      return Response.json(
        {
          error_code: "invalid_hierarchy",
          message: "Only Launchpad departments are supported",
        },
        { status: 400 }
      );
    }
    // The hierarchy policy is exactly two levels: root plus direct departments.
    if (parent.depth >= 1 || parent.parent_id !== null) {
      return Response.json(
        {
          error_code: "max_depth_exceeded",
          message: "A department cannot have child spaces.",
        },
        { status: 400 }
      );
    }

    // Mixed-type rule (§49): only an agency_shell parent may host a different space_type.
    // End-user-originated requests can never select a type and never create agency shells.
    let effectiveType: string;
    if (body.force_parent_type) {
      effectiveType = parent.space_type;
    } else if (body.space_type && body.space_type !== parent.space_type) {
      if (!parent.agency_shell) {
        return Response.json(
          {
            error_code: "mixed_space_type_not_permitted",
            message:
              `Mixed space types are only permitted when the parent space is an agency shell. ` +
              `Parent ${parent.id} is type '${parent.space_type}'.`,
          },
          { status: 400 }
        );
      }
      effectiveType = body.space_type;
    } else {
      effectiveType = parent.space_type;
    }

    const id = body.id ?? crypto.randomUUID();
    const depth = parent.depth + 1;
    const scenario =
      body.scenario_type ??
      (parent.agency_shell ? "agency-child" : "organizational");
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO spaces (id, parent_id, name, space_type, tenancy_mode, agency_shell, depth, scenario_type, status, settings, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?)`,
      id,
      parent.id,
      body.name,
      effectiveType,
      parent.tenancy_mode,
      depth,
      scenario,
      JSON.stringify(body.settings ?? {}),
      now
    );
    return Response.json(
      {
        id,
        parent_id: parent.id,
        name: body.name,
        space_type: effectiveType,
        depth,
        scenario_type: scenario,
        status: "active",
        created_at: now,
      },
      { status: 201 }
    );
  }

  private getSpaceRow(id: string): Response {
    const row = queryOne<SpaceRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM spaces WHERE id = ?",
      id
    );
    if (!row)
      return Response.json(
        { error_code: "not_found", message: "Space not found" },
        { status: 404 }
      );
    return Response.json(this.serializeSpaceRow(row));
  }

  private async updateSpaceRow(
    id: string,
    request: Request
  ): Promise<Response> {
    const body = await request.json<{
      status?: string;
      name?: string;
      settings?: Record<string, unknown>;
    }>();
    if (
      body.status &&
      !["active", "suspended", "deleted"].includes(body.status)
    ) {
      return Response.json(
        { error_code: "bad_request", message: "Invalid status" },
        { status: 400 }
      );
    }
    execute(
      this.ctx.storage.sql as never,
      `UPDATE spaces SET
         status   = COALESCE(?, status),
         name     = COALESCE(?, name),
         settings = COALESCE(?, settings)
       WHERE id = ?`,
      body.status ?? null,
      body.name ?? null,
      body.settings ? JSON.stringify(body.settings) : null,
      id
    );
    return Response.json({ id, updated: true });
  }

  private serializeSpaceRow(row: SpaceRow): Record<string, unknown> {
    return {
      ...row,
      agency_shell: row.agency_shell === 1,
      settings: (() => {
        try {
          return JSON.parse(row.settings) as unknown;
        } catch {
          return {};
        }
      })(),
    };
  }

  private getUserPreferences(spaceId: string, userId: string): Response {
    const row = queryOne<{ display_mode: DisplayMode }>(
      this.ctx.storage.sql as never,
      "SELECT display_mode FROM user_settings WHERE space_id = ? AND user_id = ?",
      spaceId,
      userId
    );
    return Response.json({ space_id: spaceId, user_id: userId, display_mode: row?.display_mode ?? "business" });
  }

  private async putUserPreferences(spaceId: string, userId: string, request: Request): Promise<Response> {
    const body = await request.json<{ display_mode?: DisplayMode }>().catch((): { display_mode?: DisplayMode } => ({}));
    if (body.display_mode !== "business" && body.display_mode !== "developer") {
      return Response.json({ error_code: "bad_request", message: "display_mode must be 'business' or 'developer'" }, { status: 400 });
    }
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO user_settings (user_id, space_id, display_mode, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, space_id) DO UPDATE SET display_mode = excluded.display_mode, updated_at = excluded.updated_at`,
      userId,
      spaceId,
      body.display_mode,
      new Date().toISOString()
    );
    return Response.json({ space_id: spaceId, user_id: userId, display_mode: body.display_mode });
  }

  /** Authoritative hierarchy RBAC. Membership is intentionally read only from the requested
   * space and (for a direct department) its direct parent; it is never copied or inferred in the
   * opposite direction, which prevents upward and sibling privilege propagation. */
  private authorizeHierarchy(params: URLSearchParams): Response {
    const userId = params.get("user_id") ?? "";
    const targetId = params.get("target_space_id") ?? "";
    const action =
      params.get("action") ??
      (params.get("requesting_space_id") || params.get("source_space_id")
        ? "read"
        : "manage");
    const requestingSpaceId =
      params.get("requesting_space_id") ?? params.get("source_space_id");

    if (!userId || !targetId) {
      return Response.json(
        {
          permitted: false,
          reason: "user_id and target_space_id are required",
          grant_type: null,
        },
        { status: 400 }
      );
    }
    const target = queryOne<SpaceRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM spaces WHERE id = ? AND status != 'deleted'",
      targetId
    );
    if (
      !target ||
      target.space_type !== "launchpad" ||
      (target.depth === 0) !== (target.parent_id === null)
    ) {
      return Response.json(
        {
          permitted: false,
          reason: "Target is not a valid Launchpad hierarchy space",
        },
        { status: 404 }
      );
    }
    const direct = queryOne<{ role: string }>(
      this.ctx.storage.sql as never,
      "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?",
      target.id,
      userId
    );
    if (
      direct &&
      (direct.role === "owner" ||
        direct.role === "admin" ||
        (action === "read" && direct.role === "member"))
    ) {
      return Response.json({
        permitted: true,
        source_space_id: target.id,
        role: direct.role,
      });
    }
    if (target.depth === 1 && target.parent_id) {
      const parent = queryOne<SpaceRow>(
        this.ctx.storage.sql as never,
        "SELECT * FROM spaces WHERE id = ? AND depth = 0 AND parent_id IS NULL AND status != 'deleted'",
        target.parent_id
      );
      const inherited =
        parent &&
        queryOne<{ role: string }>(
          this.ctx.storage.sql as never,
          "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?",
          parent.id,
          userId
        );
      if (
        inherited &&
        (inherited.role === "owner" || inherited.role === "admin")
      ) {
        return Response.json({
          permitted: true,
          source_space_id: parent.id,
          role: inherited.role,
        });
      }
    }
    if (requestingSpaceId && requestingSpaceId !== target.id) {
      const requesterRole = queryOne<{ role: string }>(
        this.ctx.storage.sql as never,
        "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?",
        requestingSpaceId,
        userId
      );
      if (requesterRole) {
        const resourceId = params.get("resource_id") ?? "*";
        const grant = queryOne<{ id: string; resource_id: string }>(
          this.ctx.storage.sql as never,
          `SELECT id, resource_id FROM cross_space_grants
           WHERE target_space_id = ? AND grantee_space_id = ?
             AND (resource_id = ? OR resource_id = '*')
             AND revoked_at IS NULL AND expires_at > ?
           LIMIT 1`,
          target.id,
          requestingSpaceId,
          resourceId,
          new Date().toISOString()
        );
        if (grant) {
          if (action === "read") {
            return Response.json({
              permitted: true,
              source_space_id: requestingSpaceId,
              resource_id: grant.resource_id,
            });
          }
        }
      }
    }
    return Response.json(
      {
        permitted: false,
        reason:
          "No administrative membership on the space or its direct parent",
      },
      { status: 403 }
    );
  }

  // ── cross-space grants (§49 checkPermission — fail closed) ───────────────────

  private async grantCrossSpace(request: Request): Promise<Response> {
    const body = await request.json<{
      grantee_space_id: string;
      target_space_id: string;
      resource_id: string;
      granted_by: string;
      expires_at: string;
    }>();
    if (
      !body.grantee_space_id || !body.target_space_id || !body.resource_id ||
      !body.granted_by || !body.expires_at
    ) {
      return Response.json(
        {
          error_code: "bad_request",
          message:
            "grantee_space_id, target_space_id, resource_id, granted_by, expires_at are required",
        },
        { status: 400 }
      );
    }
    if (body.grantee_space_id === body.target_space_id) {
      return Response.json(
        {
          error_code: "bad_request",
          message: "Cannot grant a space access to itself",
        },
        { status: 400 }
      );
    }
    if (Number.isNaN(Date.parse(body.expires_at)) || body.expires_at <= new Date().toISOString()) {
      return Response.json(
        { error_code: "bad_request", message: "expires_at must be a future ISO timestamp" },
        { status: 400 }
      );
    }
    const id = crypto.randomUUID();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO cross_space_grants (id, grantee_space_id, target_space_id, resource_id, granted_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      body.grantee_space_id,
      body.target_space_id,
      body.resource_id,
      body.granted_by,
      new Date().toISOString(),
      body.expires_at
    );
    return Response.json({ id, resource_id: body.resource_id }, { status: 201 });
  }

  private listCrossSpaceGrants(params: URLSearchParams): Response {
    const spaceId = params.get("space_id");
    const rows = spaceId
      ? queryAll<CrossSpaceGrantRow>(
          this.ctx.storage.sql as never,
          `SELECT * FROM cross_space_grants
           WHERE (target_space_id = ? OR grantee_space_id = ?) AND revoked_at IS NULL
           ORDER BY created_at DESC`,
          spaceId,
          spaceId
        )
      : queryAll<CrossSpaceGrantRow>(
          this.ctx.storage.sql as never,
          "SELECT * FROM cross_space_grants WHERE revoked_at IS NULL ORDER BY created_at DESC"
        );
    return Response.json({ data: rows });
  }

  private revokeCrossSpace(id: string): Response {
    execute(
      this.ctx.storage.sql as never,
      "UPDATE cross_space_grants SET revoked_at = ? WHERE id = ?",
      new Date().toISOString(),
      id
    );
    return Response.json({ revoked: true, id });
  }

  // GET /cross-space-check — THE CRITICAL PATH (§49). Default DENIED on any error.
  // A user gets access if they are a direct member of the target space, OR a valid
  // (unexpired, unrevoked) grant exists from the requesting space to the target.
  private async checkCrossSpace(params: URLSearchParams): Promise<Response> {
    const userId = params.get("user_id") ?? "";
    const requestingSpaceId = params.get("requesting_space_id") ?? "";
    const targetSpaceId = params.get("target_space_id") ?? "";
    const resourceId = params.get("resource_id") ?? params.get("grant_type") ?? "*";
    const capabilityToken = params.get("capability_token") ?? "";
    const permission = params.get("permission") ?? "read";

    try {
      if (!userId || !targetSpaceId) {
        return Response.json(
          {
            permitted: false,
            reason: "user_id and target_space_id are required",
            grant_type: null,
          },
          { status: 400 }
        );
      }

      // A bearer capability is the only grant accepted across departments. Its signed scope is
      // checked against every requested coordinate; a database grant alone is not transferable.
      if (requestingSpaceId && requestingSpaceId !== targetSpaceId && capabilityToken) {
        const capability = await verifyCapabilityToken(capabilityToken, this.env.PLATFORM_SECRET, {
          granteeSpaceId: requestingSpaceId,
          targetSpaceId,
          resourceId,
          permission,
        });
        if (capability) {
          return Response.json({ permitted: true, reason: "Valid scoped capability token.", resource_id: resourceId });
        }
        return Response.json({ permitted: false, reason: "Invalid, expired, or mismatched capability token.", resource_id: null });
      }

      // Direct membership of the target space → permitted.
      const member = queryOne<{ role: string }>(
        this.ctx.storage.sql as never,
        "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?",
        targetSpaceId,
        userId
      );
      if (member) {
        return Response.json({
          permitted: true,
          reason: `Direct member with role '${member.role}'.`,
          grant_type: null,
        });
      }

      // Valid cross-space grant from requesting → target.
      const now = new Date().toISOString();
      if (!requestingSpaceId) {
        return Response.json({ permitted: false, reason: "requesting_space_id is required", resource_id: null }, { status: 400 });
      }
      if (!capabilityToken) {
        return Response.json({ permitted: false, reason: "A scoped capability token is required for cross-space access.", resource_id: null });
      }
      const grant = queryOne<{ id: string; resource_id: string }>(
        this.ctx.storage.sql as never,
        `SELECT id, resource_id FROM cross_space_grants
         WHERE target_space_id = ? AND grantee_space_id = ?
           AND (resource_id = ? OR resource_id = '*')
           AND revoked_at IS NULL AND expires_at > ?
         LIMIT 1`,
        targetSpaceId,
        requestingSpaceId,
        resourceId,
        now
      );
      if (!grant) {
        return Response.json({
          permitted: false,
          reason: `User ${userId} is not a member of ${targetSpaceId} and no active grant exists from ${requestingSpaceId}.`,
          resource_id: null,
        });
      }
      return Response.json({
        permitted: true,
        reason: `Cross-space grant for '${grant.resource_id}' applies.`,
        resource_id: grant.resource_id,
      });
    } catch (err) {
      // ANY unexpected error → DENIED. Never permit on error.
      console.error(
        "[SpaceDO] checkCrossSpace UNEXPECTED ERROR — defaulting to DENIED",
        err
      );
      return Response.json({
        permitted: false,
        reason: "Permission check failed; access denied as a safety default.",
        grant_type: null,
      });
    }
  }

  /** Register a cron in the owning SpaceDO so every project (and bot identity) uses one
   * authoritative schedule. The project ownership check is in the same serialized state plane
   * as the insert, preventing a cross-space project id from being smuggled into a job. */
  registerProjectCron(input: unknown): Response {
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const spaceId = String(body["space_id"] ?? "");
    const projectId = String(body["project_id"] ?? "");
    const botId = String(body["bot_id"] ?? "");
    const cronExpression = String(body["cron_expression"] ?? "");
    const scriptPath = String(body["script_path"] ?? "");
    if (!spaceId || !projectId || !botId || !scriptPath) {
      return Response.json({ error_code: "invalid_project_cron", message: "space_id, project_id, bot_id, and script_path are required" }, { status: 400 });
    }
    const cronError = validateCronExpression(cronExpression);
    if (cronError) return Response.json({ error_code: "invalid_cron", message: cronError }, { status: 400 });
    const project = queryOne<{ id: string }>(this.ctx.storage.sql as never,
      "SELECT id FROM projects WHERE id = ? AND space_id = ?", projectId, spaceId);
    if (!project) return Response.json({ error_code: "project_not_in_space" }, { status: 404 });
    const now = Date.now();
    const id = typeof body["id"] === "string" && body["id"] ? body["id"] : crypto.randomUUID();
    const nextRun = computeNextRun(cronExpression, now);
    if (nextRun === null) return Response.json({ error_code: "cron_has_no_next_run" }, { status: 400 });
    const nextRunAt = new Date(nextRun).toISOString();
    execute(this.ctx.storage.sql as never,
      `INSERT INTO project_scheduled_jobs
       (id,space_id,project_id,bot_id,cron_expression,script_path,state,next_run_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, id, spaceId, projectId, botId, cronExpression, scriptPath,
      JSON.stringify(body["state"] ?? {}), nextRunAt, new Date(now).toISOString());
    return Response.json({ id, space_id: spaceId, project_id: projectId, bot_id: botId, cron_expression: cronExpression, script_path: scriptPath, next_run_at: nextRunAt }, { status: 201 });
  }

  private getCalendarAvailability(params: URLSearchParams): Response {
    const spaceId = params.get("space_id") ?? "";
    const calendarId = params.get("calendar_id") ?? "primary";
    const start = params.get("start_date") ?? "";
    const end = params.get("end_date") ?? "";
    if (!spaceId || !start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)) {
      return Response.json({ error_code: "invalid_date_range" }, { status: 400 });
    }
    const events = queryAll(this.ctx.storage.sql as never,
      `SELECT id,start_at,end_at,client_details,status FROM space_calendar_events
       WHERE space_id=? AND calendar_id=? AND status='confirmed' AND start_at < ? AND end_at > ? ORDER BY start_at`,
      spaceId, calendarId, end, start);
    return Response.json({ calendar_id: calendarId, start_date: start, end_date: end, busy: events });
  }

  private createCalendarBooking(input: unknown): Response {
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const spaceId = String(body["space_id"] ?? "");
    const calendarId = String(body["calendar_id"] ?? "primary");
    const slot = body["slot"] as { start?: unknown; end?: unknown } | undefined;
    const start = String(slot?.start ?? "");
    const end = String(slot?.end ?? "");
    if (!spaceId || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)) {
      return Response.json({ error_code: "invalid_booking_slot" }, { status: 400 });
    }
    const conflict = queryOne<{ id: string }>(this.ctx.storage.sql as never,
      `SELECT id FROM space_calendar_events WHERE space_id=? AND calendar_id=? AND status='confirmed'
       AND start_at < ? AND end_at > ? LIMIT 1`, spaceId, calendarId, end, start);
    if (conflict) return Response.json({ error_code: "SLOT_ALREADY_BOOKED", booking_id: conflict.id }, { status: 409 });
    const id = crypto.randomUUID();
    execute(this.ctx.storage.sql as never,
      `INSERT INTO space_calendar_events(id,space_id,calendar_id,start_at,end_at,client_details,provider_booking_id,status)
       VALUES(?,?,?,?,?,?,?,'confirmed')`, id, spaceId, calendarId, start, end,
      JSON.stringify(body["client_details"] ?? {}), body["provider_booking_id"] ?? null);
    return Response.json({ id, calendar_id: calendarId, slot: { start, end }, status: "confirmed" }, { status: 201 });
  }

  private cancelCalendarBooking(bookingId: string, params: URLSearchParams): Response {
    const spaceId = params.get("space_id") ?? "";
    const result = this.ctx.storage.sql.exec(
      "UPDATE space_calendar_events SET status='cancelled',updated_at=datetime('now') WHERE id=? AND space_id=? AND status='confirmed'", bookingId, spaceId);
    return Response.json({ cancelled: result.rowsWritten > 0, booking_id: bookingId }, { status: result.rowsWritten > 0 ? 200 : 404 });
  }

  private listExtensions(): Response {
    const rows = queryAll<{ manifest_json: string; installed_by: string; installed_at: string; updated_at: string }>(
      this.ctx.storage.sql as never,
      "SELECT manifest_json,installed_by,installed_at,updated_at FROM installed_extensions ORDER BY extension_id"
    );
    return Response.json({ extensions: rows.map((row) => ({ manifest: JSON.parse(row.manifest_json) as ExtensionManifest, installedBy: row.installed_by, installedAt: row.installed_at, updatedAt: row.updated_at })) });
  }

  private async installExtension(request: Request): Promise<Response> {
    const body = await request.json<{ manifest?: unknown; installedBy?: string }>();
    if (!body.installedBy) return Response.json({ error: "installedBy is required" }, { status: 400 });
    let manifest: ExtensionManifest;
    try { manifest = validateExtensionManifest(body.manifest); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "invalid_extension_manifest" }, { status: 400 }); }
    const now = new Date().toISOString();
    execute(this.ctx.storage.sql as never,
      `INSERT INTO installed_extensions(extension_id,manifest_json,installed_by,installed_at,updated_at)
       VALUES (?,?,?,?,?) ON CONFLICT(extension_id) DO UPDATE SET manifest_json=excluded.manifest_json,installed_by=excluded.installed_by,updated_at=excluded.updated_at`,
      manifest.id, JSON.stringify(manifest), body.installedBy, now, now);
    return Response.json({ installed: true, manifest, installedAt: now }, { status: 201 });
  }

  private uninstallExtension(extensionId: string): Response {
    execute(this.ctx.storage.sql as never, "DELETE FROM installed_extensions WHERE extension_id = ?", extensionId);
    return Response.json({ uninstalled: true, extensionId });
  }

}
