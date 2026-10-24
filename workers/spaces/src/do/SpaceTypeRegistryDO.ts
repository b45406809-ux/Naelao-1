/**
 * SpaceTypeRegistryDO — the single source of truth for all Naelao SpaceType manifests.
 *
 * ONE global instance: idFromName('global-space-type-registry')
 * Space Types are EXCLUSIVELY authored by Naelao (spec §62 / CLAUDE.md #7).
 * Read-heavy, write-rare. Callers cache responses in KV (TTL 1h).
 */

import { DurableObject } from "cloudflare:workers";
import { readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";
import { assertTemplateId } from "@naelao/agent-sdk";
import { LAUNCHPAD_MANIFEST } from "../launchpad-manifest.js";

// ── SpaceType Manifest v2 (spec §61) ─────────────────────────────────────────

export type AgentLoopModel =
  | "chat"
  | "file-edit"
  | "knowledge-graph"
  | "task-completion"
  | "content"
  | "remote";

export interface NaelaoSpaceTypeManifestV2 {
  // ── Identity ────────────────────────────────────────────────────────────────
  id: string;
  name: string;
  description: string;
  version: string;
  author: "naelao";
  icon: string;
  tags: string[];

  // ── Layer 1: Agent Environment ───────────────────────────────────────────
  agentEnvironment: {
    defaultExecutionTier: "workspace" | "isolate" | "browser" | "sandbox";
    containerIdleTimeoutMs: number;
    loopModel: AgentLoopModel;
    alwaysLoadedSkills: string[];
    disabledSkills: string[];
    networkPolicy: "open" | "restricted" | "none";
    networkAllowlist?: string[];
    maxContextTokens: number;
    agentPermissions: string[];
  };

  // ── Layer 2: Backend Infrastructure ─────────────────────────────────────
  backend: {
    platformDOs: Array<{ type: string; namingPattern: string }>;
    spaceDoInitHook?: string;
    r2Prefixes: string[];
    /** WS-6 (audit plan): opts into the provisioner's script-agent install step (writing agent
     *  R2 config files + registering a SpaceDO index + seeding an assistant policy) — replaces a
     *  shared-code `if (spaceTypeId === "launchpad")` branch with a manifest-declared capability
     *  so a manifest that omits this installs no agents at all, keeping the provisioner itself
     *  free of any hardcoded SpaceType name. The actual agent-definition SOURCE (today: Launchpad's
     *  own template registry in workers/agents/src/launchpad/spacetype.ts) is still SpaceType-
     *  specific install logic the provisioner calls into — fully manifest-driven agent-def DATA
     *  (rather than a capability flag) is a larger follow-up with no second SpaceType yet to
     *  validate it against; not done in this pass. */
    scriptAgentsEnabled?: boolean;
    /** WS-6 (audit plan): the shared billing worker used to hardcode a Launchpad-specific
     *  fulfillment agent id + an "orders" project-name fallback (workers/billing/src/
     *  lemon-squeezy.ts). Moved here so a SpaceType that wants "route order-completed events to
     *  a dedicated specialist agent" declares it in its own manifest instead of the billing
     *  worker needing a second SpaceType's name added to its own source. Absent = no such
     *  specialist exists for this SpaceType (payment events just wake the Space Assistant). */
    fulfillment?: { agentId: string; projectNameFallback?: string };
  };

  // ── Layer 3: UI ───────────────────────────────────────────────────────────
  ui: {
    operatorShell: {
      sidebarItems: Array<{ id: string; label: string; icon: string; path: string }>;
      dashboardWidgets: string[];
      hiddenCoreItems: string[];
      defaultView: string;
    };
    externalPortal?: {
      enabled: boolean;
      deploymentType: "cf-pages" | "dynamic-worker";
      templateId: string;
      defaultSlug: string;
      customDomain: boolean;
      authModel: "public" | "customer-auth" | "gated";
    };
  };

  // ── Provisioning Lifecycle ────────────────────────────────────────────────
  lifecycle: {
    provisionerWorker?: string;
    deprovisionerWorker?: string;
    migratorWorker?: string;
    healthCheckUrl?: string;
  };

  // ── Marketplace ───────────────────────────────────────────────────────────
  marketplace: {
    visible: boolean;
    minimumNaelaoPlan: "free" | "maker" | "pro" | "team" | "enterprise";
    priceUsdPerMonth: number;
    trialDays: number;
    capabilities: string[];
  };

  // ── Product Config (spec byte ~1.464M `productConfig`) ─────────────────────
  // Builder-tunable, per-product behaviour. Defaults preserve the single-business
  // team model; `tenant`/`hybrid` enable the reseller model (spec G-AS34/G-AS35).
  productConfig?: SpaceTypeProductConfig;
}

/**
 * Per-product configuration a builder selects (UI only — never code).
 *
 * Two orthogonal axes decided here:
 *  1. membershipModel — what a person who *joins this product* becomes.
 *  2. assistantMode   — whether each member gets a personal Space Assistant
 *     (spec §05 default "one per user per Space") or a single shared one.
 */
export interface SpaceTypeProductConfig {
  /** Owner-managed OpenRouter worker catalog. Card metadata is refreshed at dispatch time. */
  workerModelPool?: { modelIds: string[]; modelsByPlan?: Record<string, string[]>; selectionMode?: "automatic" | "planner"; inputUsdPerMillion?: number; outputUsdPerMillion?: number };
  /** Vertical certification policy, enforced again by the agents router at dispatch time. */
  modelPolicy?: { mode: "open" | "whitelist_only"; allowedModelIds: string[] };
  compliance?: { airGappedOnly?: boolean };
  /**
   * Tenancy — the data-topology contract (spec G-Y15 CRITICAL, G-Y16). This is the
   * authoritative dimension that maps to a DO topology + isolation strategy:
   *  - "single": one owner, one SpaceDO. No sub-spaces.
   *  - "team":   one shared SpaceDO; sub-spaces (departments) live inside it, isolated
   *              by space_id in the SpaceDO `spaces` registry. Shared members.
   *  - "saas":   product root + per-end-user isolation — each customer business is its
   *              OWN SpaceDO under its OWN child tenant (structural isolation, not a
   *              WHERE clause). The root holds only the user registry + billing.
   *
   * Relationship to membershipModel: tenancy is the topology, membershipModel is the
   * join semantics. team→team, tenant→saas, hybrid→saas. Defaults to "team" when
   * omitted so existing manifests keep the single shared-business behaviour.
   */
  tenancy?: "single" | "team" | "saas";

  /**
   * What a user who signs up to this product becomes:
   *  - "team":   a SpaceDO member of the builder's own space (shared business).
   *  - "tenant": owner of their OWN newly-provisioned space under the builder's
   *              account (Polsia-style — they join to create their own business).
   *              Implemented via the Agency/Reseller account hierarchy (G-AS34/35).
   *  - "hybrid": a team member who may ALSO create their own businesses.
   */
  membershipModel: "team" | "tenant" | "hybrid";

  /**
   * Agency-shell flag (spec §49 Scenario B). When true, the root product space is an
   * internal admin shell and its child spaces may use DIFFERENT space types (mixed-type
   * sub-spaces). When false (default), all sub-spaces inherit the parent's space type.
   * End-users can never create agency shells.
   */
  agencyShell?: boolean;

  /**
   * Space Assistant cardinality (spec §05 "one per user per Space by default.
   * Admin can raise this limit." — `shared` lowers it to a single space-owned one).
   */
  assistantMode: "per-user" | "shared";

  /**
   * Whether a signed-in customer may create their OWN business under this product (tenant/hybrid
   * only; ignored for "team").
   *
   * NOT a gate on signing up to the product — end-user signup lives in product-end-user-routes.ts
   * and never reads this. The old wording here ("self-serve sign up to the product portal") is what
   * produced an error message telling builders signup was disabled while customers were visibly
   * signing up fine. The name is kept for compatibility; the meaning is this.
   */
  allowPublicSignup: boolean;

  /**
   * For tenant/hybrid: which Naelao-authored SpaceTypes a customer is allowed to
   * instantiate (per CLAUDE.md #7, all SpaceTypes are Naelao-authored; the builder
   * only chooses which ones to expose). Ignored for "team".
   */
  allowedChildSpaceTypes?: string[];

  /** Per-member capability flags (spec `productConfig.userPermissions`). */
  userPermissions?: {
    canCreateSpace?: boolean; // hybrid: members may provision their own businesses
    canCreateSubSpaces?: boolean; // may create departments (sub-spaces)
    canCreateProjects?: boolean;
    maxThreadsPerUser?: number | null;
    maxCreditsPerMonth?: number | null;
  };

  // ── Three-Tier Platform Model (spec "How Builders Use Naelao") — Phase 1 additions ──
  // Stored the same way memberBilling/assistantMode already are: a per-space config_json
  // override that loadEffectiveProductConfig merges over the manifest's base productConfig.
  // Not real D1 columns (see migration 0044's comment for why) — a builder edits these via the
  // Builder Dashboard, never a manifest fork.

  /** White-label branding (Builder Dashboard wizard "Branding" step). */
  branding?: {
    brandColor?: string; // hex
    logoUrl?: string;    // R2 object URL
    faviconUrl?: string; // R2 object URL
    productDescription?: string;
    /** Default true for custom domains — cannot suppress legally-required disclosures. */
    suppressNaelaoBranding?: boolean;
  };

  /** Auth provider for this product's end users (wizard "Auth Config" step). */
  authProvider?: {
    provider: "naelao-native" | "clerk" | "custom-oidc" | "saml-sso";
    requireAdminApproval?: boolean;
    allowedEmailDomains?: string[];
    /** Only set for custom-oidc/saml-sso; secrets live in the credentials vault, never here. */
    ssoConfig?: { issuerUrl?: string; clientId?: string; acsUrl?: string };
  };

  /** Legacy signup quota seed. Payments and business commerce are not kernel features. */
  pricingConfig?: {
    model: "free";
    creditsIncludedPerMonth?: number;
  };

  /** Tier 2/3 follow-up: a proactive daily digest email (agent activity summary — runs,
   *  escalations, failures over the last 24h) to the builder's own owner-contact email. Opt-in
   *  and off by default — enqueueAgentTicks (workers/agents) only enrolls a product root whose
   *  OWN config_json sets this explicitly; the SpaceType manifest's own default is never trusted
   *  for something that sends an email. */
  notificationsConfig?: {
    dailyDigestEnabled?: boolean;
  };

  /** Sub-space terminology + depth cap the end-user-facing shell renders (spec Scenario C
   *  subSpaceTerminology). Depth enforcement itself lives in SpaceDO.createSubSpace — this is
   *  display/config only. */
  subSpaceDisplay?: {
    terminology?: string; // e.g. "workspace", "team", "project" — builder's own word for it
    maxDepth?: 1 | 2;
  };

  /** Builder Dashboard "Users" tab gates (spec adminFeatures — conversationLogAccess is ALSO
   *  gated by the D1 conversation_access_approved_by/_at audit columns; both must be true). */
  adminFeatures?: {
    conversationLogAccess?: boolean;
    analyticsAccess?: boolean;
    webhookEndpoints?: boolean;
  };

  /** Per-product feature flags a builder toggles for their own end users (Builder Dashboard
   *  "Feature Flags" tab). Distinct from FeatureFlagDO, which is Naelao's own platform-wide
   *  gradual-rollout system for internal capability rollouts — different actor, different
   *  lifecycle, not reused here. */
  featureFlags?: Record<string, boolean>;

  /** Phase D (§A1.17): which of the SpaceType's business/project templates a builder offers
   *  their own end users — narrows the Product Shell's create-business template multi-select
   *  (apps/shell) below "every template that exists." Distinct from `allowedChildSpaceTypes`
   *  (which SpaceTypes, plural, a tenant/hybrid product may instantiate) — this is which
   *  TEMPLATES within a single already-allowed SpaceType (e.g. which of Launchpad's 7 business
   *  templates: creator-store, newsletter-business, etc). Unset/empty = every template the
   *  SpaceType ships is offered (the pre-Phase-D default, unchanged). */
  catalog?: {
    businessTemplates?: string[];
    projectTemplates?: string[];
  };

  /** §A1.17 Phase L: how many Container Marketplace slots a project on this product may hold,
   *  beyond the one base Tier-5 sandbox every project already gets (Phase K). Unset/0 = no
   *  marketplace slots (the pre-Phase-L default) — a builder opts a product INTO the marketplace
   *  by raising this, once at least one catalogue image is actually `available`. */
  containerMarketplace?: {
    maxSlotsPerProject?: number;
  };

  /** §A1.28 (model switcher): the LLM this product's agents run on. Same "config_json override,
   *  never a manifest fork" convention as memberBilling/pricingConfig/catalog above — deliberately
   *  NOT a new `spacetypes.model_config` D1 column (a prior, unused, dead column read by
   *  `index.ts` with no migration ever creating it — do not resurrect it as a foundation).
   *  `model` is validated against a small curated allowlist at the PATCH route (cost
   *  predictability — never an arbitrary caller-supplied string). Unset → the existing
   *  per-dispatch-site hardcoded fallback (e.g. "claude-haiku-4-5-20251001") is used, unchanged
   *  from before this feature existed. */
  modelConfig?: {
    model?: string;
    /** The escalation-budget dial (billing-core/effort.ts's EffortLevel) — how far a run on this
     *  business's own default model may reach for a more capable (pricier) model when it
     *  delegates work to a sub-agent. Validated against the CHOSEN model at the PATCH route (an
     *  effort level a model doesn't offer is rejected, same posture as `model` above). Unset ->
     *  "low", the safest default for a business that's never configured this. */
    effort?: string;
  };

  /** §A1 Harness Excellence Phase HX2: session token-budget guard. Same config_json-override
   *  convention as modelConfig above — a builder opts in per product, nothing platform-wide.
   *  `sessionCreditCeiling` unset or <=0 disables the guard entirely (existing behavior,
   *  unchanged). When set, a session that crosses it fires an `agent.session_budget_warning`
   *  event at 80% (once per spending cycle) and, at 100%, refuses further runs until a human
   *  approves continuing via the existing HITL approval mechanism — never silent. See
   *  NaelaoAgentDO.enforceRunGates' session-budget branch for the enforcement. */
  limits?: {
    sessionCreditCeiling?: number;
  };

  /** Legal & support config — builder-defined, surfaced in the product shell so end users know
   *  how to get help, and so a builder can point to their own ToS/privacy policy instead of (or
   *  in addition to) Naelao's platform defaults. All fields are optional (reasonable fallbacks
   *  apply in the shell: Naelao's own ToS/Privacy for un-customized products), but a builder
   *  SHOULD fill these in before going public — they're what makes a DPA possible. */
  legal?: {
    /** URL to this product's Terms of Service (must be HTTPS). Shown in signup flow + footer. */
    tosUrl?: string;
    /** URL to this product's Privacy Policy (must be HTTPS). Shown in signup flow + footer. */
    privacyPolicyUrl?: string;
    /** URL to the builder's Data Processing Agreement (sent to enterprise customers on request). */
    dpaUrl?: string;
    /** Cookie policy — "none" = product uses no tracking cookies (only first-party session cookies),
     *  "analytics" = builder also uses a first-party analytics cookie, "third_party" = the shell
     *  will show a consent banner before setting anything beyond the mandatory session cookie. */
    cookiePolicy?: "none" | "analytics" | "third_party";
    /** Support contact for end users (mailto: or https:). Shown on error pages and the 402 credit
     *  exhaustion screen so a stuck user always has a path to a human. If unset, the shell links
     *  to the generic Naelao support page instead. */
    supportContact?: string;
  };
}

// resolveTenancy lives in the pure ./tenancy module (no cloudflare:workers import) so it
// is unit-testable and reusable by the provisioner. Re-exported here for callers that
// already import from the registry DO module.
export { resolveTenancy } from "../tenancy.js";
export type { Tenancy } from "../tenancy.js";

interface SpaceTypeListing {
  id: string;
  name: string;
  description: string;
  author: string;
  current_version: string;
  price_usd: number;
  install_count: number;
  rating_avg: number;
  rating_count: number;
}

export class SpaceTypeRegistryDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS space_types (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL,
        author          TEXT NOT NULL,
        current_version TEXT NOT NULL,
        manifest        TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','approved','suspended','deprecated')),
        visible         INTEGER NOT NULL DEFAULT 0,
        price_usd       REAL NOT NULL DEFAULT 0.0,
        install_count   INTEGER NOT NULL DEFAULT 0,
        rating_avg      REAL NOT NULL DEFAULT 0.0,
        rating_count    INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        updated_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );

      CREATE TABLE IF NOT EXISTS versions (
        type_id      TEXT NOT NULL REFERENCES space_types(id),
        version      TEXT NOT NULL,
        manifest     TEXT NOT NULL,
        change_type  TEXT NOT NULL CHECK (change_type IN ('minor','major')),
        canary_pct   INTEGER NOT NULL DEFAULT 0,
        stable       INTEGER NOT NULL DEFAULT 0,
        published_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        PRIMARY KEY (type_id, version)
      );

      CREATE TABLE IF NOT EXISTS instances (
        type_id      TEXT NOT NULL REFERENCES space_types(id),
        space_id     TEXT NOT NULL,
        version      TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'running'
          CHECK (status IN ('provisioning','running','migrating','deprovisioning','error')),
        installed_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        PRIMARY KEY (type_id, space_id)
      );

      CREATE TABLE IF NOT EXISTS native_space_templates (
        id TEXT PRIMARY KEY CHECK (id GLOB 'tpl_*'),
        version TEXT NOT NULL,
        manifest TEXT NOT NULL,
        shell_route TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // Foundry is now a portable Space Blueprint plus the ext_foundry_catalog extension; do not
    // continue publishing the former special-case native /foundry template from old DO state.
    this.ctx.storage.sql.exec("DELETE FROM native_space_templates WHERE id = ?", "tpl_dev_foundry_v1");
    this.initialized = true;

    // Self-heal: this registry must always carry at least the built-in Naelao
    // manifests. Seeding was originally a manual, easy-to-forget POST
    // /internal/space-types/seed call at deploy time — if that was never run
    // against a fresh/reset instance, every listing (GET /types, the builder
    // wizard's SpaceType step, provisioning's own GET /type/:id) would silently
    // return an empty catalogue rather than erroring, with no visible sign
    // anything was wrong. Seed inline instead of depending on that step.
    const existing = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM space_types`).toArray() as unknown as { n: number }[];
    if ((existing[0]?.n ?? 0) === 0) {
      for (const manifest of [LAUNCHPAD_MANIFEST]) {
        this.registerManifest(manifest, "naelao");
      }
    }
    // Built-in manifests are source-controlled. Refresh the persisted registry so a local dev
    // session does not keep serving an old onboarding policy after a manifest update.
    for (const manifest of [LAUNCHPAD_MANIFEST]) {
      this.registerManifest(manifest, "naelao");
    }
  }

  private registerManifest(manifest: NaelaoSpaceTypeManifestV2, authorId: string): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO space_types
         (id, name, description, author, current_version, manifest, status, visible, price_usd, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'approved', 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
         author=excluded.author, current_version=excluded.current_version, manifest=excluded.manifest,
         status='approved', visible=1, price_usd=excluded.price_usd, updated_at=excluded.updated_at`,
      manifest.id, manifest.name, manifest.description, authorId,
      manifest.version, JSON.stringify(manifest), manifest.marketplace.priceUsdPerMonth, now
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO versions (type_id, version, manifest, change_type, canary_pct, stable, published_at)
       VALUES (?, ?, ?, 'minor', 100, 1, ?)
       ON CONFLICT(type_id, version) DO UPDATE SET manifest=excluded.manifest, stable=1, published_at=excluded.published_at`,
      manifest.id, manifest.version, JSON.stringify(manifest), now
    );
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      try { request = new Request(request, { body: await readBoundedRequestBytes(request, 2 * 1024 * 1024) }); }
      catch (error) {
        if (error instanceof RequestBodyTooLargeError) return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
        return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
      }
    }
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    // Native templates render inside apps/shell and are distinct from installable ext_* packages.
    const nativeTemplateMatch = url.pathname.match(/^\/native-template\/([^/]+)$/);
    if (method === "GET" && nativeTemplateMatch?.[1]) {
      try { assertTemplateId(nativeTemplateMatch[1]); }
      catch { return Response.json({ error: "invalid_template_id" }, { status: 400 }); }
      const row = this.ctx.storage.sql.exec(
        "SELECT manifest FROM native_space_templates WHERE id = ?", nativeTemplateMatch[1]
      ).toArray()[0] as { manifest?: string } | undefined;
      if (!row?.manifest) return Response.json({ error: "not_found" }, { status: 404 });
      return new Response(row.manifest, { headers: { "content-type": "application/json" } });
    }

    if (method === "GET" && url.pathname === "/native-templates") {
      const rows = this.ctx.storage.sql.exec(
        "SELECT manifest FROM native_space_templates ORDER BY id"
      ).toArray() as unknown as Array<{ manifest: string }>;
      return Response.json({ templates: rows.map((row) => JSON.parse(row.manifest)) });
    }

    // GET /type/:id — retrieve an approved manifest
    const typeMatch = url.pathname.match(/^\/type\/([^/]+)$/);
    if (method === "GET" && typeMatch?.[1]) {
      const rows = this.ctx.storage.sql
        .exec(
          "SELECT manifest FROM space_types WHERE id = ? AND status = 'approved'",
          typeMatch[1]
        )
        .toArray() as unknown as { manifest: string }[];
      if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
      return new Response(rows[0].manifest, { headers: { "content-type": "application/json" } });
    }

    // GET /types — list all visible approved space types
    if (method === "GET" && url.pathname === "/types") {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT id, name, description, author, current_version,
                  price_usd, install_count, rating_avg, rating_count
           FROM space_types
           WHERE status = 'approved' AND visible = 1
           ORDER BY install_count DESC LIMIT 100`
        )
        .toArray() as unknown as SpaceTypeListing[];
      return Response.json({ types: rows });
    }

    // POST /register — Naelao-internal: upsert a space type (author must be 'naelao')
    if (method === "POST" && url.pathname === "/register") {
      const body = await request.json<{
        manifest: NaelaoSpaceTypeManifestV2;
        authorId: string;
      }>().catch(() => null);
      if (!body || typeof body !== "object" || !body.manifest || typeof body.manifest !== "object") {
        return Response.json({ accepted: false, reason: "Invalid registration payload." }, { status: 400 });
      }
      if (body.authorId !== "naelao") {
        return Response.json(
          { accepted: false, reason: "Space Types are exclusively authored by Naelao." },
          { status: 403 }
        );
      }
      const m = body.manifest;
      if (!m.id || !m.name || !m.version) {
        return Response.json(
          { accepted: false, reason: "Manifest missing required fields: id, name, version" },
          { status: 400 }
        );
      }
      if (typeof m.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(m.id) || typeof m.name !== "string" || m.name.length < 1 || m.name.length > 120 ||
          typeof m.description !== "string" || m.description.length > 2000 || typeof m.version !== "string" || m.version.length > 64 ||
          JSON.stringify(m).length > 1024 * 1024 || !Number.isFinite(m.marketplace?.priceUsdPerMonth) || m.marketplace.priceUsdPerMonth < 0) {
        return Response.json({ accepted: false, reason: "Manifest fields are invalid or exceed limits." }, { status: 400 });
      }
      this.registerManifest(m, body.authorId);
      return Response.json({ accepted: true });
    }

    // POST /record-install — called at the end of successful provisioning (step 10)
    if (method === "POST" && url.pathname === "/record-install") {
      const body = await request.json<{ typeId: string; spaceId: string; version: string }>().catch(() => null);
      if (!body || typeof body.typeId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(body.typeId) ||
          typeof body.spaceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.spaceId) ||
          typeof body.version !== "string" || !/^[A-Za-z0-9.+_-]{1,64}$/.test(body.version)) {
        return Response.json({ error_code: "install_record_invalid" }, { status: 400 });
      }
      const known = this.ctx.storage.sql.exec("SELECT 1 AS found FROM versions WHERE type_id=? AND version=?", body.typeId, body.version).toArray();
      if (!known.length) return Response.json({ error_code: "space_type_version_not_found" }, { status: 404 });
      const recorded = this.ctx.storage.transactionSync(() => {
        const result = this.ctx.storage.sql.exec(
          "INSERT INTO instances (type_id, space_id, version) VALUES (?, ?, ?) ON CONFLICT(type_id, space_id) DO NOTHING",
          body.typeId, body.spaceId, body.version
        );
        if (result.rowsWritten) this.ctx.storage.sql.exec("UPDATE space_types SET install_count=install_count+1 WHERE id=?", body.typeId);
        return result.rowsWritten > 0;
      });
      return Response.json({ ok: true, deduplicated: !recorded });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
