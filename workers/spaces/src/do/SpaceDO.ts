import { DurableObject } from "cloudflare:workers";
import { applyMigrations, queryAll, queryOne, execute } from "@naelao/db";
import type { Migration } from "@naelao/db";
import type { MessageRole } from "@naelao/types";
import {
  selectMatchingRules, evaluateCondition, buildFireParams,
  findPossibleDuplicateProjects, isPresenceFresh, PRESENCE_FRESHNESS_WINDOW_MS,
  getBusinessFeatureKind, isKnownProjectKind, roleMeetsMinimum,
} from "@naelao/events";
import type { TriggerRule, TriggerCondition, EventEnvelope, ConditionContext } from "@naelao/events";
import { mintInternalToken, broadcastSpaceEvent } from "@naelao/http";

function todaySpendKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/** Same shape as BuilderAccountDO's local copy — a raw API key is hashed before it's ever
 *  persisted, never the other way around. Small enough that a shared package isn't worth it
 *  (matches this codebase's existing precedent of small crypto helpers duplicated per-DO). */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
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
    if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") {
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
    action: { type: "run_script", script_name: row.script_name, params: safeJsonParseObj(row.params) },
    enabled: row.enabled === 1,
    priority: row.priority,
  };
}

// ── Schema migrations ────────────────────────────────────────────────────────
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial schema",
    up: `
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA cache_size=-32768;

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
    // (departments, depth 1-2) for tenancy_mode='team'. Sub-spaces share this SQLite and
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
        depth         INTEGER NOT NULL DEFAULT 0 CHECK (depth <= 2),
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
    description: "customer-bot project config + project_rules (no-code triggers)",
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
    description: "thread hierarchy (parent_thread_id, thread_kind) + show_sub_threads config",
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
    description: "assistant_policy (Space Assistant approval mode + auto-approved actions)",
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
    description: "event_triggers (no-code lifecycle triggers, e.g. 'thread created -> compact the idle one')",
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
    description: "presence (heartbeat-based, one row per space+user — who's active where)",
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
    description: "project_spend (authoritative per-project daily spend tally, single-writer)",
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
    description: "agent_api_keys, agent_policy_overrides, messages.author_type/author_id",
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
    description: "project visibility + project_members ACL + exclusive-mode thread locking",
    up: `
      ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private'));
      ALTER TABLE projects ADD COLUMN created_by TEXT;
      ALTER TABLE projects ADD COLUMN exclusive_mode INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN active_thread_id TEXT;
      ALTER TABLE projects ADD COLUMN active_thread_since TEXT;

      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','editor','viewer')),
        added_at   TEXT NOT NULL DEFAULT (datetime('now')),
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
    description: "projects.kind widened to include 'wallet' + wallet_ledger (Launchpad Wallet)",
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
        visibility              TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
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
    description: "external_revenue_snapshots (Whop-native business revenue tracker)",
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
    description: "Business Feature Projects: projects.is_singleton_kind + drop kind CHECK (validate in app against BUSINESS_FEATURE_KIND_REGISTRY) + partial unique index for singleton kinds",
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
        visibility              TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
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
];

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
  granting_space_id: string;
  receiving_space_id: string;
  grant_type: string;
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
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
    this.denyCache.set(`deny:${userId}:${spaceId}`, Date.now() + DENY_CACHE_TTL_MS);
  }

  private invalidateUserCache(userId: string, spaceId: string): void {
    this.denyCache.delete(`deny:${userId}:${spaceId}`);
  }

  private ensureInit(): void {
    if (this.initialized) return;
    applyMigrations(this.ctx.storage.sql as never, MIGRATIONS);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    try {
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
      // PATCH /sessions/:id — update status
      if (method === "PATCH" && sessionMatch?.[1]) {
        return this.updateSession(request, sessionMatch[1]);
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
      const agentDefGetMatch = url.pathname.match(/^\/agent-definitions\/([^/]+)$/);
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
        return this.removeMember(memberMatch[1], url.searchParams.get("space_id") ?? "");
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
      // GET /spaces/:id — fetch a single space row (meta)
      const spaceRowMatch = url.pathname.match(/^\/spaces\/([^/]+)$/);
      if (method === "GET" && spaceRowMatch?.[1]) {
        return this.getSpaceRow(spaceRowMatch[1]);
      }
      // PATCH /spaces/:id — update status / settings (suspend a department, etc.)
      if (method === "PATCH" && spaceRowMatch?.[1]) {
        return this.updateSpaceRow(spaceRowMatch[1], request);
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
        return this.getProject(projectIdMatch[1]);
      }
      // PATCH /projects/:id — configure kind / execution_ceiling / channel_config / spend cap
      if (method === "PATCH" && projectIdMatch?.[1]) {
        return this.updateProject(projectIdMatch[1], request);
      }
      // ── project_members (§A1.17 Phase T1 — real per-project ACL) ───────────────
      const projectMembersMatch = url.pathname.match(/^\/projects\/([^/]+)\/members$/);
      if (method === "GET" && projectMembersMatch?.[1]) {
        return this.listProjectMembers(projectMembersMatch[1]);
      }
      if (method === "POST" && projectMembersMatch?.[1]) {
        return this.addProjectMember(projectMembersMatch[1], request);
      }
      const projectMemberIdMatch = url.pathname.match(/^\/projects\/([^/]+)\/members\/([^/]+)$/);
      if (method === "DELETE" && projectMemberIdMatch?.[1] && projectMemberIdMatch?.[2]) {
        return this.removeProjectMember(projectMemberIdMatch[1], projectMemberIdMatch[2]);
      }
      // POST /projects/:id/activate-thread — hard exclusive-mode lock (§A1.17 Phase T3)
      const activateThreadMatch = url.pathname.match(/^\/projects\/([^/]+)\/activate-thread$/);
      if (method === "POST" && activateThreadMatch?.[1]) {
        return this.activateProjectThread(activateThreadMatch[1], request);
      }
      // ── Launchpad Wallet (kind='wallet' projects only) ─────────────────────────
      const walletBalanceMatch = url.pathname.match(/^\/projects\/([^/]+)\/wallet\/balance$/);
      if (method === "GET" && walletBalanceMatch?.[1]) {
        return this.getWalletBalance(walletBalanceMatch[1]);
      }
      const walletCreditMatch = url.pathname.match(/^\/projects\/([^/]+)\/wallet\/credit$/);
      if (method === "POST" && walletCreditMatch?.[1]) {
        return this.creditWallet(walletCreditMatch[1], request);
      }
      const walletDebitMatch = url.pathname.match(/^\/projects\/([^/]+)\/wallet\/debit$/);
      if (method === "POST" && walletDebitMatch?.[1]) {
        return this.debitWallet(walletDebitMatch[1], request);
      }
      const walletHistoryMatch = url.pathname.match(/^\/projects\/([^/]+)\/wallet\/history$/);
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
      if (method === "POST" && url.pathname === "/revenue-tracking/mark-billed") {
        return this.markRevenueBilled(request);
      }
      if (method === "POST" && url.pathname === "/revenue-tracking/unmark-billed") {
        return this.markRevenueUnbilled(request);
      }
      // ── project-scoped Memory OS Layers 3/4/6 (§A1.17 Phase U) ─────────────────
      const projFactsMatch = url.pathname.match(/^\/projects\/([^/]+)\/memory\/facts$/);
      if (method === "POST" && projFactsMatch?.[1]) return this.rememberProjectFact(projFactsMatch[1], request);
      if (method === "GET" && projFactsMatch?.[1]) return this.recallProjectFacts(projFactsMatch[1], url.searchParams);
      const projFactIdMatch = url.pathname.match(/^\/projects\/([^/]+)\/memory\/facts\/([^/]+)$/);
      if (method === "DELETE" && projFactIdMatch?.[1] && projFactIdMatch?.[2]) return this.deleteProjectFact(projFactIdMatch[1], projFactIdMatch[2]);

      const projFabricBriefMatch = url.pathname.match(/^\/projects\/([^/]+)\/memory\/fabric\/brief$/);
      if (method === "GET" && projFabricBriefMatch?.[1]) return this.briefProjectFabric(projFabricBriefMatch[1], url.searchParams);
      const projFabricMatch = url.pathname.match(/^\/projects\/([^/]+)\/memory\/fabric$/);
      if (method === "POST" && projFabricMatch?.[1]) return this.recordProjectFabric(projFabricMatch[1], request);
      if (method === "GET" && projFabricMatch?.[1]) return this.recallProjectFabric(projFabricMatch[1], url.searchParams);

      const projWikiConceptMatch = url.pathname.match(/^\/projects\/([^/]+)\/memory\/wiki\/([^/]+)$/);
      if (method === "GET" && projWikiConceptMatch?.[1] && projWikiConceptMatch?.[2]) {
        return this.lookupProjectWikiConcept(projWikiConceptMatch[1], decodeURIComponent(projWikiConceptMatch[2]));
      }
      const projWikiMatch = url.pathname.match(/^\/projects\/([^/]+)\/memory\/wiki$/);
      if (method === "POST" && projWikiMatch?.[1]) return this.upsertProjectWikiConcept(projWikiMatch[1], request);
      if (method === "GET" && projWikiMatch?.[1]) return this.searchProjectWiki(projWikiMatch[1], url.searchParams);
      // ── project_rules (no-code "after customer says X" triggers) ──────────────
      const projectRulesMatch = url.pathname.match(/^\/projects\/([^/]+)\/rules$/);
      if (method === "GET" && projectRulesMatch?.[1]) {
        return this.listProjectRules(projectRulesMatch[1]);
      }
      if (method === "POST" && projectRulesMatch?.[1]) {
        return this.createProjectRule(projectRulesMatch[1], request);
      }
      const projectRuleIdMatch = url.pathname.match(/^\/projects\/([^/]+)\/rules\/([^/]+)$/);
      if (method === "DELETE" && projectRuleIdMatch?.[1] && projectRuleIdMatch?.[2]) {
        return this.deleteProjectRule(projectRuleIdMatch[1], projectRuleIdMatch[2]);
      }
      // ── Authoritative per-project daily spend (F9) ─────────────────────────────
      const projectSpendMatch = url.pathname.match(/^\/projects\/([^/]+)\/spend$/);
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
      // ── Container Marketplace slots (§A1.17 Phase L) ───────────────────────────
      const containerSlotsMatch = url.pathname.match(/^\/projects\/([^/]+)\/container-slots$/);
      if (method === "GET" && containerSlotsMatch?.[1]) {
        return this.listContainerSlots(containerSlotsMatch[1]);
      }
      if (method === "POST" && containerSlotsMatch?.[1]) {
        return this.createContainerSlot(containerSlotsMatch[1], request);
      }
      const containerSlotIdMatch = url.pathname.match(/^\/projects\/([^/]+)\/container-slots\/([^/]+)$/);
      if (method === "DELETE" && containerSlotIdMatch?.[1] && containerSlotIdMatch?.[2]) {
        return this.deleteContainerSlot(containerSlotIdMatch[1], containerSlotIdMatch[2]);
      }

      // ── Local-machine-as-container permission grants (§A1.17 Phase M) ─────────
      if (method === "GET" && url.pathname === "/local-grants") {
        return this.listLocalGrants(url.searchParams.get("space_id") ?? "", url.searchParams.get("user_id") ?? undefined);
      }
      if (method === "POST" && url.pathname === "/local-grants") {
        return this.createLocalGrant(url.searchParams.get("space_id") ?? "", request);
      }
      const localGrantIdMatch = url.pathname.match(/^\/local-grants\/([^/]+)$/);
      if (method === "DELETE" && localGrantIdMatch?.[1]) {
        return this.deleteLocalGrant(url.searchParams.get("space_id") ?? "", localGrantIdMatch[1]);
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

      // ── Event triggers (@naelao/events) ────────────────────────────────────────
      // GET /event-triggers?space_id=&project_id=
      if (method === "GET" && url.pathname === "/event-triggers") {
        return this.listEventTriggers(url.searchParams);
      }
      if (method === "POST" && url.pathname === "/event-triggers") {
        return this.createEventTrigger(request);
      }
      const eventTriggerIdMatch = url.pathname.match(/^\/event-triggers\/([^/]+)$/);
      if (method === "DELETE" && eventTriggerIdMatch?.[1]) {
        return this.deleteEventTrigger(url.searchParams.get("space_id") ?? "", eventTriggerIdMatch[1]);
      }

      // ── Space Assistant approval policy ────────────────────────────────────────
      if (method === "GET" && url.pathname === "/assistant-policy") {
        return this.getAssistantPolicy(url.searchParams.get("space_id") ?? "");
      }
      if (method === "PATCH" && url.pathname === "/assistant-policy") {
        return this.updateAssistantPolicy(url.searchParams.get("space_id") ?? "", request);
      }

      // ── Agent API keys (§A1.17 Phase O: "the same API a human can use, attributed to the
      // agent itself") ───────────────────────────────────────────────────────────
      const agentKeysMatch = url.pathname.match(/^\/agents\/([^/]+)\/api-keys$/);
      if (method === "POST" && agentKeysMatch?.[1]) {
        return this.createAgentApiKey(agentKeysMatch[1]);
      }
      if (method === "GET" && agentKeysMatch?.[1]) {
        return this.listAgentApiKeys(agentKeysMatch[1]);
      }
      const agentKeyIdMatch = url.pathname.match(/^\/agents\/([^/]+)\/api-keys\/([^/]+)$/);
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
      const agentPolicyMatch = url.pathname.match(/^\/agents\/([^/]+)\/policy$/);
      if (method === "GET" && agentPolicyMatch?.[1]) {
        return this.getAgentPolicy(url.searchParams.get("space_id") ?? "", agentPolicyMatch[1]);
      }
      if (method === "PATCH" && agentPolicyMatch?.[1]) {
        return this.updateAgentPolicy(url.searchParams.get("space_id") ?? "", agentPolicyMatch[1], request);
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
        return this.getThread(threadIdMatch[1]);
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

  private async createSession(request: Request): Promise<Response> {
    const body = await request.json<{
      space_id: string;
      tenant_id: string;
      end_user_id?: string;
      metadata?: Record<string, unknown>;
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
  private listSessions(params: URLSearchParams): Response {
    const endUserId = params.get("end_user_id");
    const limit = Math.min(Math.max(Number(params.get("limit")) || 20, 1), 100);
    const rows = endUserId
      ? queryAll<SessionRow>(
          this.ctx.storage.sql as never,
          "SELECT * FROM sessions WHERE end_user_id = ? ORDER BY updated_at DESC LIMIT ?",
          endUserId,
          limit
        )
      : queryAll<SessionRow>(
          this.ctx.storage.sql as never,
          "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?",
          limit
        );
    return Response.json({ data: rows, count: rows.length });
  }

  // G-D02: 128 KB hard cap on message content to prevent OOM in DO SQLite
  private static readonly MAX_MESSAGE_CONTENT_BYTES = 131_072;

  // G-AX13: Token bucket rate limit check for a given end_user_id (10 msg/min default)
  private checkUserRateLimit(userId: string): { allowed: boolean; retryAfterMs: number } {
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
    const refilled = Math.min(capacity, currentTokens + elapsedSec * ratePerSec);

    if (refilled < 1) {
      execute(
        this.ctx.storage.sql as never,
        `INSERT OR REPLACE INTO user_rate_limits (user_id, tokens, last_refill_at, capacity, rate_per_sec)
         VALUES (?, ?, ?, ?, ?)`,
        userId, refilled, nowMs, capacity, ratePerSec
      );
      return { allowed: false, retryAfterMs: Math.ceil((1 - refilled) / ratePerSec * 1000) };
    }

    execute(
      this.ctx.storage.sql as never,
      `INSERT OR REPLACE INTO user_rate_limits (user_id, tokens, last_refill_at, capacity, rate_per_sec)
       VALUES (?, ?, ?, ?, ?)`,
      userId, refilled - 1, nowMs, capacity, ratePerSec
    );
    return { allowed: true, retryAfterMs: 0 };
  }

  private async appendMessage(request: Request, sessionId: string): Promise<Response> {
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
    }>();

    // G-D02: Reject oversized messages before writing to SQLite
    const contentBytes = new TextEncoder().encode(body.content ?? "").length;
    if (contentBytes > SpaceDO.MAX_MESSAGE_CONTENT_BYTES) {
      return Response.json(
        { error_code: "payload_too_large", message: `Message content exceeds ${SpaceDO.MAX_MESSAGE_CONTENT_BYTES} byte limit` },
        { status: 413 }
      );
    }

    // G-AX13: Per-user rate limiting — only for end-user "user" role messages
    if (body.role === "user" && body.end_user_id) {
      const rl = this.checkUserRateLimit(body.end_user_id);
      if (!rl.allowed) {
        return Response.json(
          { error_code: "rate_limited", message: "Too many messages — please slow down", retry_after_ms: rl.retryAfterMs },
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

    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_name, token_count, created_at, author_type, author_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sessionId,
      body.role,
      body.content,
      body.tool_call_id ?? null,
      body.tool_name ?? null,
      body.token_count ?? null,
      now,
      authorType,
      authorId
    );

    // Update session updated_at
    execute(
      this.ctx.storage.sql as never,
      "UPDATE sessions SET updated_at = ? WHERE id = ?",
      now,
      sessionId
    );

    return Response.json(
      { id, session_id: sessionId, role: body.role, author_type: authorType, author_id: authorId, created_at: now },
      { status: 201 }
    );
  }

  private getMessages(sessionId: string, params: URLSearchParams): Response {
    const limit = Math.min(parseInt(params.get("limit") ?? "50"), 200);
    const before = params.get("before");
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

    // G-D01: id as tie-breaker ensures stable ordering when messages share a timestamp
    const rows = before
      ? queryAll<MessageRow>(
          this.ctx.storage.sql as never,
          `SELECT * FROM messages WHERE session_id = ? AND created_at < ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          sessionId,
          before,
          limit
        )
      : queryAll<MessageRow>(
          this.ctx.storage.sql as never,
          `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`,
          sessionId,
          limit
        );

    return Response.json({ data: rows, count: rows.length });
  }

  private async updateSession(request: Request, sessionId: string): Promise<Response> {
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

  private async putAgentState(request: Request, sessionId: string): Promise<Response> {
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
        { error_code: "bad_request", message: "user_id and space_id are required" },
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
      return Response.json({ error_code: "bad_request", message: "user_id is required" }, { status: 400 });
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
      return Response.json({ error_code: "bad_request", message: "user_id is required" }, { status: 400 });
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
    console.log(`[gdpr][erasure] user=${userId} sessions=${sessionsDeleted} messages=${messagesDeleted} at=${erasedAt}`);

    return Response.json({ erased: true, sessions_deleted: sessionsDeleted, messages_deleted: messagesDeleted, erased_at: erasedAt });
  }

  // ── agent_definitions methods ────────────────────────────────────────────────

  private listAgentDefinitions(params: URLSearchParams): Response {
    const spaceId = params.get("space_id");
    interface AgentDefRow {
      id: string; space_id: string; name: string; description: string;
      config_json: string; version: number; enabled: number; created_at: string; updated_at: string;
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
    return Response.json({ data: rows.map(r => ({ ...r, config: JSON.parse(r.config_json) as unknown })) });
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
        { error_code: "bad_request", message: "space_id, name, and config are required" },
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
    return Response.json({ id, space_id: body.space_id, name: body.name, created_at: now }, { status: 201 });
  }

  private getAgentDefinition(id: string): Response {
    interface AgentDefRow {
      id: string; space_id: string; name: string; description: string;
      config_json: string; version: number; enabled: number; created_at: string; updated_at: string;
    }
    const row = queryOne<AgentDefRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM agent_definitions WHERE id = ?",
      id
    );
    if (!row) {
      return Response.json({ error_code: "not_found", message: "Agent definition not found" }, { status: 404 });
    }
    return Response.json({ ...row, config: JSON.parse(row.config_json) as unknown });
  }

  private async updateAgentDefinition(id: string, request: Request): Promise<Response> {
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
    execute(this.ctx.storage.sql as never, "DELETE FROM agent_definitions WHERE id = ?", id);
    return Response.json({ deleted: true, id });
  }

  // ── space_members methods ────────────────────────────────────────────────────

  private listMembers(params: URLSearchParams): Response {
    const spaceId = params.get("space_id");
    interface MemberRow { space_id: string; user_id: string; role: string; joined_at: string; }
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
    const body = await request.json<{ space_id: string; user_id: string; role?: string }>();
    if (!body.space_id || !body.user_id) {
      return Response.json(
        { error_code: "bad_request", message: "space_id and user_id are required" },
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
    return Response.json({ space_id: body.space_id, user_id: body.user_id, role: body.role ?? "member" }, { status: 201 });
  }

  private removeMember(userId: string, spaceId: string): Response {
    // G-SEC (found while tracing owner-membership, A1.16.11): this used to DELETE by user_id
    // alone. One SpaceDO can host multiple space rows (a sub-space/department registry, see
    // A1.16.9's threads/agent-definitions gating) — an unscoped delete removed a member from
    // EVERY space in that DO at once, not just the one the caller meant to remove them from.
    if (!spaceId) {
      return Response.json({ error_code: "bad_request", message: "space_id is required" }, { status: 400 });
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
    if (defaultAgentId && allowedAgentIds && allowedAgentIds.length > 0 && !allowedAgentIds.includes(defaultAgentId)) {
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
      id: string; space_id: string; name: string; description: string; status: string;
      default_agent_id: string | null; max_threads: number; allowed_agent_ids: string | null;
      visibility: string; created_by: string | null; created_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT id, space_id, name, description, status, default_agent_id, max_threads, allowed_agent_ids, visibility, created_by, created_at FROM projects WHERE space_id = ? AND status != 'archived' ORDER BY created_at",
      spaceId
    );
    const visible = viewerId
      ? rows.filter((r) => r.visibility !== "private" || this.getProjectMemberRole(r.id, viewerId) !== null || this.isSpaceOwnerOrAdmin(viewerId))
      : rows;
    return Response.json({
      data: visible.map((r) => ({ ...r, allowed_agent_ids: safeJsonParseAgentIds(r.allowed_agent_ids) })),
      count: visible.length,
    });
  }

  private async createProject(request: Request): Promise<Response> {
    const body = await request.json<{
      space_id: string; name: string; description?: string; tenant_id?: string;
      default_agent_id?: string; max_threads?: number; allowed_agent_ids?: string[];
      visibility?: "public" | "private"; created_by?: string; kind?: string;
    }>();
    if (!body.space_id || !body.name) {
      return Response.json({ error_code: "bad_request", message: "space_id and name are required" }, { status: 400 });
    }
    if (body.max_threads !== undefined && (!Number.isInteger(body.max_threads) || body.max_threads < 0)) {
      return Response.json({ error_code: "bad_request", message: "max_threads must be a non-negative integer" }, { status: 400 });
    }
    if (body.visibility !== undefined && body.visibility !== "public" && body.visibility !== "private") {
      return Response.json({ error_code: "bad_request", message: "visibility must be 'public' or 'private'" }, { status: 400 });
    }
    const bindingError = SpaceDO.validateAgentBinding(body.default_agent_id, body.allowed_agent_ids);
    if (bindingError) return Response.json({ error_code: "bad_request", message: bindingError }, { status: 400 });

    // F-33/F-35: `kind` support (default 'workspace', unchanged for existing callers). Validate
    // against the Business Feature Projects registry; role-gate feature kinds; stamp
    // is_singleton_kind so the DB partial unique index (F-32) is the real singleton guarantee.
    const kind = body.kind ?? "workspace";
    if (!isKnownProjectKind(kind)) {
      return Response.json({ error_code: "bad_request", message: `Unknown project kind '${kind}'` }, { status: 400 });
    }
    const featureKind = getBusinessFeatureKind(kind);
    let isSingletonKind = 0;
    if (featureKind) {
      // Role check BEFORE the singleton check, so a non-privileged member gets "not allowed"
      // rather than leaking whether a singleton of this kind already exists. The creator's
      // space-level role is authoritative (created_by → space_members).
      const callerRole = body.created_by
        ? (queryOne<{ role: string }>(this.ctx.storage.sql as never, "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?", body.space_id, body.created_by)?.role ?? "")
        : "owner"; // no created_by (system/provisioner-initiated) → treat as privileged
      if (body.created_by && !roleMeetsMinimum(callerRole, featureKind.minCreationRole)) {
        return Response.json({ error_code: "forbidden", message: `Creating a '${kind}' project requires at least the '${featureKind.minCreationRole}' role` }, { status: 403 });
      }
      isSingletonKind = featureKind.singleton ? 1 : 0;
      // Pre-check for a friendlier 409 (the partial unique index is the real guarantee below).
      if (isSingletonKind) {
        const existing = queryOne<{ id: string }>(
          this.ctx.storage.sql as never,
          "SELECT id FROM projects WHERE space_id = ? AND kind = ? AND is_singleton_kind = 1 AND status = 'active'",
          body.space_id, kind
        );
        if (existing) {
          return Response.json({ error_code: "duplicate_singleton_project", message: `A '${kind}' project already exists for this space`, existing_project_id: existing.id }, { status: 409 });
        }
      }
    }

    // Check BEFORE inserting — createProject is idempotent on (space_id, name), and
    // project.created should only fire on a genuinely NEW project, not a re-run of bootstrap.
    const alreadyExisted = !!queryOne<{ id: string }>(
      this.ctx.storage.sql as never, "SELECT id FROM projects WHERE space_id = ? AND name = ?", body.space_id, body.name
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
      possibleDuplicates = findPossibleDuplicateProjects(body.name, activeProjects);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const allowedAgentIdsJson = body.allowed_agent_ids && body.allowed_agent_ids.length > 0
      ? JSON.stringify(body.allowed_agent_ids)
      : null;
    try {
      execute(
        this.ctx.storage.sql as never,
        `INSERT INTO projects (id, space_id, name, description, status, kind, is_singleton_kind, default_agent_id, max_threads, allowed_agent_ids, visibility, created_by, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(space_id, name) DO NOTHING`,
        id, body.space_id, body.name, body.description ?? "", kind, isSingletonKind, body.default_agent_id ?? null,
        body.max_threads ?? 0, allowedAgentIdsJson, body.visibility ?? "private", body.created_by ?? null, now
      );
    } catch (err) {
      // F-32: the partial unique index (space_id, kind) WHERE is_singleton_kind=1 fired — a
      // concurrent create raced past the pre-check above. Translate to the same 409 with the
      // winner's id so the caller gets a real constraint guarantee, not just an app-level check.
      if (isSingletonKind && /UNIQUE|constraint/i.test((err as Error).message)) {
        const existing = queryOne<{ id: string }>(
          this.ctx.storage.sql as never,
          "SELECT id FROM projects WHERE space_id = ? AND kind = ? AND is_singleton_kind = 1 AND status = 'active'",
          body.space_id, kind
        );
        return Response.json({ error_code: "duplicate_singleton_project", message: `A '${kind}' project already exists for this space`, existing_project_id: existing?.id }, { status: 409 });
      }
      throw err;
    }
    const row = queryOne<{
      id: string; name: string; status: string; default_agent_id: string | null;
      max_threads: number; allowed_agent_ids: string | null; visibility: string; created_by: string | null; created_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT id, name, status, default_agent_id, max_threads, allowed_agent_ids, visibility, created_by, created_at FROM projects WHERE space_id = ? AND name = ?",
      body.space_id, body.name
    );
    // The creator is always an implicit project_members owner — so a private project the creator
    // just made is immediately visible to them in listProjects' viewer_id filter, without a
    // separate follow-up call.
    if (!alreadyExisted && row && body.created_by) {
      execute(
        this.ctx.storage.sql as never,
        `INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)
         ON CONFLICT(project_id, user_id) DO NOTHING`,
        row.id, body.created_by, now
      );
    }
    if (!alreadyExisted && row) {
      const tenantId = body.tenant_id ?? request.headers.get("x-naelao-tenant-id") ?? "";
      // Awaited (not fire-and-forget) — same reasoning as mirrorThread elsewhere in this
      // build: an un-awaited promise can be abandoned mid-flight once this response is sent
      // and the DO's request context is free to tear down. fireMatchingTriggers is itself
      // best-effort/non-throwing, so this never fails project creation.
      await this.fireMatchingTriggers({ type: "project.created", space_id: body.space_id, project_id: row.id, occurred_at: Date.now() }, tenantId);
      // §A1.17 Phase V: live-sync this to any connected client — never blocks/fails project
      // creation (broadcastSpaceEvent is itself best-effort/non-throwing).
      await broadcastSpaceEvent(this.env, tenantId, body.space_id, "project.created", { project_id: row.id, name: row.name });
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
            payload: { new_project_name: row.name, candidates: possibleDuplicates },
          },
          tenantId
        );
      }
    }
    const responseRow = row
      ? { ...row, allowed_agent_ids: safeJsonParseAgentIds(row.allowed_agent_ids) }
      : { id, name: body.name, status: "active", default_agent_id: body.default_agent_id ?? null, max_threads: body.max_threads ?? 0, allowed_agent_ids: body.allowed_agent_ids ?? null, created_at: now };
    return Response.json(
      { ...responseRow, possible_duplicates: possibleDuplicates },
      { status: 201 }
    );
  }

  // ── Presence (space collaboration, A1.8) ────────────────────────────────────
  // Heartbeat-based, not WebSocket-based: a client calls /presence periodically while a member
  // has a project/thread open; listPresence filters by a freshness window so a closed tab or
  // crashed client just ages out rather than appearing present forever.
  private async heartbeatPresence(request: Request): Promise<Response> {
    const body = await request.json<{ space_id: string; user_id: string; project_id?: string; thread_id?: string; tenant_id?: string }>();
    if (!body.space_id || !body.user_id) {
      return Response.json({ error_code: "bad_request", message: "space_id and user_id are required" }, { status: 400 });
    }
    const now = Date.now();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO presence (space_id, user_id, project_id, thread_id, last_seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(space_id, user_id) DO UPDATE SET project_id = excluded.project_id, thread_id = excluded.thread_id, last_seen_at = excluded.last_seen_at`,
      body.space_id, body.user_id, body.project_id ?? null, body.thread_id ?? null, now
    );
    // §A1.17 Phase V: live-sync presence too — online/offline transitions appear live instead of
    // only on the next GET /presence poll. Best-effort, never blocks the heartbeat response.
    await broadcastSpaceEvent(this.env, body.tenant_id ?? "", body.space_id, "presence.heartbeat", {
      user_id: body.user_id, project_id: body.project_id ?? null, thread_id: body.thread_id ?? null,
    });
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
      body.space_id, now - PRESENCE_PRUNE_CUTOFF_MS
    );
    return Response.json({ ok: true, last_seen_at: now });
  }

  private listPresence(params: URLSearchParams): Response {
    const spaceId = params.get("space_id") ?? "";
    const projectId = params.get("project_id");
    const rows = projectId
      ? queryAll<{ user_id: string; project_id: string | null; thread_id: string | null; last_seen_at: number }>(
          this.ctx.storage.sql as never,
          "SELECT user_id, project_id, thread_id, last_seen_at FROM presence WHERE space_id = ? AND project_id = ?",
          spaceId, projectId
        )
      : queryAll<{ user_id: string; project_id: string | null; thread_id: string | null; last_seen_at: number }>(
          this.ctx.storage.sql as never,
          "SELECT user_id, project_id, thread_id, last_seen_at FROM presence WHERE space_id = ?",
          spaceId
        );
    const now = Date.now();
    const active = rows.filter((r) => isPresenceFresh(r.last_seen_at, now));
    return Response.json({ data: active, count: active.length, freshness_window_ms: PRESENCE_FRESHNESS_WINDOW_MS });
  }

  // ── Customer-bot project config (no-code, admin-configured) ─────────────────
  private getProject(projectId: string): Response {
    const row = queryOne<{
      id: string; space_id: string; name: string; description: string; status: string;
      kind: string; execution_ceiling: number; daily_spend_cap_credits: number; channel_config: string;
      default_agent_id: string | null; max_threads: number; allowed_agent_ids: string | null; created_at: string;
    }>(this.ctx.storage.sql as never, "SELECT * FROM projects WHERE id = ?", projectId);
    if (!row) return Response.json({ error_code: "not_found", message: "Project not found" }, { status: 404 });
    return Response.json({ ...row, channel_config: safeJsonParseObj(row.channel_config), allowed_agent_ids: safeJsonParseAgentIds(row.allowed_agent_ids) });
  }

  private async updateProject(projectId: string, request: Request): Promise<Response> {
    const body = await request.json<{
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
    }>().catch(() => ({}) as Record<string, never>);

    const existing = queryOne<{ id: string; space_id: string; default_agent_id: string | null; allowed_agent_ids: string | null }>(
      this.ctx.storage.sql as never, "SELECT id, space_id, default_agent_id, allowed_agent_ids FROM projects WHERE id = ?", projectId
    );
    if (!existing) return Response.json({ error_code: "not_found", message: "Project not found" }, { status: 404 });

    if (body.max_threads !== undefined && (!Number.isInteger(body.max_threads) || body.max_threads < 0)) {
      return Response.json({ error_code: "bad_request", message: "max_threads must be a non-negative integer" }, { status: 400 });
    }
    // Cross-validate against the EFFECTIVE post-patch state, not just what's in this one PATCH
    // body — a caller might only send default_agent_id while allowed_agent_ids stays as
    // whatever's already stored (or vice versa).
    const effectiveDefaultAgentId = body.default_agent_id !== undefined ? body.default_agent_id : existing.default_agent_id;
    const effectiveAllowedAgentIds = body.allowed_agent_ids !== undefined ? body.allowed_agent_ids : safeJsonParseAgentIds(existing.allowed_agent_ids);
    const bindingError = SpaceDO.validateAgentBinding(effectiveDefaultAgentId, effectiveAllowedAgentIds);
    if (bindingError) return Response.json({ error_code: "bad_request", message: bindingError }, { status: 400 });

    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "archived") {
        return Response.json({ error_code: "bad_request", message: "status must be 'active' or 'archived'" }, { status: 400 });
      }
      // Archiving removes a project from listProjects and from dedup candidates (both filter
      // on status != 'archived') without deleting its threads/history.
      execute(this.ctx.storage.sql as never, "UPDATE projects SET status = ? WHERE id = ?", body.status, projectId);
    }
    if (body.kind !== undefined) {
      // F-33: validate against the registry (not a hardcoded set) and stamp is_singleton_kind so
      // the singleton index applies even when kind is set via PATCH (the legacy seedWallet path).
      if (!isKnownProjectKind(body.kind)) {
        return Response.json({ error_code: "bad_request", message: `Unknown project kind '${body.kind}'` }, { status: 400 });
      }
      const fk = getBusinessFeatureKind(body.kind);
      const singleton = fk?.singleton ? 1 : 0;
      if (singleton) {
        const dup = queryOne<{ id: string }>(
          this.ctx.storage.sql as never,
          "SELECT id FROM projects WHERE space_id = ? AND kind = ? AND is_singleton_kind = 1 AND status = 'active' AND id != ?",
          existing.space_id, body.kind, projectId
        );
        if (dup) {
          return Response.json({ error_code: "duplicate_singleton_project", message: `A '${body.kind}' project already exists for this space`, existing_project_id: dup.id }, { status: 409 });
        }
      }
      try {
        execute(this.ctx.storage.sql as never, "UPDATE projects SET kind = ?, is_singleton_kind = ? WHERE id = ?", body.kind, singleton, projectId);
      } catch (err) {
        if (singleton && /UNIQUE|constraint/i.test((err as Error).message)) {
          const dup = queryOne<{ id: string }>(this.ctx.storage.sql as never, "SELECT id FROM projects WHERE space_id = ? AND kind = ? AND is_singleton_kind = 1 AND status = 'active' AND id != ?", existing.space_id, body.kind, projectId);
          return Response.json({ error_code: "duplicate_singleton_project", message: `A '${body.kind}' project already exists for this space`, existing_project_id: dup?.id }, { status: 409 });
        }
        throw err;
      }
    }
    if (body.execution_ceiling !== undefined) {
      if (!Number.isInteger(body.execution_ceiling) || body.execution_ceiling < 1 || body.execution_ceiling > 5) {
        return Response.json({ error_code: "bad_request", message: "execution_ceiling must be an integer 1-5" }, { status: 400 });
      }
      execute(this.ctx.storage.sql as never, "UPDATE projects SET execution_ceiling = ? WHERE id = ?", body.execution_ceiling, projectId);
    }
    if (body.daily_spend_cap_credits !== undefined) {
      execute(this.ctx.storage.sql as never, "UPDATE projects SET daily_spend_cap_credits = ? WHERE id = ?", Math.max(0, body.daily_spend_cap_credits), projectId);
    }
    if (body.channel_config !== undefined) {
      execute(this.ctx.storage.sql as never, "UPDATE projects SET channel_config = ? WHERE id = ?", JSON.stringify(body.channel_config), projectId);
    }
    if (body.name !== undefined) {
      execute(this.ctx.storage.sql as never, "UPDATE projects SET name = ? WHERE id = ?", body.name, projectId);
    }
    if (body.description !== undefined) {
      execute(this.ctx.storage.sql as never, "UPDATE projects SET description = ? WHERE id = ?", body.description, projectId);
    }
    if (body.show_sub_threads !== undefined) {
      execute(this.ctx.storage.sql as never, "UPDATE projects SET show_sub_threads = ? WHERE id = ?", body.show_sub_threads ? 1 : 0, projectId);
    }
    if (body.default_agent_id !== undefined) {
      execute(this.ctx.storage.sql as never, "UPDATE projects SET default_agent_id = ? WHERE id = ?", body.default_agent_id, projectId);
    }
    if (body.max_threads !== undefined) {
      execute(this.ctx.storage.sql as never, "UPDATE projects SET max_threads = ? WHERE id = ?", body.max_threads, projectId);
    }
    if (body.allowed_agent_ids !== undefined) {
      const json = body.allowed_agent_ids && body.allowed_agent_ids.length > 0 ? JSON.stringify(body.allowed_agent_ids) : null;
      execute(this.ctx.storage.sql as never, "UPDATE projects SET allowed_agent_ids = ? WHERE id = ?", json, projectId);
    }
    if (body.visibility !== undefined) {
      if (body.visibility !== "public" && body.visibility !== "private") {
        return Response.json({ error_code: "bad_request", message: "visibility must be 'public' or 'private'" }, { status: 400 });
      }
      execute(this.ctx.storage.sql as never, "UPDATE projects SET visibility = ? WHERE id = ?", body.visibility, projectId);
    }
    if (body.exclusive_mode !== undefined) {
      execute(this.ctx.storage.sql as never, "UPDATE projects SET exclusive_mode = ? WHERE id = ?", body.exclusive_mode ? 1 : 0, projectId);
    }
    // §A1.17 Phase V: live-sync — best-effort, never blocks the PATCH response. tenant_id rides
    // the query string (see the spaces-worker route's comment for why not a header/body field).
    const patchTenantId = new URL(request.url).searchParams.get("tenant_id") ?? "";
    await broadcastSpaceEvent(this.env, patchTenantId, existing.space_id, "project.updated", { project_id: projectId });
    return this.getProject(projectId);
  }

  private isSpaceOwnerOrAdmin(userId: string): boolean {
    if (!userId) return false;
    const row = queryOne<{ role: string }>(this.ctx.storage.sql as never, "SELECT role FROM space_members WHERE user_id = ?", userId);
    return row?.role === "owner" || row?.role === "admin";
  }

  // §A1.17 Phase T1: real per-project membership ACL — a routing/authorization table, not just a
  // "who's active" list (that's `presence`). Role gates member management itself: owner/editor
  // can add/remove, viewer cannot (enforced by the caller passing `actingRole`, resolved from
  // this SAME table one level up, mirroring how `requireBusinessMembership` resolves a role
  // before checking it against a per-route minimum).
  private listProjectMembers(projectId: string): Response {
    const rows = queryAll<{ project_id: string; user_id: string; role: string; added_at: string }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM project_members WHERE project_id = ? ORDER BY added_at",
      projectId
    );
    return Response.json({ data: rows, count: rows.length });
  }

  private getProjectMemberRole(projectId: string, userId: string): "owner" | "editor" | "viewer" | null {
    if (!userId) return null;
    const row = queryOne<{ role: string }>(
      this.ctx.storage.sql as never,
      "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
      projectId, userId
    );
    return (row?.role as "owner" | "editor" | "viewer" | undefined) ?? null;
  }

  private async addProjectMember(projectId: string, request: Request): Promise<Response> {
    const body = await request.json<{ user_id?: string; role?: string }>().catch(() => ({}) as Record<string, never>);
    if (!body.user_id) return Response.json({ error_code: "bad_request", message: "user_id is required" }, { status: 400 });
    const role = body.role ?? "viewer";
    if (!["owner", "editor", "viewer"].includes(role)) {
      return Response.json({ error_code: "bad_request", message: "role must be one of owner, editor, viewer" }, { status: 400 });
    }
    const project = queryOne<{ id: string }>(this.ctx.storage.sql as never, "SELECT id FROM projects WHERE id = ?", projectId);
    if (!project) return Response.json({ error_code: "not_found", message: "Project not found" }, { status: 404 });
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
      projectId, body.user_id, role, new Date().toISOString()
    );
    return Response.json({ project_id: projectId, user_id: body.user_id, role }, { status: 201 });
  }

  private removeProjectMember(projectId: string, userId: string): Response {
    execute(this.ctx.storage.sql as never, "DELETE FROM project_members WHERE project_id = ? AND user_id = ?", projectId, userId);
    return Response.json({ removed: true });
  }

  // §A1.17 Phase T3: hybrid thread locking, hard half. Soft locking (the default) is just the
  // existing `lock` prebuilt used by scripts that mutate shared project state — no engine change
  // needed here. This endpoint is the opt-in hard "exclusive mode": a client acquires the lock
  // when a user opens/focuses a thread (not on every message — see the migration-v23 comment for
  // why message-level enforcement isn't wired), and a DIFFERENT thread trying to activate while
  // one is already active gets a 409 with who holds it, never a silent block — `take_over`
  // reassigns explicitly so this can never deadlock a project.
  private async activateProjectThread(projectId: string, request: Request): Promise<Response> {
    const body = await request.json<{ thread_id?: string; user_id?: string; take_over?: boolean; tenant_id?: string }>().catch(() => ({}) as Record<string, never>);
    if (!body.thread_id) return Response.json({ error_code: "bad_request", message: "thread_id is required" }, { status: 400 });
    const project = queryOne<{ id: string; space_id: string; exclusive_mode: number; active_thread_id: string | null; active_thread_since: string | null }>(
      this.ctx.storage.sql as never, "SELECT id, space_id, exclusive_mode, active_thread_id, active_thread_since FROM projects WHERE id = ?", projectId
    );
    if (!project) return Response.json({ error_code: "not_found", message: "Project not found" }, { status: 404 });

    if (!project.exclusive_mode) {
      return Response.json({ exclusive_mode: false, activated: true, thread_id: body.thread_id });
    }
    if (project.active_thread_id && project.active_thread_id !== body.thread_id && !body.take_over) {
      return Response.json(
        { error_code: "thread_locked", active_thread_id: project.active_thread_id, active_since: project.active_thread_since },
        { status: 409 }
      );
    }
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      "UPDATE projects SET active_thread_id = ?, active_thread_since = ? WHERE id = ?",
      body.thread_id, now, projectId
    );
    // §A1.17 Phase V: live-sync the lock transition — a collaborator viewing this project sees
    // who just took it over without polling. Best-effort, never blocks the activation response.
    await broadcastSpaceEvent(this.env, body.tenant_id ?? "", project.space_id, "thread.activated", { project_id: projectId, thread_id: body.thread_id, user_id: body.user_id ?? null });
    return Response.json({ exclusive_mode: true, activated: true, thread_id: body.thread_id, active_since: now });
  }

  // ── Memory OS project-shared layers (§A1.17 Phase U) ────────────────────────
  // Layers 3 (facts)/4 (fabric)/6 (wiki), promoted here so every agent thread bound to the SAME
  // project shares them — Layer 5 (episodic/semantic) deliberately stays per-(thread,agentId) in
  // NaelaoAgentDO's own memory-os.ts tables, untouched. Mirrors memory-os.ts's own SQL shape and
  // merge logic (LIKE-based text match, trust-score refresh on remember, relevance scoring for
  // fabric) but scoped by project_id instead of user_id — the agents-worker side composes this
  // with the local per-agent store via a hybrid MemoryStore (project-memory-client.ts).

  private async rememberProjectFact(projectId: string, request: Request): Promise<Response> {
    const body = await request.json<{ entity?: string; relation?: string; attribute?: string }>().catch(() => ({}) as Record<string, never>);
    if (!body.entity || !body.relation || !body.attribute) {
      return Response.json({ error_code: "bad_request", message: "entity, relation, and attribute are required" }, { status: 400 });
    }
    const now = new Date().toISOString();
    const existing = queryOne<{ id: string }>(
      this.ctx.storage.sql as never, "SELECT id FROM project_facts WHERE project_id = ? AND entity = ? AND relation = ?",
      projectId, body.entity, body.relation
    );
    if (existing) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE project_facts SET attribute = ?, trust_score = 1.0, updated_at = ? WHERE id = ?",
        body.attribute, now, existing.id
      );
      return Response.json({ id: existing.id });
    }
    const id = crypto.randomUUID();
    execute(
      this.ctx.storage.sql as never,
      "INSERT INTO project_facts (id, project_id, entity, relation, attribute, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, projectId, body.entity, body.relation, body.attribute, now, now
    );
    return Response.json({ id }, { status: 201 });
  }

  private recallProjectFacts(projectId: string, params: URLSearchParams): Response {
    const q = params.get("q") ?? "";
    const limit = Math.min(parseInt(params.get("limit") ?? "5", 10) || 5, 50);
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = queryAll<{ id: string; entity: string; relation: string; attribute: string; trust_score: number }>(
      this.ctx.storage.sql as never,
      `SELECT id, entity, relation, attribute, trust_score FROM project_facts
       WHERE project_id = ? AND (entity LIKE ? ESCAPE '\\' OR relation LIKE ? ESCAPE '\\' OR attribute LIKE ? ESCAPE '\\')
       ORDER BY trust_score DESC LIMIT ?`,
      projectId, like, like, like, limit
    );
    return Response.json({ data: rows });
  }

  private deleteProjectFact(projectId: string, factId: string): Response {
    execute(this.ctx.storage.sql as never, "DELETE FROM project_facts WHERE id = ? AND project_id = ?", factId, projectId);
    return Response.json({ deleted: true });
  }

  private async recordProjectFabric(projectId: string, request: Request): Promise<Response> {
    const body = await request.json<{ session_id?: string; summary?: string; key_insights?: string[] }>().catch(() => ({}) as Record<string, never>);
    if (!body.session_id || !body.summary) {
      return Response.json({ error_code: "bad_request", message: "session_id and summary are required" }, { status: 400 });
    }
    const id = crypto.randomUUID();
    execute(
      this.ctx.storage.sql as never,
      "INSERT INTO project_fabric (id, project_id, session_id, summary, key_insights, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id, projectId, body.session_id, body.summary, JSON.stringify(body.key_insights ?? []), new Date().toISOString()
    );
    return Response.json({ id }, { status: 201 });
  }

  private recallProjectFabric(projectId: string, params: URLSearchParams): Response {
    const q = (params.get("q") ?? "").toLowerCase().trim();
    const limit = Math.min(parseInt(params.get("limit") ?? "5", 10) || 5, 50);
    const rows = queryAll<{ id: string; session_id: string; summary: string; key_insights: string; created_at: string }>(
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
    const data = scored.filter((r) => r.score > 0.7).sort((a, b) => b.score - a.score).slice(0, limit);
    return Response.json({ data });
  }

  private briefProjectFabric(projectId: string, params: URLSearchParams): Response {
    const limit = Math.min(parseInt(params.get("limit") ?? "5", 10) || 5, 50);
    const rows = queryAll<{ id: string; session_id: string; summary: string; key_insights: string; created_at: string }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM project_fabric WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      projectId, limit
    );
    return Response.json({ data: rows });
  }

  private async upsertProjectWikiConcept(projectId: string, request: Request): Promise<Response> {
    const body = await request.json<{ concept?: string; definition?: string; relationships?: string[] }>().catch(() => ({}) as Record<string, never>);
    if (!body.concept || !body.definition) {
      return Response.json({ error_code: "bad_request", message: "concept and definition are required" }, { status: 400 });
    }
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO project_wiki (project_id, concept, definition, relationships, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, concept) DO UPDATE SET definition = excluded.definition, relationships = excluded.relationships, updated_at = excluded.updated_at`,
      projectId, body.concept, body.definition, JSON.stringify(body.relationships ?? []), new Date().toISOString()
    );
    return Response.json({ concept: body.concept });
  }

  private lookupProjectWikiConcept(projectId: string, concept: string): Response {
    const row = queryOne<{ concept: string; definition: string; relationships: string; updated_at: string }>(
      this.ctx.storage.sql as never, "SELECT * FROM project_wiki WHERE project_id = ? AND concept = ?", projectId, concept
    );
    return Response.json({ data: row ?? null });
  }

  private searchProjectWiki(projectId: string, params: URLSearchParams): Response {
    const q = params.get("q") ?? "";
    const limit = Math.min(parseInt(params.get("limit") ?? "5", 10) || 5, 50);
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = queryAll<{ concept: string; definition: string; relationships: string; updated_at: string }>(
      this.ctx.storage.sql as never,
      `SELECT * FROM project_wiki WHERE project_id = ? AND (concept LIKE ? ESCAPE '\\' OR definition LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?`,
      projectId, like, like, limit
    );
    return Response.json({ data: rows });
  }

  // ── Authoritative per-project daily spend (F9) ──────────────────────────────────────────
  // Every agent-DO thread against a project (each its own NaelaoAgentDO instance) debits
  // through this one SpaceDO instead of keeping its own zero-based local tally — single
  // writer, so concurrent threads on the same customer-bot project share one real total.
  private getProjectSpend(projectId: string, params: URLSearchParams): Response {
    const project = queryOne<{ daily_spend_cap_credits: number }>(
      this.ctx.storage.sql as never, "SELECT daily_spend_cap_credits FROM projects WHERE id = ?", projectId
    );
    if (!project) return Response.json({ error_code: "not_found", message: "Project not found" }, { status: 404 });
    const day = params.get("day") ?? todaySpendKey();
    const row = queryOne<{ credits: number }>(
      this.ctx.storage.sql as never, "SELECT credits FROM project_spend WHERE project_id = ? AND day = ?", projectId, day
    );
    const spentToday = row?.credits ?? 0;
    const cap = project.daily_spend_cap_credits;
    return Response.json({ project_id: projectId, day, spent_today: spentToday, cap, capped: cap > 0 && spentToday >= cap });
  }

  // POST /projects/:projectId/spend { credits } — adds `credits` (if any) to today's tally and
  // returns the updated total. Called with credits=0 as a pure pre-run gate check, and again
  // post-run with the actual token cost — both trips serialized through this single DO, so
  // spend recorded by one thread is immediately visible to the next thread's gate check.
  private async debitProjectSpend(projectId: string, request: Request): Promise<Response> {
    const project = queryOne<{ daily_spend_cap_credits: number }>(
      this.ctx.storage.sql as never, "SELECT daily_spend_cap_credits FROM projects WHERE id = ?", projectId
    );
    if (!project) return Response.json({ error_code: "not_found", message: "Project not found" }, { status: 404 });
    const body = await request.json<{ credits?: number }>().catch(() => ({}) as Record<string, never>);
    const credits = typeof body.credits === "number" && body.credits > 0 ? body.credits : 0;
    const day = todaySpendKey();
    if (credits > 0) {
      execute(
        this.ctx.storage.sql as never,
        `INSERT INTO project_spend (project_id, day, credits) VALUES (?, ?, ?)
         ON CONFLICT (project_id, day) DO UPDATE SET credits = credits + excluded.credits`,
        projectId, day, credits
      );
    }
    const row = queryOne<{ credits: number }>(
      this.ctx.storage.sql as never, "SELECT credits FROM project_spend WHERE project_id = ? AND day = ?", projectId, day
    );
    const spentToday = row?.credits ?? 0;
    const cap = project.daily_spend_cap_credits;
    return Response.json({ project_id: projectId, day, spent_today: spentToday, cap, capped: cap > 0 && spentToday >= cap });
  }

  // ── Builder observability surface (security audit follow-up) ───────────────
  // POST /agent-activity — internal only (NaelaoAgentDO posts one row per run completion/
  // failure and per approval request/resolution). Never blocks the caller's own response on a
  // write failure — see NaelaoAgentDO's logAgentActivity, which wraps every call in its own
  // best-effort try/catch, same posture as notifyApprovalRequested.
  private async recordAgentActivity(request: Request): Promise<Response> {
    const body = await request.json<{
      space_id: string;
      project_id?: string | null;
      thread_id?: string | null;
      agent_id: string;
      event_type: "run_completed" | "run_failed" | "approval_requested" | "approval_resolved" | "moderation_blocked";
      summary?: string;
      tokens_used?: number | null;
      cost_credits?: number | null;
    }>().catch(() => null);
    if (!body?.space_id || !body.agent_id || !body.event_type) {
      return Response.json({ error_code: "bad_request", message: "space_id, agent_id, event_type are required" }, { status: 400 });
    }
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO agent_activity_log (id, space_id, project_id, thread_id, agent_id, event_type, summary, tokens_used, cost_credits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), body.space_id, body.project_id ?? null, body.thread_id ?? null,
      body.agent_id, body.event_type, (body.summary ?? "").slice(0, 2000),
      body.tokens_used ?? null, body.cost_credits ?? null
    );
    return Response.json({ ok: true }, { status: 201 });
  }

  // GET /agent-activity?project_id=&limit= — builder-facing paginated read (newest first), gated
  // builder-only at the spaces-worker route (product_end_user callers never reach this).
  private listAgentActivity(params: URLSearchParams): Response {
    const projectId = params.get("project_id");
    const limit = Math.min(Math.max(parseInt(params.get("limit") ?? "50", 10) || 50, 1), 200);
    const rows = projectId
      ? queryAll(
          this.ctx.storage.sql as never,
          "SELECT * FROM agent_activity_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
          projectId, limit
        )
      : queryAll(
          this.ctx.storage.sql as never,
          "SELECT * FROM agent_activity_log ORDER BY created_at DESC LIMIT ?",
          limit
        );
    return Response.json({ data: rows, count: rows.length });
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
      this.ctx.storage.sql as never, "SELECT space_id, kind FROM projects WHERE id = ?", projectId
    );
    if (!row || row.kind !== "wallet") return null;
    return { space_id: row.space_id };
  }

  private walletBalance(projectId: string): number {
    const row = queryOne<{ bal: number | null }>(
      this.ctx.storage.sql as never, "SELECT SUM(delta_cents) AS bal FROM wallet_ledger WHERE project_id = ?", projectId
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
  // prior observation, since more of a period's payments can complete between checks). `billed`
  // defaults to 0 on every upsert of an UNBILLED period; an already-billed period is left alone
  // (billed=1 preserved) unless the revenue figure itself changed, in which case it reverts to
  // unbilled — a corrected/updated revenue figure for an already-charged period should be
  // re-billable, not silently stuck at a stale charged amount forever.
  private async recordExternalRevenue(request: Request): Promise<Response> {
    const body = await request.json<{ space_id?: string; period?: string; provider?: string; revenue_cents?: number }>()
      .catch(() => ({}) as Record<string, never>);
    const spaceId = body.space_id ?? "";
    const period = body.period ?? "";
    const provider = body.provider ?? "whop";
    const revenueCents = Number.isFinite(body.revenue_cents) ? Math.max(0, Math.round(body.revenue_cents!)) : NaN;
    if (!spaceId || !/^\d{4}-\d{2}$/.test(period) || !Number.isFinite(revenueCents)) {
      return Response.json({ error_code: "bad_request", message: "space_id, period ('YYYY-MM'), and revenue_cents are required" }, { status: 400 });
    }

    const existing = queryOne<{ revenue_cents: number; billed: number }>(
      this.ctx.storage.sql as never,
      "SELECT revenue_cents, billed FROM external_revenue_snapshots WHERE space_id = ? AND period = ? AND provider = ?",
      spaceId, period, provider
    );
    const billed = existing && existing.billed === 1 && existing.revenue_cents === revenueCents ? 1 : 0;

    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO external_revenue_snapshots (id, space_id, period, provider, revenue_cents, billed, tracked_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(space_id, period, provider) DO UPDATE SET
         revenue_cents = excluded.revenue_cents, billed = excluded.billed, tracked_at = excluded.tracked_at`,
      crypto.randomUUID(), spaceId, period, provider, revenueCents, billed
    );
    return Response.json({ space_id: spaceId, period, provider, revenue_cents: revenueCents, billed: billed === 1 }, { status: 201 });
  }

  private getExternalRevenue(params: URLSearchParams): Response {
    const spaceId = params.get("space_id") ?? "";
    if (!spaceId) return Response.json({ error_code: "bad_request", message: "space_id is required" }, { status: 400 });
    const provider = params.get("provider") ?? "whop";
    const period = params.get("period");

    if (period) {
      const row = queryOne<{ revenue_cents: number; billed: number; tracked_at: string }>(
        this.ctx.storage.sql as never,
        "SELECT revenue_cents, billed, tracked_at FROM external_revenue_snapshots WHERE space_id = ? AND period = ? AND provider = ?",
        spaceId, period, provider
      );
      if (!row) return Response.json({ space_id: spaceId, period, provider, revenue_cents: 0, billed: false, tracked_at: null });
      return Response.json({ space_id: spaceId, period, provider, revenue_cents: row.revenue_cents, billed: row.billed === 1, tracked_at: row.tracked_at });
    }

    const rows = queryAll<{ period: string; revenue_cents: number; billed: number; tracked_at: string }>(
      this.ctx.storage.sql as never,
      "SELECT period, revenue_cents, billed, tracked_at FROM external_revenue_snapshots WHERE space_id = ? AND provider = ? ORDER BY period DESC LIMIT 24",
      spaceId, provider
    );
    return Response.json({
      space_id: spaceId, provider,
      snapshots: rows.map((r) => ({ period: r.period, revenue_cents: r.revenue_cents, billed: r.billed === 1, tracked_at: r.tracked_at })),
      last_tracked_at: rows[0]?.tracked_at ?? null,
    });
  }

  // Marks specific periods billed after a successful revenue-cut surcharge payment (the billing
  // worker's webhook handler calls this, never the tracker) — distinct from recordExternalRevenue
  // (which upserts a REVENUE OBSERVATION) since this only ever flips the billed flag, never
  // touches revenue_cents. Idempotent: an already-billed period is a no-op.
  private async markRevenueBilled(request: Request): Promise<Response> {
    const body = await request.json<{ space_id?: string; periods?: string[]; provider?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const spaceId = body.space_id ?? "";
    const provider = body.provider ?? "whop";
    const periods = Array.isArray(body.periods) ? body.periods.filter((p) => /^\d{4}-\d{2}$/.test(p)) : [];
    if (!spaceId || periods.length === 0) {
      return Response.json({ error_code: "bad_request", message: "space_id and at least one valid period are required" }, { status: 400 });
    }

    for (const period of periods) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE external_revenue_snapshots SET billed = 1 WHERE space_id = ? AND period = ? AND provider = ?",
        spaceId, period, provider
      );
    }
    return Response.json({ space_id: spaceId, provider, billed_periods: periods });
  }

  // F-29: the inverse of markRevenueBilled — the billing worker calls this when a revenue-cut
  // surcharge payment is refunded, so the periods it covered revert to unbilled and become
  // re-billable on the next checkout. Idempotent: an already-unbilled period is a no-op.
  private async markRevenueUnbilled(request: Request): Promise<Response> {
    const body = await request.json<{ space_id?: string; periods?: string[]; provider?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const spaceId = body.space_id ?? "";
    const provider = body.provider ?? "whop";
    const periods = Array.isArray(body.periods) ? body.periods.filter((p) => /^\d{4}-\d{2}$/.test(p)) : [];
    if (!spaceId || periods.length === 0) {
      return Response.json({ error_code: "bad_request", message: "space_id and at least one valid period are required" }, { status: 400 });
    }
    for (const period of periods) {
      execute(
        this.ctx.storage.sql as never,
        "UPDATE external_revenue_snapshots SET billed = 0 WHERE space_id = ? AND period = ? AND provider = ?",
        spaceId, period, provider
      );
    }
    return Response.json({ space_id: spaceId, provider, unbilled_periods: periods });
  }

  private getWalletBalance(projectId: string): Response {
    const project = this.requireWalletProject(projectId);
    if (!project) return Response.json({ error_code: "not_found", message: "Not a wallet project" }, { status: 404 });
    return Response.json({ project_id: projectId, balance_cents: this.walletBalance(projectId), currency: "USD" });
  }

  private async creditWallet(projectId: string, request: Request): Promise<Response> {
    const project = this.requireWalletProject(projectId);
    if (!project) return Response.json({ error_code: "not_found", message: "Not a wallet project" }, { status: 404 });
    const tenantId = new URL(request.url).searchParams.get("tenant_id") ?? "";
    const body = await request.json<{ cents?: number; reason?: string; idempotency_key?: string; currency?: string }>()
      .catch(() => ({}) as Record<string, never>);
    if (!Number.isFinite(body.cents) || (body.cents ?? 0) <= 0) {
      return Response.json({ error_code: "bad_request", message: "cents must be a positive number" }, { status: 400 });
    }
    if (body.idempotency_key) {
      const existing = queryOne<{ balance_after_cents: number }>(
        this.ctx.storage.sql as never,
        "SELECT balance_after_cents FROM wallet_ledger WHERE project_id = ? AND idempotency_key = ?",
        projectId, body.idempotency_key
      );
      if (existing) return Response.json({ balance_cents: existing.balance_after_cents, deduplicated: true });
    }
    const credit = Math.floor(body.cents!);
    const balanceAfter = this.walletBalance(projectId) + credit;
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO wallet_ledger (id, project_id, space_id, delta_cents, currency, reason, balance_after_cents, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), projectId, project.space_id, credit, body.currency ?? "USD",
      body.reason ?? "top_up", balanceAfter, body.idempotency_key ?? null
    );
    await this.fireMatchingTriggers(
      { type: "wallet.credited", space_id: project.space_id, project_id: projectId, occurred_at: Date.now(), payload: { cents: credit, balance_cents: balanceAfter } },
      tenantId
    );
    await broadcastSpaceEvent(this.env, tenantId, project.space_id, "wallet.credited", { project_id: projectId, balance_cents: balanceAfter });
    return Response.json({ balance_cents: balanceAfter }, { status: 201 });
  }

  // Fails CLOSED: an over-draw is rejected (402), never silently allowed to go negative — same
  // contract as ProductUserDO's /credits/deduct.
  private async debitWallet(projectId: string, request: Request): Promise<Response> {
    const project = this.requireWalletProject(projectId);
    if (!project) return Response.json({ error_code: "not_found", message: "Not a wallet project" }, { status: 404 });
    const tenantId = new URL(request.url).searchParams.get("tenant_id") ?? "";
    const body = await request.json<{ cents?: number; reason?: string; idempotency_key?: string }>()
      .catch(() => ({}) as Record<string, never>);
    if (!Number.isFinite(body.cents) || (body.cents ?? 0) <= 0) {
      return Response.json({ error_code: "bad_request", message: "cents must be a positive number" }, { status: 400 });
    }
    if (body.idempotency_key) {
      const existing = queryOne<{ balance_after_cents: number }>(
        this.ctx.storage.sql as never,
        "SELECT balance_after_cents FROM wallet_ledger WHERE project_id = ? AND idempotency_key = ?",
        projectId, body.idempotency_key
      );
      if (existing) return Response.json({ balance_cents: existing.balance_after_cents, deduplicated: true });
    }
    const debit = Math.ceil(body.cents!);
    const balance = this.walletBalance(projectId);
    if (debit > balance) {
      return Response.json({ error_code: "insufficient_balance", balance_cents: balance }, { status: 402 });
    }
    const balanceAfter = balance - debit;
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO wallet_ledger (id, project_id, space_id, delta_cents, currency, reason, balance_after_cents, idempotency_key)
       VALUES (?, ?, ?, ?, 'USD', ?, ?, ?)`,
      crypto.randomUUID(), projectId, project.space_id, -debit, body.reason ?? "wallet_charge", balanceAfter, body.idempotency_key ?? null
    );
    await this.fireMatchingTriggers(
      { type: "wallet.debited", space_id: project.space_id, project_id: projectId, occurred_at: Date.now(), payload: { cents: debit, balance_cents: balanceAfter, reason: body.reason ?? null } },
      tenantId
    );
    await broadcastSpaceEvent(this.env, tenantId, project.space_id, "wallet.debited", { project_id: projectId, balance_cents: balanceAfter });
    // Low-balance signal (fixed $5 threshold) — lets a builder wire a no-code trigger to prompt
    // a top-up before the wallet actually runs dry and starts rejecting debits.
    if (balanceAfter < 500) {
      await this.fireMatchingTriggers(
        { type: "wallet.low_balance", space_id: project.space_id, project_id: projectId, occurred_at: Date.now(), payload: { balance_cents: balanceAfter } },
        tenantId
      );
    }
    return Response.json({ balance_cents: balanceAfter }, { status: 200 });
  }

  private listWalletHistory(projectId: string, params: URLSearchParams): Response {
    const project = this.requireWalletProject(projectId);
    if (!project) return Response.json({ error_code: "not_found", message: "Not a wallet project" }, { status: 404 });
    const limit = Math.min(parseInt(params.get("limit") ?? "50", 10) || 50, 200);
    const rows = queryAll<{ id: string; delta_cents: number; currency: string; reason: string; balance_after_cents: number; created_at: string }>(
      this.ctx.storage.sql as never,
      "SELECT id, delta_cents, currency, reason, balance_after_cents, created_at FROM wallet_ledger WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
      projectId, limit
    );
    return Response.json({ data: rows });
  }

  // ── project_rules — no-code "after the customer says X, this happens" triggers ─────────
  private listProjectRules(projectId: string): Response {
    const rows = queryAll<{
      id: string; project_id: string; trigger_pattern: string; action: string;
      reply_text: string | null; script_name: string | null; enabled: number; priority: number; created_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM project_rules WHERE project_id = ? ORDER BY priority DESC, created_at",
      projectId
    );
    return Response.json({ data: rows, count: rows.length });
  }

  private async createProjectRule(projectId: string, request: Request): Promise<Response> {
    const project = queryOne<{ id: string; space_id: string }>(this.ctx.storage.sql as never, "SELECT id, space_id FROM projects WHERE id = ?", projectId);
    if (!project) return Response.json({ error_code: "not_found", message: "Project not found" }, { status: 404 });

    const body = await request.json<{
      trigger_pattern: string;
      action: "reply" | "run_script" | "human_takeover";
      reply_text?: string;
      script_name?: string;
      priority?: number;
    }>().catch(() => ({}) as Record<string, never>);

    if (!body.trigger_pattern || !body.action) {
      return Response.json({ error_code: "bad_request", message: "trigger_pattern and action are required" }, { status: 400 });
    }
    if (!["reply", "run_script", "human_takeover"].includes(body.action)) {
      return Response.json({ error_code: "bad_request", message: "action must be 'reply', 'run_script', or 'human_takeover'" }, { status: 400 });
    }
    if (body.action === "reply" && !body.reply_text) {
      return Response.json({ error_code: "bad_request", message: "reply_text is required when action is 'reply'" }, { status: 400 });
    }
    if (body.action === "run_script" && !body.script_name) {
      return Response.json({ error_code: "bad_request", message: "script_name is required when action is 'run_script'" }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO project_rules (id, project_id, space_id, trigger_pattern, action, reply_text, script_name, enabled, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      id, projectId, project.space_id, body.trigger_pattern, body.action, body.reply_text ?? null, body.script_name ?? null, body.priority ?? 0, now
    );
    return Response.json({ id, project_id: projectId, trigger_pattern: body.trigger_pattern, action: body.action, created_at: now }, { status: 201 });
  }

  private deleteProjectRule(projectId: string, ruleId: string): Response {
    execute(this.ctx.storage.sql as never, "DELETE FROM project_rules WHERE id = ? AND project_id = ?", ruleId, projectId);
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
      id: string; project_id: string; image_id: string; slot_name: string; status: string; created_at: string; updated_at: string;
    }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM container_slots WHERE project_id = ? ORDER BY created_at",
      projectId
    );
    return Response.json({ data: rows, count: rows.length });
  }

  private async createContainerSlot(projectId: string, request: Request): Promise<Response> {
    const project = queryOne<{ id: string; space_id: string }>(this.ctx.storage.sql as never, "SELECT id, space_id FROM projects WHERE id = ?", projectId);
    if (!project) return Response.json({ error_code: "not_found", message: "Project not found" }, { status: 404 });

    const body = await request.json<{ image_id: string; slot_name?: string }>().catch(() => ({}) as Record<string, never>);
    if (!body.image_id) return Response.json({ error_code: "bad_request", message: "image_id is required" }, { status: 400 });

    const existing = queryAll<{ id: string }>(this.ctx.storage.sql as never, "SELECT id FROM container_slots WHERE project_id = ?", projectId);
    if (existing.length >= SpaceDO.MAX_SLOTS_PER_PROJECT_HARD_CEILING) {
      return Response.json({ error_code: "slot_limit_reached", message: `A project may not exceed ${SpaceDO.MAX_SLOTS_PER_PROJECT_HARD_CEILING} container slots` }, { status: 409 });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO container_slots (id, project_id, space_id, image_id, slot_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?)`,
      id, projectId, project.space_id, body.image_id, body.slot_name ?? "", now, now
    );
    return Response.json({ id, project_id: projectId, image_id: body.image_id, status: "provisioning", created_at: now }, { status: 201 });
  }

  private deleteContainerSlot(projectId: string, slotId: string): Response {
    execute(this.ctx.storage.sql as never, "DELETE FROM container_slots WHERE id = ? AND project_id = ?", slotId, projectId);
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
  private listLocalGrants(spaceId: string, filterUserId?: string): Response {
    const rows = filterUserId
      ? queryAll<{
          id: string; space_id: string; project_id: string | null; user_id: string;
          grant_type: string; directory: string | null; commands_json: string; created_at: string;
        }>(
          this.ctx.storage.sql as never,
          "SELECT * FROM local_grants WHERE space_id = ? AND user_id = ? ORDER BY created_at",
          spaceId, filterUserId
        )
      : queryAll<{
          id: string; space_id: string; project_id: string | null; user_id: string;
          grant_type: string; directory: string | null; commands_json: string; created_at: string;
        }>(
          this.ctx.storage.sql as never,
          "SELECT * FROM local_grants WHERE space_id = ? ORDER BY created_at",
          spaceId
        );
    const data = rows.map((r) => ({ ...r, commands: JSON.parse(r.commands_json || "[]") as string[] }));
    return Response.json({ data, count: data.length });
  }

  private async createLocalGrant(spaceId: string, request: Request): Promise<Response> {
    const body = await request
      .json<{ user_id: string; grant_type: string; directory?: string | null; commands?: string[]; project_id?: string | null }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.user_id || !body.grant_type) {
      return Response.json({ error_code: "bad_request", message: "user_id and grant_type are required" }, { status: 400 });
    }

    const existing = queryAll<{ id: string }>(this.ctx.storage.sql as never, "SELECT id FROM local_grants WHERE space_id = ?", spaceId);
    if (existing.length >= SpaceDO.MAX_LOCAL_GRANTS_PER_SPACE_HARD_CEILING) {
      return Response.json(
        { error_code: "grant_limit_reached", message: `A space may not exceed ${SpaceDO.MAX_LOCAL_GRANTS_PER_SPACE_HARD_CEILING} local grants` },
        { status: 409 }
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO local_grants (id, space_id, project_id, user_id, grant_type, directory, commands_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, spaceId, body.project_id ?? null, body.user_id, body.grant_type, body.directory ?? null,
      JSON.stringify(body.commands ?? []), now
    );
    return Response.json(
      { id, space_id: spaceId, project_id: body.project_id ?? null, user_id: body.user_id, grant_type: body.grant_type, created_at: now },
      { status: 201 }
    );
  }

  private deleteLocalGrant(spaceId: string, grantId: string): Response {
    execute(this.ctx.storage.sql as never, "DELETE FROM local_grants WHERE id = ? AND space_id = ?", grantId, spaceId);
    return Response.json({ deleted: true });
  }

  // ── Space Assistant approval policy ──────────────────────────────────────────
  // "Same access as the owning user, but ask before acting unless the user has explicitly
  // trusted this action." always_ask (default) gates everything except auto_approved_actions;
  // yolo skips asking entirely. User-controlled, never settable by the assistant itself —
  // only this space-worker route (owner-authenticated) can change it.
  private getAssistantPolicy(spaceId: string): Response {
    const row = queryOne<{ space_id: string; approval_mode: string; auto_approved_actions: string; updated_at: string }>(
      this.ctx.storage.sql as never,
      "SELECT * FROM assistant_policy WHERE space_id = ?",
      spaceId
    );
    if (!row) {
      return Response.json({ space_id: spaceId, approval_mode: "always_ask", auto_approved_actions: [] });
    }
    return Response.json({ ...row, auto_approved_actions: safeJsonParseArr(row.auto_approved_actions) });
  }

  private async updateAssistantPolicy(spaceId: string, request: Request): Promise<Response> {
    const body = await request.json<{
      approval_mode?: "always_ask" | "yolo";
      auto_approved_actions?: string[];
    }>().catch(() => ({}) as Record<string, never>);

    if (body.approval_mode !== undefined && body.approval_mode !== "always_ask" && body.approval_mode !== "yolo") {
      return Response.json({ error_code: "bad_request", message: "approval_mode must be 'always_ask' or 'yolo'" }, { status: 400 });
    }

    const existing = queryOne<{ approval_mode: string; auto_approved_actions: string }>(
      this.ctx.storage.sql as never,
      "SELECT approval_mode, auto_approved_actions FROM assistant_policy WHERE space_id = ?",
      spaceId
    );
    const approvalMode = body.approval_mode ?? existing?.approval_mode ?? "always_ask";
    const autoApproved = body.auto_approved_actions ?? (existing ? safeJsonParseArr(existing.auto_approved_actions) : []);
    const now = new Date().toISOString();

    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO assistant_policy (space_id, approval_mode, auto_approved_actions, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(space_id) DO UPDATE SET approval_mode = excluded.approval_mode, auto_approved_actions = excluded.auto_approved_actions, updated_at = excluded.updated_at`,
      spaceId, approvalMode, JSON.stringify(autoApproved), now
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
      id, agentId, keyHash, keyPrefix, now
    );
    return Response.json(
      { id, agent_id: agentId, key: rawKey, key_prefix: keyPrefix, created_at: now },
      { status: 201 }
    );
  }

  private listAgentApiKeys(agentId: string): Response {
    const rows = queryAll<{ id: string; agent_id: string; key_prefix: string; last_used_at: string | null; revoked_at: string | null; created_at: string }>(
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
      new Date().toISOString(), keyId, agentId
    );
    return Response.json({ revoked: true, id: keyId });
  }

  /** POST /internal/agent-keys/verify — { space_id, key } -> { valid, agent_id?, approval_mode?,
   *  auto_approved_actions? }. The approval-policy fields are folded into the SAME round trip
   *  the router already makes to verify the key, rather than a second call per request. */
  private async verifyAgentApiKey(request: Request): Promise<Response> {
    const body = await request.json<{ space_id?: string; key?: string }>().catch(() => ({}) as Record<string, never>);
    if (!body.key || !body.key.startsWith("nak_") || !body.space_id) return Response.json({ valid: false });
    const keyHash = await sha256Hex(body.key);
    const row = queryOne<{ id: string; agent_id: string }>(
      this.ctx.storage.sql as never,
      "SELECT id, agent_id FROM agent_api_keys WHERE key_hash = ? AND revoked_at IS NULL",
      keyHash
    );
    if (!row) return Response.json({ valid: false });
    execute(this.ctx.storage.sql as never, "UPDATE agent_api_keys SET last_used_at = ? WHERE id = ?", new Date().toISOString(), row.id);
    const policy = this.resolveAgentPolicy(body.space_id, row.agent_id);
    return Response.json({ valid: true, agent_id: row.agent_id, ...policy });
  }

  /** Resolve an agent's effective approval policy: its own agent_policy_overrides row if one
   *  exists, else the space-wide assistant_policy row, else the fail-closed default
   *  (always_ask, nothing pre-approved) — same three-step fallback fetchAssistantPolicy already
   *  documents for the Space Assistant itself. */
  private resolveAgentPolicy(spaceId: string, agentId: string): { approval_mode: "always_ask" | "yolo"; auto_approved_actions: string[] } {
    const override = queryOne<{ approval_mode: string; auto_approved_actions: string }>(
      this.ctx.storage.sql as never,
      "SELECT approval_mode, auto_approved_actions FROM agent_policy_overrides WHERE space_id = ? AND agent_id = ?",
      spaceId, agentId
    );
    if (override) {
      return { approval_mode: override.approval_mode as "always_ask" | "yolo", auto_approved_actions: safeJsonParseArr(override.auto_approved_actions) as string[] };
    }
    const spaceWide = queryOne<{ approval_mode: string; auto_approved_actions: string }>(
      this.ctx.storage.sql as never,
      "SELECT approval_mode, auto_approved_actions FROM assistant_policy WHERE space_id = ?",
      spaceId
    );
    if (spaceWide) {
      return { approval_mode: spaceWide.approval_mode as "always_ask" | "yolo", auto_approved_actions: safeJsonParseArr(spaceWide.auto_approved_actions) as string[] };
    }
    return { approval_mode: "always_ask", auto_approved_actions: [] };
  }

  private getAgentPolicy(spaceId: string, agentId: string): Response {
    const policy = this.resolveAgentPolicy(spaceId, agentId);
    return Response.json({ space_id: spaceId, agent_id: agentId, ...policy });
  }

  private async updateAgentPolicy(spaceId: string, agentId: string, request: Request): Promise<Response> {
    const body = await request.json<{ approval_mode?: "always_ask" | "yolo"; auto_approved_actions?: string[] }>().catch(() => ({}) as Record<string, never>);
    if (body.approval_mode !== undefined && body.approval_mode !== "always_ask" && body.approval_mode !== "yolo") {
      return Response.json({ error_code: "bad_request", message: "approval_mode must be 'always_ask' or 'yolo'" }, { status: 400 });
    }
    const existing = this.resolveAgentPolicy(spaceId, agentId);
    const approvalMode = body.approval_mode ?? existing.approval_mode;
    const autoApproved = body.auto_approved_actions ?? existing.auto_approved_actions;
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO agent_policy_overrides (space_id, agent_id, approval_mode, auto_approved_actions, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(space_id, agent_id) DO UPDATE SET approval_mode = excluded.approval_mode, auto_approved_actions = excluded.auto_approved_actions, updated_at = excluded.updated_at`,
      spaceId, agentId, approvalMode, JSON.stringify(autoApproved), now
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
    if (!showSubThreads) clauses.push("thread_kind = 'primary'");

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
  private isThreadLimitReached(projectId: string | null | undefined, kind: string): boolean {
    if (!projectId || kind === "sub_agent") return false;
    const project = queryOne<{ max_threads: number }>(
      this.ctx.storage.sql as never, "SELECT max_threads FROM projects WHERE id = ?", projectId
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
    const body = await request.json<{
      id?: string;
      space_id: string;
      user_id?: string;
      project_id?: string;
      title?: string;
      parent_thread_id?: string;
      thread_kind?: "primary" | "sub_agent" | "channel";
      channel?: string;
      channel_session_id?: string;
      tenant_id?: string;
    }>().catch(() => ({}) as Record<string, never>);
    if (!body.space_id) {
      return Response.json({ error_code: "bad_request", message: "space_id is required" }, { status: 400 });
    }
    const kind = body.thread_kind ?? "primary";
    if (!["primary", "sub_agent", "channel"].includes(kind)) {
      return Response.json({ error_code: "bad_request", message: "thread_kind must be 'primary', 'sub_agent', or 'channel'" }, { status: 400 });
    }
    const id = body.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const tenantId = body.tenant_id ?? request.headers.get("x-naelao-tenant-id") ?? "";
    // thread.created only fires for a genuinely NEW thread — never on the idempotent
    // update/re-mirror branches below (a webhook retry or a repeat mirrorThread() call must
    // not re-fire triggers for a thread that already existed).
    const fireCreated = (threadId: string, projectId: string | null) =>
      this.fireMatchingTriggers({ type: "thread.created", space_id: body.space_id, ...(projectId ? { project_id: projectId } : {}), thread_id: threadId, occurred_at: Date.now() }, tenantId);

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
        execute(this.ctx.storage.sql as never, "UPDATE threads SET updated_at = ? WHERE id = ?", now, existing.id);
        const row = queryOne(this.ctx.storage.sql as never, "SELECT * FROM threads WHERE id = ?", existing.id);
        return Response.json(row, { status: 201 });
      }
      if (this.isThreadLimitReached(body.project_id, kind)) {
        return Response.json({ error_code: "thread_limit_reached", message: "This project has reached its configured max_threads" }, { status: 409 });
      }
      execute(
        this.ctx.storage.sql as never,
        `INSERT INTO threads (id, space_id, user_id, project_id, title, status, parent_thread_id, thread_kind, channel, channel_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        id, body.space_id, body.user_id ?? null, body.project_id ?? null, body.title ?? null,
        body.parent_thread_id ?? null, kind, body.channel ?? null, body.channel_session_id, now, now
      );
      await fireCreated(id, body.project_id ?? null);
      const row = queryOne(this.ctx.storage.sql as never, "SELECT * FROM threads WHERE id = ?", id);
      return Response.json(row, { status: 201 });
    }

    const existingById = queryOne<{ id: string }>(this.ctx.storage.sql as never, "SELECT id FROM threads WHERE id = ?", id);
    if (existingById) {
      execute(this.ctx.storage.sql as never, "UPDATE threads SET updated_at = ? WHERE id = ?", now, id);
    } else {
      if (this.isThreadLimitReached(body.project_id, kind)) {
        return Response.json({ error_code: "thread_limit_reached", message: "This project has reached its configured max_threads" }, { status: 409 });
      }
      execute(
        this.ctx.storage.sql as never,
        `INSERT INTO threads (id, space_id, user_id, project_id, title, status, parent_thread_id, thread_kind, channel, channel_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        id, body.space_id, body.user_id ?? null, body.project_id ?? null, body.title ?? null,
        body.parent_thread_id ?? null, kind, body.channel ?? null, body.channel_session_id ?? null, now, now
      );
      await fireCreated(id, body.project_id ?? null);
    }
    const row = queryOne(this.ctx.storage.sql as never, "SELECT * FROM threads WHERE id = ?", id);
    return Response.json(row, { status: 201 });
  }

  private getThread(threadId: string): Response {
    const row = queryOne(this.ctx.storage.sql as never, "SELECT * FROM threads WHERE id = ?", threadId);
    if (!row) return Response.json({ error_code: "not_found", message: "Thread not found" }, { status: 404 });
    return Response.json(row);
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
    const body = await request.json<{
      space_id: string;
      project_id?: string;
      event_type: string;
      condition?: TriggerCondition;
      script_name: string;
      params?: Record<string, unknown>;
      priority?: number;
    }>().catch(() => ({}) as Record<string, never>);

    if (!body.space_id || !body.event_type || !body.script_name) {
      return Response.json({ error_code: "bad_request", message: "space_id, event_type, and script_name are required" }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO event_triggers (id, space_id, project_id, event_type, condition, script_name, params, enabled, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      id, body.space_id, body.project_id ?? null, body.event_type,
      JSON.stringify(body.condition ?? { type: "always" }), body.script_name,
      JSON.stringify(body.params ?? {}), body.priority ?? 0, now
    );
    return Response.json(
      { id, space_id: body.space_id, project_id: body.project_id ?? null, event_type: body.event_type, script_name: body.script_name, created_at: now },
      { status: 201 }
    );
  }

  private deleteEventTrigger(spaceId: string, triggerId: string): Response {
    execute(this.ctx.storage.sql as never, "DELETE FROM event_triggers WHERE id = ? AND space_id = ?", triggerId, spaceId);
    return Response.json({ deleted: true });
  }

  /**
   * Resolves what `last_active_thread_idle` needs: the most recently updated OTHER thread in
   * the SAME scope as the trigger (its project, or the whole space when the trigger is
   * space-wide), excluding the thread that fired the event. Scoped by construction — this
   * query can never see a different project's threads, so a project-scoped trigger can never
   * resolve (and therefore never fire against) a thread outside its own project.
   */
  private resolveLastActiveOtherThread(spaceId: string, projectId: string | undefined, excludeThreadId: string): { id: string; updated_at_ms: number } | undefined {
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
   */
  private async fireExternalEvent(request: Request): Promise<Response> {
    const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
    const body = await request.json<{
      type: string;
      space_id: string;
      project_id?: string;
      thread_id?: string;
      occurred_at?: number;
      payload?: Record<string, unknown>;
    }>();
    if (!tenantId || !body.type || !body.space_id) {
      return Response.json({ error_code: "bad_request", message: "type and space_id are required" }, { status: 400 });
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
  private async fireMatchingTriggers(event: EventEnvelope, tenantId: string): Promise<void> {
    if (!this.env.AGENTS_WORKER || !tenantId) return;
    try {
      const rows = queryAll<EventTriggerRow>(
        this.ctx.storage.sql as never,
        "SELECT * FROM event_triggers WHERE space_id = ? AND event_type = ? AND enabled = 1",
        event.space_id, event.type
      );
      const rules = selectMatchingRules(rows.map(rowToTriggerRule), event);
      for (const rule of rules.slice(0, 5)) { // bound worst-case fan-out per single event
        let ctx: ConditionContext = {};
        if (rule.condition.type === "last_active_thread_idle") {
          const other = this.resolveLastActiveOtherThread(event.space_id, rule.project_id ?? undefined, event.thread_id ?? "");
          if (other) ctx = { lastActiveOtherThread: other };
        }
        const result = evaluateCondition(rule.condition, ctx);
        if (!result.matched) continue;
        const params = buildFireParams(rule.action, event, result);
        // B3 fix: the static "x-naelao-internal: spaces-trigger" string was forgeable by
        // anyone who could reach the agents worker directly. Mint the same HMAC token
        // naelao-router's proxyTo attaches, verified by requireInternalHmac on the target route.
        const internalToken = await mintInternalToken(this.env.PLATFORM_SECRET, tenantId);
        await this.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/triggers/fire", {
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
        }));
      }
    } catch {
      /* best-effort — a firing failure must never surface as a failure of the thing that happened */
    }
  }

  // G-AO17: Record a prompt injection attempt for a user and check if they are now rate-limited.
  // Rate limit: 3 attempts within 1 hour triggers block.
  private async recordInjectionAttempt(request: Request): Promise<Response> {
    const body = await request.json<{ end_user_id: string; space_id: string }>();
    if (!body.end_user_id) {
      return Response.json({ error_code: "bad_request", message: "end_user_id is required" }, { status: 400 });
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

    return Response.json({ recorded: true, attempts_last_hour: count, rate_limited: rateLimited });
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
      settings?: Record<string, unknown>;
    }>();
    if (!body.id || !body.name || !body.space_type) {
      return Response.json({ error_code: "bad_request", message: "id, name, space_type are required" }, { status: 400 });
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
    return Response.json({ id: body.id, depth: 0, status: "active" }, { status: 201 });
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
      return Response.json({ error_code: "bad_request", message: "parent_id and name are required" }, { status: 400 });
    }

    const parent = queryOne<SpaceRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM spaces WHERE id = ? AND status != 'deleted'",
      body.parent_id
    );
    if (!parent) {
      return Response.json({ error_code: "not_found", message: "Parent space not found" }, { status: 404 });
    }

    // Depth: platform reserves depth 3; sub-spaces cannot nest more than 2 levels (§49).
    if (parent.depth >= 2) {
      return Response.json(
        { error_code: "max_depth_exceeded", message: "Sub-spaces cannot be nested more than 2 levels deep." },
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
        return Response.json({
          error_code: "mixed_space_type_not_permitted",
          message: `Mixed space types are only permitted when the parent space is an agency shell. ` +
                   `Parent ${parent.id} is type '${parent.space_type}'.`,
        }, { status: 400 });
      }
      effectiveType = body.space_type;
    } else {
      effectiveType = parent.space_type;
    }

    const id = body.id ?? crypto.randomUUID();
    const depth = parent.depth + 1;
    const scenario = body.scenario_type ?? (parent.agency_shell ? "agency-child" : "organizational");
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
      { id, parent_id: parent.id, name: body.name, space_type: effectiveType, depth, scenario_type: scenario, status: "active", created_at: now },
      { status: 201 }
    );
  }

  private getSpaceRow(id: string): Response {
    const row = queryOne<SpaceRow>(
      this.ctx.storage.sql as never,
      "SELECT * FROM spaces WHERE id = ?",
      id
    );
    if (!row) return Response.json({ error_code: "not_found", message: "Space not found" }, { status: 404 });
    return Response.json(this.serializeSpaceRow(row));
  }

  private async updateSpaceRow(id: string, request: Request): Promise<Response> {
    const body = await request.json<{ status?: string; name?: string; settings?: Record<string, unknown> }>();
    if (body.status && !["active", "suspended", "deleted"].includes(body.status)) {
      return Response.json({ error_code: "bad_request", message: "Invalid status" }, { status: 400 });
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
      settings: (() => { try { return JSON.parse(row.settings) as unknown; } catch { return {}; } })(),
    };
  }

  // ── cross-space grants (§49 checkPermission — fail closed) ───────────────────

  private async grantCrossSpace(request: Request): Promise<Response> {
    const body = await request.json<{
      granting_space_id: string;
      receiving_space_id: string;
      grant_type: "read-knowledge" | "read-threads" | "full-access";
      granted_by: string;
      expires_at?: string;
    }>();
    if (!body.granting_space_id || !body.receiving_space_id || !body.grant_type || !body.granted_by) {
      return Response.json({ error_code: "bad_request", message: "granting_space_id, receiving_space_id, grant_type, granted_by are required" }, { status: 400 });
    }
    if (body.granting_space_id === body.receiving_space_id) {
      return Response.json({ error_code: "bad_request", message: "Cannot grant a space access to itself" }, { status: 400 });
    }
    const id = crypto.randomUUID();
    execute(
      this.ctx.storage.sql as never,
      `INSERT INTO cross_space_grants (id, granting_space_id, receiving_space_id, grant_type, granted_by, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, body.granting_space_id, body.receiving_space_id, body.grant_type, body.granted_by, new Date().toISOString(), body.expires_at ?? null
    );
    return Response.json({ id, grant_type: body.grant_type }, { status: 201 });
  }

  private listCrossSpaceGrants(params: URLSearchParams): Response {
    const spaceId = params.get("space_id");
    const rows = spaceId
      ? queryAll<CrossSpaceGrantRow>(
          this.ctx.storage.sql as never,
          `SELECT * FROM cross_space_grants
           WHERE (granting_space_id = ? OR receiving_space_id = ?) AND revoked_at IS NULL
           ORDER BY granted_at DESC`,
          spaceId, spaceId
        )
      : queryAll<CrossSpaceGrantRow>(
          this.ctx.storage.sql as never,
          "SELECT * FROM cross_space_grants WHERE revoked_at IS NULL ORDER BY granted_at DESC"
        );
    return Response.json({ data: rows });
  }

  private revokeCrossSpace(id: string): Response {
    execute(
      this.ctx.storage.sql as never,
      "UPDATE cross_space_grants SET revoked_at = ? WHERE id = ?",
      new Date().toISOString(), id
    );
    return Response.json({ revoked: true, id });
  }

  // GET /cross-space-check — THE CRITICAL PATH (§49). Default DENIED on any error.
  // A user gets access if they are a direct member of the target space, OR a valid
  // (unexpired, unrevoked) grant exists from the requesting space to the target.
  private checkCrossSpace(params: URLSearchParams): Response {
    const userId = params.get("user_id") ?? "";
    const requestingSpaceId = params.get("requesting_space_id") ?? "";
    const targetSpaceId = params.get("target_space_id") ?? "";
    const grantType = params.get("grant_type") ?? "read-knowledge";

    try {
      if (!userId || !targetSpaceId) {
        return Response.json({ permitted: false, reason: "user_id and target_space_id are required", grant_type: null }, { status: 400 });
      }

      // Direct membership of the target space → permitted.
      const member = queryOne<{ role: string }>(
        this.ctx.storage.sql as never,
        "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?",
        targetSpaceId, userId
      );
      if (member) {
        return Response.json({ permitted: true, reason: `Direct member with role '${member.role}'.`, grant_type: null });
      }

      // Valid cross-space grant from requesting → target.
      const now = new Date().toISOString();
      const grant = queryOne<{ id: string; grant_type: string }>(
        this.ctx.storage.sql as never,
        `SELECT id, grant_type FROM cross_space_grants
         WHERE granting_space_id = ? AND receiving_space_id = ?
           AND (grant_type = ? OR grant_type = 'full-access')
           AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
        targetSpaceId, requestingSpaceId, grantType, now
      );
      if (!grant) {
        return Response.json({
          permitted: false,
          reason: `User ${userId} is not a member of ${targetSpaceId} and no '${grantType}' grant exists from ${requestingSpaceId}.`,
          grant_type: null,
        });
      }
      return Response.json({ permitted: true, reason: `Cross-space grant '${grant.grant_type}' applies.`, grant_type: grant.grant_type });
    } catch (err) {
      // ANY unexpected error → DENIED. Never permit on error.
      console.error("[SpaceDO] checkCrossSpace UNEXPECTED ERROR — defaulting to DENIED", err);
      return Response.json({ permitted: false, reason: "Permission check failed; access denied as a safety default.", grant_type: null });
    }
  }
}
