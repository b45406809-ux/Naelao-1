/**
 * SpaceTypeRegistryDO — the single source of truth for all Naelao SpaceType manifests.
 *
 * ONE global instance: idFromName('global-space-type-registry')
 * Space Types are EXCLUSIVELY authored by Naelao (spec §62 / CLAUDE.md #7).
 * Read-heavy, write-rare. Callers cache responses in KV (TTL 1h).
 */

import { DurableObject } from "cloudflare:workers";

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
    workflowTemplates: Array<{ id: string; name: string; triggerType: string }>;
    cronJobs: Array<{ id: string; cron: string; workerBinding: string }>;
    r2Prefixes: string[];
    resourceBudget: {
      maxDOsPerInstance: number;
      maxR2WritesPerDay: number;
      maxContainerHoursPerDay: number;
      maxLLMTokensPerDay: number;
      maxCronJobsPerInstance: number;
      maxWorkflowsPerInstance: number;
    };
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

  /** Allow anyone to self-serve sign up to the product portal. */
  allowPublicSignup: boolean;

  /**
   * For tenant/hybrid: which Naelao-authored SpaceTypes a customer is allowed to
   * instantiate (per CLAUDE.md #7, all SpaceTypes are Naelao-authored; the builder
   * only chooses which ones to expose). Ignored for "team".
   */
  allowedChildSpaceTypes?: string[];

  /**
   * Billing relationship for tenant/hybrid child businesses:
   *  - "reseller":  Naelao bills the builder wholesale; builder sets retail and
   *                 keeps the margin + owns invoicing (spec G-AS35).
   *  - "referral":  Naelao bills each customer directly; builder takes a rev-share.
   *  - "platform":  no resale — child tenants are billed exactly like any builder.
   */
  billingRelationship?: "reseller" | "referral" | "platform";

  /** Per-member capability flags (spec `productConfig.userPermissions`). */
  userPermissions?: {
    canCreateSpace?: boolean; // hybrid: members may provision their own businesses
    canCreateSubSpaces?: boolean; // may create departments (sub-spaces)
    canCreateProjects?: boolean;
    maxThreadsPerUser?: number | null;
    maxCreditsPerMonth?: number | null;
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
    this.ctx.storage.sql.exec("PRAGMA journal_mode=WAL");
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
    `);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

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
      }>();
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
      if (!m.backend?.resourceBudget) {
        return Response.json(
          { accepted: false, reason: "Resource budget declaration required" },
          { status: 400 }
        );
      }
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO space_types
           (id, name, description, author, current_version, manifest, status, visible, price_usd, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'approved', 1, ?, ?)`,
        m.id, m.name, m.description, body.authorId,
        m.version, JSON.stringify(m), m.marketplace.priceUsdPerMonth, now
      );
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO versions (type_id, version, manifest, change_type, canary_pct, stable, published_at)
         VALUES (?, ?, ?, 'minor', 100, 1, ?)`,
        m.id, m.version, JSON.stringify(m), now
      );
      return Response.json({ accepted: true });
    }

    // POST /record-install — called at the end of successful provisioning (step 10)
    if (method === "POST" && url.pathname === "/record-install") {
      const body = await request.json<{ typeId: string; spaceId: string; version: string }>();
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO instances (type_id, space_id, version) VALUES (?, ?, ?)`,
        body.typeId, body.spaceId, body.version
      );
      this.ctx.storage.sql.exec(
        `UPDATE space_types SET install_count = install_count + 1 WHERE id = ?`,
        body.typeId
      );
      return Response.json({ ok: true });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
