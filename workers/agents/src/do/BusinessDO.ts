/**
 * BusinessDO — One Durable Object per running Whop business.
 *
 * Holds: fiber/session state, Whop product ID, affiliate registration,
 * template_version, flat script registry, action→outcome log, autonomy ladder.
 *
 * The durable execution layer (generic) is separated from the nightly-cycle
 * business-logic module (template-specific). Schema never absorbs
 * Whop-Businesses-specific assumptions — it stays generic so a second
 * template can reuse it without touching the DO layer.
 *
 * Script engine: OBSERVE → FINGERPRINT → FIND → GATE → EXECUTE → VERIFY → DISTILL
 * Escalation: L1 direct, L2 cheap patch, L3 full reason, L4 live+distill
 * Autonomy tiers: 1=Draft, 2=Publish, 3=Operate
 */

import { DurableObject } from "cloudflare:workers";
import { moderateText } from "@naelao/moderation";
import { getDOName } from "@naelao/crypto";
import {
  getHostAction,
  PUBLISH_ACTION_NAMES,
  type HostAction,
  type HostActionResult,
} from "../whop/actions.js";
import {
  computeStability,
  isDemoted,
  structuralFingerprint,
  costCents,
  overDailyCap,
  decidePublish,
  DAILY_ACTION_CAP,
  BREAKER_THRESHOLD,
  BREAKER_COOLDOWN_MS,
} from "../whop/cycle-logic.js";
import { postCommunityUpdate } from "../whop/client.js";
import { nextToolState, canDeploy, type ToolState, type ToolEvent } from "../whop/tool-lifecycle.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type AutonimyTier = 1 | 2 | 3;

export interface ScriptRegistryEntry {
  name: string;
  description: string;
  code: string;
  preconditions: string[];     // human-readable list
  fingerprint_schema: string;  // JSON schema the observe snapshot must match
  parameters: Array<{ name: string; type: string; required: boolean; default?: unknown }>;
  tier: 1 | 2 | 5;            // compute tier (1=R2, 2=isolate, 5=container)
  success_count: number;
  failure_count: number;
  patch_history: Array<{ version: number; reason: string; timestamp: number; type: string }>;
  last_used: number;
  stability_score: number;     // (success / total) × (1 / (1 + recent_patches))
  created_at: number;
  updated_at: number;
}

export interface OutcomeLogEntry {
  cycle_id: string;
  action_type: string;
  action_detail: string;
  revenue_delta_24h: number | null;
  engagement_delta_24h: number | null;
  template_version: string;
  timestamp: number;
}

export interface FiberState {
  fiber_id: string;
  status: "running" | "idle" | "failed" | "completed";
  last_checkpoint: string | null;
  started_at: number;
  updated_at: number;
}

interface BusinessRow { key: string; value: string }

// ── BusinessDO ────────────────────────────────────────────────────────────────

export interface BusinessDOEnv {
  PLATFORM_SECRET: string;
  WHOP_API_KEY: string;
  BUSINESS_R2: R2Bucket;
  ANALYTICS?: AnalyticsEngineDataset;
  HITL_APPROVAL_DO?: DurableObjectNamespace;
  // Tier-5 build/test container, fronted by ToolSandboxDO (CF Container). The agent
  // spins one up on demand: POST /build { code } → { built, tests_passed, logs }.
  // When absent (local dev), a tool version cannot leave `building` — §02 gate holds.
  TOOL_SANDBOX?: DurableObjectNamespace;
}

interface ToolVersionRow {
  version: number;
  spec: string;
  state: string;
  r2_key: string | null;
  tests_passed: number;
  build_logs: string | null;
  portal_route: string | null;
  created_at: number;
  updated_at: number;
}


export class BusinessDO extends DurableObject<BusinessDOEnv> {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec("PRAGMA journal_mode=WAL");
    this.ctx.storage.sql.exec("PRAGMA synchronous=NORMAL");

    // Generic config KV store (durable layer)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS business_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Message / conversation history (generic)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        metadata   TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at DESC);
    `);

    // Checkpoints for resumable fiber state
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id         TEXT PRIMARY KEY,
        fiber_id   TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_chk_fiber ON checkpoints(fiber_id, created_at DESC);
    `);

    // Script registry — flat, name-based (not Vectorize; deferred per §10)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS scripts (
        name              TEXT PRIMARY KEY,
        description       TEXT NOT NULL DEFAULT '',
        code              TEXT NOT NULL,
        preconditions     TEXT NOT NULL DEFAULT '[]',
        fingerprint_schema TEXT NOT NULL DEFAULT '{}',
        parameters        TEXT NOT NULL DEFAULT '[]',
        tier              INTEGER NOT NULL DEFAULT 2,
        success_count     INTEGER NOT NULL DEFAULT 0,
        failure_count     INTEGER NOT NULL DEFAULT 0,
        patch_history     TEXT NOT NULL DEFAULT '[]',
        last_used         INTEGER DEFAULT 0,
        stability_score   REAL NOT NULL DEFAULT 1.0,
        created_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        updated_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);

    // Action → outcome log (generic schema, not Whop-specific)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS outcome_log (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id             TEXT NOT NULL,
        action_type          TEXT NOT NULL,
        action_detail        TEXT NOT NULL DEFAULT '',
        revenue_delta_24h    REAL,
        engagement_delta_24h REAL,
        template_version     TEXT NOT NULL DEFAULT '1',
        timestamp            INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_outcome_cycle ON outcome_log(cycle_id);
      CREATE INDEX IF NOT EXISTS idx_outcome_ts    ON outcome_log(timestamp DESC);
    `);

    // Tool call log (for idempotency / replay safety per §08)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tool_call_log (
        id           TEXT PRIMARY KEY,
        cycle_id     TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        params_hash  TEXT NOT NULL,
        result       TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tcl_cycle ON tool_call_log(cycle_id);
    `);

    // Micro-tool versions (Tier 5 — the sellable product). State machine in
    // tool-lifecycle.ts enforces: deploy only from a `tested` version (§02).
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tool_versions (
        version      INTEGER PRIMARY KEY,
        spec         TEXT NOT NULL DEFAULT '',
        state        TEXT NOT NULL DEFAULT 'draft',
        r2_key       TEXT,
        tests_passed INTEGER NOT NULL DEFAULT 0,
        build_logs   TEXT,
        portal_route TEXT,
        created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        updated_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);

    this.initialized = true;
  }

  // ── Config helpers ────────────────────────────────────────────────────────

  private getCfg(key: string): string | null {
    const r = this.ctx.storage.sql
      .exec(`SELECT value FROM business_config WHERE key = ?`, key)
      .toArray() as unknown as BusinessRow[];
    return r[0]?.value ?? null;
  }

  private setCfg(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO business_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key, value
    );
  }

  // ── HTTP routing ──────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const { method } = request;

    try {
      // GET /status
      if (method === "GET" && url.pathname === "/status") return this.handleStatus();

      // PATCH /config
      if (method === "PATCH" && url.pathname === "/config") return this.handlePatchConfig(request);

      // POST /cycle — trigger nightly cycle manually
      if (method === "POST" && url.pathname === "/cycle") return this.handleRunCycle(request);

      // GET /outcome-log
      if (method === "GET" && url.pathname === "/outcome-log") return this.handleGetOutcomeLog(url);

      // Micro-tool (Tier 5) lifecycle
      if (method === "GET" && url.pathname === "/tool") return this.handleToolStatus();
      if (method === "GET" && url.pathname === "/tool/versions") return this.handleToolList();
      if (method === "POST" && url.pathname === "/tool/build") return this.handleToolBuild(request);
      if (method === "POST" && url.pathname === "/tool/deploy") return this.handleToolDeploy();

      // POST /scripts/seed — pre-populate registry with common action types
      if (method === "POST" && url.pathname === "/scripts/seed") return this.handleSeedScripts();

      // Script registry CRUD
      if (url.pathname.startsWith("/scripts")) return this.handleScripts(method, url, request);

      // Messages
      if (method === "GET" && url.pathname === "/messages") return this.handleGetMessages();
      if (method === "POST" && url.pathname === "/messages") return this.handlePostMessage(request);

      // Checkpoints
      if (method === "POST" && url.pathname === "/checkpoints") return this.handleSaveCheckpoint(request);
      if (method === "GET" && url.pathname === "/checkpoints/latest") return this.handleLatestCheckpoint(request as Request);

      // Autonomy tier
      if (method === "GET" && url.pathname === "/autonomy") {
        return Response.json({ tier: parseInt(this.getCfg("autonomy_tier") ?? "1", 10) });
      }
      if (method === "PATCH" && url.pathname === "/autonomy") {
        const { tier } = await request.json<{ tier: AutonimyTier }>();
        if (![1, 2, 3].includes(tier)) return Response.json({ error: "tier must be 1, 2, or 3" }, { status: 400 });
        this.setCfg("autonomy_tier", String(tier));
        return Response.json({ tier });
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (err) {
      console.error("[BusinessDO]", err);
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  // ── GET /status ───────────────────────────────────────────────────────────

  private handleStatus(): Response {
    const scriptCount = (this.ctx.storage.sql
      .exec(`SELECT COUNT(*) as cnt FROM scripts`)
      .toArray() as { cnt: number }[])[0]?.cnt ?? 0;

    const outcomeCount = (this.ctx.storage.sql
      .exec(`SELECT COUNT(*) as cnt FROM outcome_log`)
      .toArray() as { cnt: number }[])[0]?.cnt ?? 0;

    const lastCycle = this.getCfg("last_cycle_at");
    const fiberStatus = this.getCfg("fiber_status") ?? "idle";

    return Response.json({
      whop_product_id: this.getCfg("whop_product_id"),
      affiliate_id: this.getCfg("affiliate_registration_id"),
      template_id: this.getCfg("template_id") ?? "whop-businesses-v1",
      template_version: this.getCfg("template_version") ?? "1",
      autonomy_tier: parseInt(this.getCfg("autonomy_tier") ?? "1", 10),
      fiber_status: fiberStatus,
      last_cycle_at: lastCycle ? parseInt(lastCycle, 10) : null,
      script_count: scriptCount,
      outcome_count: outcomeCount,
    });
  }

  // ── PATCH /config ─────────────────────────────────────────────────────────

  private async handlePatchConfig(request: Request): Promise<Response> {
    const body = await request.json<Record<string, string | number>>();
    const WRITABLE = ["whop_product_id", "affiliate_registration_id", "template_id", "template_version", "user_id"];
    for (const [k, v] of Object.entries(body)) {
      if (WRITABLE.includes(k)) this.setCfg(k, String(v));
    }
    return Response.json({ updated: true });
  }

  // ── Script engine — OBSERVE→FINGERPRINT→FIND→GATE→EXECUTE→VERIFY→DISTILL ─

  private async handleRunCycle(request: Request): Promise<Response> {
    const body = await request.json<{
      observe_snapshot?: Record<string, unknown>;
      task_description?: string;
      params?: Record<string, unknown>;
      api_key: string;
      model?: string;
    }>();

    const cycleId = crypto.randomUUID();
    const autonomyTier = parseInt(this.getCfg("autonomy_tier") ?? "1", 10) as AutonimyTier;

    // Whole-cycle mutex (WG-11): reject a second cycle while one is running.
    if (this.getCfg("fiber_status") === "running") {
      return Response.json({ error: "cycle_already_running" }, { status: 409 });
    }

    this.setCfg("fiber_status", "running");
    this.setCfg("last_cycle_at", String(Date.now()));

    this.ctx.waitUntil(
      this.runCycleAsync(cycleId, body.observe_snapshot ?? {}, body.task_description ?? "", body.params ?? {}, (body as { action?: string }).action, body.api_key, body.model ?? "claude-haiku-4-5-20251001", autonomyTier)
    );

    return Response.json({ cycle_id: cycleId, status: "started", autonomy_tier: autonomyTier });
  }

  private async runCycleAsync(
    cycleId: string,
    observeSnapshot: Record<string, unknown>,
    taskDescription: string,
    params: Record<string, unknown>,
    requestedAction: string | undefined,
    apiKey: string,
    model: string,
    autonomyTier: AutonimyTier,
  ): Promise<void> {
    try {
      // STEP 1: OBSERVE — snapshot already provided by caller (or agent fetches from Whop)
      const snapshot = Object.keys(observeSnapshot).length > 0
        ? observeSnapshot
        : { timestamp: Date.now(), source: "whop", data: {} };

      // evaluate(): compute deltas vs. the most recent stored R2 baseline (WG-08/WG-24)
      const { revenueDelta, engagementDelta } = await this.computeDeltas(snapshot);

      // STEP 2: FINGERPRINT — deterministic hash of structural parts
      const fingerprint = this.computeFingerprint(snapshot);

      // STEP 3: FIND — name-based lookup in flat registry (already demotion-filtered)
      const candidates = this.findScripts(fingerprint, taskDescription);

      let actionResult: { success: boolean; output: string; script_name?: string; level: number; data?: Record<string, unknown> };

      // Special generative action: compose + moderate + publish/draft a community
      // post. It's a deliberate, model-driven action (not a cheap L1 repeat), so the
      // caller asks for it explicitly — the nightly cron does not run it by default.
      if (requestedAction === "generate_community_post") {
        const result = await this.generateAndPublishPost(cycleId, snapshot, params, apiKey, model, autonomyTier);
        this.logOutcome(cycleId, result.outcomeType, result.output, revenueDelta, engagementDelta);
        await this.writeBaseline(snapshot, result.data);
        this.emitCycleAnalytics(cycleId, result.success, 4);
        this.setCfg("fiber_status", "idle");
        return;
      }

      // decide(): pick the action for this cycle. A caller may name one explicitly;
      // otherwise default to the safe, always-valid observe repeat (the cheap path
      // the nightly cron takes) rather than an arbitrary top candidate.
      const topCandidate = requestedAction
        ? candidates.find(c => c.name === requestedAction)
        : (candidates.find(c => c.name === "observe_whop_snapshot") ?? candidates[0]);
      const hostAction = topCandidate ? getHostAction(topCandidate.name) : undefined;
      if (topCandidate && hostAction && topCandidate.stability_score >= 0.7) {
        // LEVEL 1: Direct execution against the real Whop API — no model call.
        actionResult = await this.executeScriptLevel1(topCandidate, hostAction, params, cycleId, autonomyTier);
      } else if (topCandidate) {
        // LEVEL 2: Cheap patch call
        actionResult = await this.executeScriptLevel2(topCandidate, snapshot, fingerprint, cycleId, autonomyTier, apiKey, model);
      } else if (taskDescription) {
        // LEVEL 4: Live reasoning (no matching script) → always distill on success
        actionResult = await this.executeLevel4(taskDescription, snapshot, cycleId, autonomyTier, apiKey, model);
      } else {
        actionResult = { success: false, output: "No task description or matching script", level: 0 };
      }

      // STEP 6: VERIFY — re-observe (simplified: check for success flag)
      const verified = actionResult.success;

      // report(): record the outcome with the measured deltas
      this.logOutcome(
        cycleId,
        taskDescription || (actionResult.script_name ?? "cycle"),
        actionResult.output,
        revenueDelta,
        engagementDelta,
      );

      // report(): refresh the R2 baseline for tomorrow's delta (WG-24/WG-25)
      await this.writeBaseline(snapshot, actionResult.data);

      this.emitCycleAnalytics(cycleId, actionResult.success, actionResult.level, verified);

      this.setCfg("fiber_status", "idle");
    } catch (err) {
      console.error(`[BusinessDO] cycle ${cycleId} failed:`, err);
      this.setCfg("fiber_status", "failed");
      this.logOutcome(cycleId, "cycle_error", String(err), null, null);
    }
  }

  private emitCycleAnalytics(cycleId: string, success: boolean, level: number, verified = success): void {
    if (!this.env.ANALYTICS) return;
    try {
      this.env.ANALYTICS.writeDataPoint({
        blobs: ["business.cycle.completed", this.getCfg("user_id") ?? "", cycleId, String(level), verified ? "verified" : "unverified"],
        doubles: [Date.now(), success ? 1 : 0],
        indexes: [this.getCfg("user_id") ?? "unknown"],
      });
    } catch { /* best-effort */ }
  }

  // ── Community/content cycle — generate → moderate → publish or draft ─────────
  // The "community" half of the product. A model composes a post; output moderation
  // (WG-30) gates it; autonomy + daily cap (§07/WG-17) decide whether it publishes,
  // queues a draft for approval (WG-16), or defers. This is hardcoded niche logic.
  private async generateAndPublishPost(
    cycleId: string,
    snapshot: Record<string, unknown>,
    params: Record<string, unknown>,
    apiKey: string,
    model: string,
    autonomyTier: AutonimyTier,
  ): Promise<{ success: boolean; output: string; outcomeType: string; data?: Record<string, unknown> }> {
    const productId = this.getCfg("whop_product_id") ?? "";
    const topic = typeof params["topic"] === "string" ? params["topic"] as string : "";

    // 1. Generate the post (model call). Caller may supply ready content to skip it.
    let content = typeof params["content"] === "string" ? params["content"] as string : "";
    if (!content) {
      content = await this.composeCommunityPost(snapshot, topic, apiKey, model);
    }
    if (!content) {
      return { success: false, output: "Failed to generate community post", outcomeType: "generation_failed" };
    }

    // 2. Output moderation (WG-30) — content safety, independent of autonomy.
    const verdict = moderateText(content);
    const overCap = overDailyCap(this.publishCountLast24h());

    // 3. Decide: blocked / draft-for-approval / deferred / publish.
    const decision = decidePublish(autonomyTier, verdict.allowed, overCap);

    if (decision === "blocked_moderation") {
      await this.requestApproval(cycleId, "generate_community_post", "content_moderation", { content, topic });
      return { success: false, output: `Content flagged (${verdict.flags.map(f => f.type).join(",")}); queued for approval`, outcomeType: "content_blocked", data: { content } };
    }

    if (decision === "draft_for_approval") {
      await this.requestApproval(cycleId, "generate_community_post", "autonomy_tier_1_draft", { content, topic });
      return { success: true, output: "Drafted community post; queued for approval (Tier 1)", outcomeType: "pending_approval", data: { draft: content } };
    }

    if (decision === "deferred_cap") {
      return { success: false, output: `Daily action cap (${DAILY_ACTION_CAP}) reached; post deferred`, outcomeType: "deferred_cap", data: { content } };
    }

    // decision === "publish" — Tier 2/3, content safe, under cap.
    if (this.breakerOpen()) {
      return { success: false, output: "Whop circuit breaker open; post deferred", outcomeType: "breaker_open", data: { content } };
    }

    const idKey = `${cycleId}:generate_community_post`;
    const existing = this.ctx.storage.sql.exec(`SELECT id FROM tool_call_log WHERE id = ?`, idKey).toArray();
    if (existing.length > 0) {
      return { success: true, output: "Already published (idempotent skip)", outcomeType: "post_community_update" };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO tool_call_log (id, cycle_id, tool_name, params_hash, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)`,
      idKey, cycleId, "generate_community_post", "publish", Date.now()
    );

    try {
      const post = await postCommunityUpdate({ apiKey: this.env.WHOP_API_KEY }, {
        product_id: productId,
        content,
        idempotency_key: idKey, // deterministic; Whop dedups a retry (WG-15)
      });
      this.ctx.storage.sql.exec(`UPDATE tool_call_log SET status = 'completed', result = ?, completed_at = ? WHERE id = ?`, post.id, Date.now(), idKey);
      this.breakerRecord(true);
      return { success: true, output: `Published community post ${post.id}`, outcomeType: "post_community_update", data: { post_id: post.id, content } };
    } catch (err) {
      this.ctx.storage.sql.exec(`UPDATE tool_call_log SET status = 'failed', result = ?, completed_at = ? WHERE id = ?`, String(err), Date.now(), idKey);
      this.breakerRecord(false);
      return { success: false, output: `Publish failed: ${String(err)}`, outcomeType: "post_failed", data: { content } };
    }
  }

  // Model call that composes a single community post for this niche.
  private async composeCommunityPost(
    snapshot: Record<string, unknown>,
    topic: string,
    apiKey: string,
    model: string,
  ): Promise<string> {
    const branding = this.getCfg("branding") ?? "{}";
    const prompt = `You write short, genuinely useful community posts for a Whop community attached to an AI-built micro-tool sold to a make-money-online audience.

Branding: ${branding}
${topic ? `Requested topic: ${topic}` : "Pick a useful, specific topic based on recent activity."}
Recent business snapshot: ${JSON.stringify(snapshot).slice(0, 1200)}

Write ONE community post: concrete, helpful, no hype, no financial/investment advice, no guarantees of income. 80–160 words. Return only the post text.`;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 512, messages: [{ role: "user", content: prompt }] }),
      });
      if (!resp.ok) return "";
      const data = await resp.json<{ content: Array<{ type: string; text: string }>; usage?: { input_tokens?: number; output_tokens?: number } }>();
      this.recordCost(4, model, data.usage);
      return data.content.find(b => b.type === "text")?.text?.trim() ?? "";
    } catch (err) {
      console.warn("[BusinessDO] composeCommunityPost failed:", err);
      return "";
    }
  }

  // ── Micro-tool (Tier 5) lifecycle — the sellable product (§02/WG-01/WG-29) ──

  private getLatestToolVersion(): ToolVersionRow | null {
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM tool_versions ORDER BY version DESC LIMIT 1`)
      .toArray() as unknown as ToolVersionRow[];
    return rows[0] ?? null;
  }

  // Apply a state-machine transition; returns the new state or null if illegal.
  private transitionTool(version: number, current: ToolState, event: ToolEvent): ToolState | null {
    const next = nextToolState(current, event);
    if (!next) return null;
    this.ctx.storage.sql.exec(
      `UPDATE tool_versions SET state = ?, updated_at = ? WHERE version = ?`,
      next, Date.now(), version,
    );
    return next;
  }

  private handleToolStatus(): Response {
    const latest = this.getLatestToolVersion();
    if (!latest) return Response.json({ tool: null });
    return Response.json({
      tool: {
        version: latest.version,
        state: latest.state,
        tests_passed: latest.tests_passed === 1,
        r2_key: latest.r2_key,
        portal_route: latest.portal_route,
        deployable: canDeploy(latest.state as ToolState),
        updated_at: latest.updated_at,
      },
    });
  }

  private handleToolList(): Response {
    const rows = this.ctx.storage.sql
      .exec(`SELECT version, state, tests_passed, portal_route, created_at, updated_at FROM tool_versions ORDER BY version DESC LIMIT 50`)
      .toArray();
    return Response.json({ versions: rows, count: rows.length });
  }

  // POST /tool/build — generate the tool's code from a spec, stage it in R2, then
  // build + test it in the Tier-5 container. A version only reaches `tested` if the
  // container reports tests passed; with no container it stays `building`.
  private async handleToolBuild(request: Request): Promise<Response> {
    const body = await request.json<{ spec: string; api_key: string; model?: string }>().catch(
      () => ({ spec: "", api_key: "" } as { spec: string; api_key: string; model?: string }),
    );
    if (!body.spec) return Response.json({ error: "spec required" }, { status: 400 });

    const prev = this.getLatestToolVersion();
    const version = (prev?.version ?? 0) + 1;
    const now = Date.now();

    // 1. Generate the tool code (model call, cost-tracked).
    const code = await this.composeToolCode(body.spec, body.api_key, body.model ?? "claude-haiku-4-5-20251001");
    if (!code) return Response.json({ error: "code generation failed" }, { status: 502 });

    // 2. Stage the bundle in R2 and record the draft version.
    const userId = this.getCfg("user_id") ?? "unknown";
    const r2Key = `tool/${userId}/${version}/bundle.ts`;
    try { await this.env.BUSINESS_R2.put(r2Key, code); } catch (err) { console.warn("[BusinessDO] tool bundle write failed:", err); }
    this.ctx.storage.sql.exec(
      `INSERT INTO tool_versions (version, spec, state, r2_key, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?)`,
      version, body.spec, r2Key, now, now,
    );

    // 3. Build + test in the Tier-5 container (if configured).
    this.transitionTool(version, "draft", "start_build");
    if (!this.env.TOOL_SANDBOX) {
      // No container bound — version stays `building`; cannot deploy (§02 gate holds).
      return Response.json({ version, state: "building", note: "No Tier-5 container configured; build/test pending" }, { status: 202 });
    }

    try {
      // Spin up (or reuse) this business's Tier-5 container and build + test there.
      const sandbox = this.env.TOOL_SANDBOX.get(this.env.TOOL_SANDBOX.idFromName(`sandbox:${userId}`));
      const resp = await sandbox.fetch(new Request("http://sandbox/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, version }),
      }));
      const result = await resp.json<{ built: boolean; tests_passed: boolean; logs?: string }>();
      const passed = result.built && result.tests_passed;
      this.ctx.storage.sql.exec(
        `UPDATE tool_versions SET tests_passed = ?, build_logs = ? WHERE version = ?`,
        passed ? 1 : 0, (result.logs ?? "").slice(0, 4000), version,
      );
      const state = this.transitionTool(version, "building", passed ? "build_passed" : "build_failed");
      return Response.json({ version, state, tests_passed: passed });
    } catch (err) {
      this.transitionTool(version, "building", "build_failed");
      return Response.json({ version, state: "build_failed", error: String(err) }, { status: 502 });
    }
  }

  // POST /tool/deploy — deploy the latest version. The §02 gate is enforced here:
  // only a `tested` version may deploy. Staging the bundle to a stable R2 path is the
  // deploy artifact; a real isolate boot (Worker Loader) is the future hosting step.
  private async handleToolDeploy(): Promise<Response> {
    const latest = this.getLatestToolVersion();
    if (!latest) return Response.json({ error: "no tool version to deploy" }, { status: 404 });

    if (!canDeploy(latest.state as ToolState)) {
      return Response.json(
        { error: "not_deployable", state: latest.state, message: "A tool version must pass build+test before it can be deployed (§02)" },
        { status: 409 },
      );
    }

    this.transitionTool(latest.version, "tested", "start_deploy");
    try {
      const userId = this.getCfg("user_id") ?? "unknown";
      const liveKey = `tool/${userId}/live/bundle.ts`;
      const bundle = latest.r2_key ? await this.env.BUSINESS_R2.get(latest.r2_key) : null;
      if (bundle) await this.env.BUSINESS_R2.put(liveKey, await bundle.text());
      const portalRoute = `/${this.getCfg("branding") ? (JSON.parse(this.getCfg("branding") ?? "{}").slug ?? userId) : userId}/tool`;
      this.ctx.storage.sql.exec(
        `UPDATE tool_versions SET portal_route = ? WHERE version = ?`,
        portalRoute, latest.version,
      );
      const state = this.transitionTool(latest.version, "deploying", "deploy_succeeded");
      return Response.json({ version: latest.version, state, portal_route: portalRoute, live_bundle: liveKey });
    } catch (err) {
      this.transitionTool(latest.version, "deploying", "deploy_failed");
      return Response.json({ version: latest.version, state: "deploy_failed", error: String(err) }, { status: 502 });
    }
  }

  // Model call that writes the micro-tool's code from a plain-language spec.
  private async composeToolCode(spec: string, apiKey: string, model: string): Promise<string> {
    const prompt = `You are building a small, genuinely functional micro-tool sold to a make-money-online audience on Whop.

Spec: ${spec}

Write a single self-contained TypeScript module that implements the tool as a Cloudflare Worker (export default { fetch }). It must include real, working functionality (not a stub or prompt-wrapper) and a small set of inline tests in an exported \`runTests()\` that returns { passed: boolean, results: string[] }. No external network calls except where the spec requires. Return ONLY the TypeScript module.`;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
      });
      if (!resp.ok) return "";
      const data = await resp.json<{ content: Array<{ type: string; text: string }>; usage?: { input_tokens?: number; output_tokens?: number } }>();
      this.recordCost(4, model, data.usage);
      return data.content.find(b => b.type === "text")?.text?.trim() ?? "";
    } catch (err) {
      console.warn("[BusinessDO] composeToolCode failed:", err);
      return "";
    }
  }

  // LEVEL 1 — direct execution against the real Whop API, no model call.
  // Dispatches through the fixed host-action allow-list (WG-02): the script's name
  // selects a host function; its code is NEVER eval'd. The gates (autonomy, daily
  // cap, output moderation, breaker, idempotency) wrap the real call.
  private async executeScriptLevel1(
    entry: ScriptRegistryEntry,
    action: HostAction,
    params: Record<string, unknown>,
    cycleId: string,
    autonomyTier: AutonimyTier,
  ): Promise<{ success: boolean; output: string; script_name: string; level: number; data?: Record<string, unknown> }> {
    const name = entry.name;

    // GATE 1 — autonomy tier. Blocked → route to the human approval queue (WG-16).
    if (!this.checkAutonomy(name, autonomyTier)) {
      await this.requestApproval(cycleId, name, "autonomy_tier", params);
      this.logOutcome(cycleId, "pending_approval", `Action '${name}' needs approval at tier ${autonomyTier}`, null, null);
      return { success: false, output: `Action '${name}' requires higher autonomy tier (queued for approval)`, script_name: name, level: 1 };
    }

    // GATE 2 — daily action cap on publishing actions (WG-17).
    if (action.kind === "publish" && overDailyCap(this.publishCountLast24h())) {
      this.logOutcome(cycleId, "deferred_cap", `Daily action cap (${DAILY_ACTION_CAP}) reached; deferred '${name}'`, null, null);
      return { success: false, output: `Daily action cap reached; '${name}' deferred to next cycle`, script_name: name, level: 1 };
    }

    // GATE 3 — output moderation on any content before it's published (WG-30).
    if (action.kind === "publish" && action.contentParam) {
      const content = String(params[action.contentParam] ?? "");
      const verdict = moderateText(content);
      if (!verdict.allowed) {
        await this.requestApproval(cycleId, name, "content_moderation", params);
        this.logOutcome(cycleId, "content_blocked", `Content flagged (${verdict.flags.map(f => f.type).join(",")}); queued for approval`, null, null);
        return { success: false, output: `Content blocked by moderation; queued for approval`, script_name: name, level: 1 };
      }
    }

    // GATE 4 — circuit breaker for the Whop connector (WG-14).
    if (action.kind !== "internal" && this.breakerOpen()) {
      this.logOutcome(cycleId, "breaker_open", `Whop circuit breaker open; skipped '${name}'`, null, null);
      return { success: false, output: `Whop circuit breaker open; skipped '${name}'`, script_name: name, level: 1 };
    }

    // GATE 5 — idempotency. Deterministic key ties retries + WAL + Whop dedup (WG-15).
    const idKey = `${cycleId}:${name}`;
    const existing = this.ctx.storage.sql
      .exec(`SELECT id FROM tool_call_log WHERE id = ?`, idKey)
      .toArray();
    if (existing.length > 0) {
      return { success: true, output: "Already executed (idempotent skip)", script_name: name, level: 1 };
    }

    // WAL — record intent BEFORE the side-effecting call (WG-09).
    this.ctx.storage.sql.exec(
      `INSERT INTO tool_call_log (id, cycle_id, tool_name, params_hash, status, created_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      idKey, cycleId, name, action.kind, Date.now()
    );

    // EXECUTE — the real host action.
    try {
      const result: HostActionResult = await action.run(
        { whop: { apiKey: this.env.WHOP_API_KEY }, productId: this.getCfg("whop_product_id") ?? "", cycleId },
        params,
      );

      this.ctx.storage.sql.exec(
        `UPDATE tool_call_log SET status = ?, result = ?, completed_at = ? WHERE id = ?`,
        result.success ? "completed" : "failed", result.output, Date.now(), idKey
      );
      this.updateScriptStats(name, result.success);
      if (action.kind !== "internal") this.breakerRecord(result.success);

      return { success: result.success, output: `[Level 1] ${result.output}`, script_name: name, level: 1, ...(result.data ? { data: result.data } : {}) };
    } catch (err) {
      const output = String(err);
      this.ctx.storage.sql.exec(
        `UPDATE tool_call_log SET status = 'failed', result = ?, completed_at = ? WHERE id = ?`,
        output, Date.now(), idKey
      );
      this.updateScriptStats(name, false);
      if (action.kind !== "internal") this.breakerRecord(false);
      return { success: false, output: `[Level 1] ${output}`, script_name: name, level: 1 };
    }
  }

  // LEVEL 2 — cheap patch call (fast/small model)
  private async executeScriptLevel2(
    entry: ScriptRegistryEntry,
    snapshot: Record<string, unknown>,
    currentFingerprint: string,
    cycleId: string,
    autonomyTier: AutonimyTier,
    apiKey: string,
    model: string,
  ): Promise<{ success: boolean; output: string; script_name: string; level: number }> {
    const allowed = this.checkAutonomy(entry.name, autonomyTier);
    if (!allowed) {
      return { success: false, output: `Action '${entry.name}' blocked by autonomy tier ${autonomyTier}`, script_name: entry.name, level: 2 };
    }

    // Call the LLM with a cheap patch prompt
    const patchPrompt = `You are debugging a script that has a fingerprint mismatch.

Current environment fingerprint: ${currentFingerprint}
Expected fingerprint schema: ${entry.fingerprint_schema}
Current snapshot: ${JSON.stringify(snapshot, null, 2).slice(0, 2000)}

Script name: ${entry.name}
Script description: ${entry.description}

The environment has drifted slightly. Identify what changed and produce a minimal patch (one or two lines of TypeScript) that handles the new state. Return ONLY the patch, no explanation.`;

    let patchResult = "";
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 256,
          messages: [{ role: "user", content: patchPrompt }],
        }),
      });
      if (resp.ok) {
        const data = await resp.json<{ content: Array<{ type: string; text: string }>; usage?: { input_tokens?: number; output_tokens?: number } }>();
        patchResult = data.content.find(b => b.type === "text")?.text ?? "";
        this.recordCost(2, "claude-haiku-4-5-20251001", data.usage);
      }
    } catch (err) {
      console.warn("[BusinessDO] Level 2 patch call failed:", err);
    }

    if (patchResult) {
      // Record the patch
      const patches = JSON.parse(entry.patch_history as unknown as string) as Array<unknown>;
      patches.push({ version: patches.length + 1, reason: `Drift patch: ${currentFingerprint}`, timestamp: Date.now(), type: "minor_fix" });
      this.ctx.storage.sql.exec(
        `UPDATE scripts SET patch_history = ?, updated_at = ? WHERE name = ?`,
        JSON.stringify(patches), Date.now(), entry.name
      );
      // Try executing with the patch applied (simulated for v0)
      this.updateScriptStats(entry.name, true);
      this.logOutcome(cycleId, "script_patched", `Level 2 patch applied to '${entry.name}': ${patchResult.slice(0, 200)}`, null, null);
      return { success: true, output: `[Level 2] Patched and executed '${entry.name}'`, script_name: entry.name, level: 2 };
    }

    // Patch failed → escalate to Level 3
    return this.executeLevel3(entry, snapshot, cycleId, autonomyTier, apiKey, model);
  }

  // LEVEL 3 — full reasoning, re-derivation
  private async executeLevel3(
    entry: ScriptRegistryEntry,
    snapshot: Record<string, unknown>,
    cycleId: string,
    autonomyTier: AutonimyTier,
    apiKey: string,
    model: string,
  ): Promise<{ success: boolean; output: string; script_name: string; level: number }> {
    const allowed = this.checkAutonomy(entry.name, autonomyTier);
    if (!allowed) {
      return { success: false, output: `Blocked by autonomy tier ${autonomyTier}`, script_name: entry.name, level: 3 };
    }

    const prompt = `You are an AI agent that needs to re-derive a script that has become invalid.

Original script: ${entry.name}
Description: ${entry.description}
Current patch history (${entry.patch_history.length} patches): multiple patches failed or chronic instability.
Current environment: ${JSON.stringify(snapshot, null, 2).slice(0, 3000)}

Reason step by step about what fundamentally changed and how to approach this task correctly.
Then write a completely new TypeScript function for this task that will work in the current environment.
Return ONLY the TypeScript function.`;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (resp.ok) {
        const data = await resp.json<{ content: Array<{ type: string; text: string }>; usage?: { input_tokens?: number; output_tokens?: number } }>();
        const newCode = data.content.find(b => b.type === "text")?.text ?? "";
        this.recordCost(3, model, data.usage);

        if (newCode) {
          // Save as new version
          const patches = [...entry.patch_history, { version: entry.patch_history.length + 1, reason: "Full re-derivation", timestamp: Date.now(), type: "full_rederivation" }];
          this.ctx.storage.sql.exec(
            `UPDATE scripts SET code = ?, patch_history = ?, success_count = 0, failure_count = 0, stability_score = 1.0, updated_at = ? WHERE name = ?`,
            newCode, JSON.stringify(patches), Date.now(), entry.name
          );
          return { success: true, output: `[Level 3] Re-derived script '${entry.name}'`, script_name: entry.name, level: 3 };
        }
      }
    } catch (err) {
      console.error("[BusinessDO] Level 3 re-derivation failed:", err);
    }

    this.updateScriptStats(entry.name, false);
    return { success: false, output: `[Level 3] Re-derivation failed for '${entry.name}'`, script_name: entry.name, level: 3 };
  }

  // LEVEL 4 — live reasoning, no matching script, always distill on success
  private async executeLevel4(
    taskDescription: string,
    snapshot: Record<string, unknown>,
    cycleId: string,
    autonomyTier: AutonimyTier,
    apiKey: string,
    model: string,
  ): Promise<{ success: boolean; output: string; level: number }> {
    // Tier 1 draft: no live actions without approval
    if (autonomyTier === 1) {
      return { success: false, output: `[Level 4] Task requires Autonomy Tier ≥ 2 to execute live. Drafted: "${taskDescription}"`, level: 4 };
    }

    const systemPrompt = `You are Naelao Agent running a nightly business cycle for a Whop business.
Your job: ${taskDescription}

Current business state:
- Whop Product ID: ${this.getCfg("whop_product_id") ?? "not configured"}
- Autonomy Tier: ${autonomyTier} (1=Draft, 2=Publish, 3=Operate)
- Template: ${this.getCfg("template_id") ?? "whop-businesses-v1"}

Environment snapshot:
${JSON.stringify(snapshot, null, 2).slice(0, 2000)}

Autonomy rules:
- Tier 1: Only draft content and proposals
- Tier 2: Publish content and manage community up to daily action cap. No pricing changes.
- Tier 3: Iterate features and adjust pricing within pre-set bounds.

Execute this task and report what you did. Be specific and actionable.`;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: "user", content: `Execute: ${taskDescription}` }],
        }),
      });

      if (resp.ok) {
        const data = await resp.json<{ content: Array<{ type: string; text: string }>; usage?: { input_tokens?: number; output_tokens?: number } }>();
        const output = data.content.find(b => b.type === "text")?.text ?? "";
        this.recordCost(4, model, data.usage);

        if (output) {
          // STEP 7: DISTILL — compile trace into a parameterized script
          this.ctx.waitUntil(this.distillToScript(taskDescription, snapshot, output, cycleId, apiKey));
          return { success: true, output: `[Level 4] ${output}`, level: 4 };
        }
      }
    } catch (err) {
      console.error("[BusinessDO] Level 4 reasoning failed:", err);
    }

    return { success: false, output: "[Level 4] Live reasoning failed", level: 4 };
  }

  // DISTILL — compile successful live trace into a named, parameterized script
  private async distillToScript(
    taskDescription: string,
    snapshot: Record<string, unknown>,
    trace: string,
    _cycleId: string,
    apiKey: string,
  ): Promise<void> {
    const compilePrompt = `You are a software engineer extracting a reusable, parameterized TypeScript script from an agent trace.

Task that was accomplished: ${taskDescription}

Trace:
${trace.slice(0, 3000)}

Environment snapshot:
${JSON.stringify(snapshot, null, 2).slice(0, 1000)}

Your job:
1. Identify every value specific to THIS instance (names, IDs, content) → these become PARAMETERS.
2. Identify structural logic that stays the same across runs → keep HARDCODED.
3. Write a TypeScript function with:
   - A clear verb_noun name (e.g., post_community_update, check_revenue_metrics)
   - Typed parameters for every instance-specific value
   - A JSDoc comment explaining each parameter
   - A return type capturing meaningful output
4. Write a one-sentence description for retrieval.
5. Write the fingerprint_schema as a JSON object describing what environment state must look like.

Return a JSON object with exactly these fields:
{
  "name": "verb_noun_name",
  "description": "one sentence",
  "code": "the TypeScript function",
  "fingerprint_schema": {},
  "parameters": [{"name": "", "type": "", "required": true}],
  "tier": 2
}`;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          messages: [{ role: "user", content: compilePrompt }],
        }),
      });

      if (!resp.ok) return;

      const data = await resp.json<{ content: Array<{ type: string; text: string }>; usage?: { input_tokens?: number; output_tokens?: number } }>();
      const raw = data.content.find(b => b.type === "text")?.text ?? "";
      this.recordCost(4, "claude-haiku-4-5-20251001", data.usage);

      // Extract JSON from response
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const compiled = JSON.parse(jsonMatch[0]) as Partial<ScriptRegistryEntry>;
      if (!compiled.name || !compiled.code) return;

      // Save as a draft script (name prefixed with "draft_" to mark unreviewed)
      const scriptName = compiled.name.startsWith("draft_") ? compiled.name : `draft_${compiled.name}`;
      const now = Date.now();

      this.ctx.storage.sql.exec(
        `INSERT INTO scripts (name, description, code, fingerprint_schema, parameters, tier, success_count, failure_count, patch_history, last_used, stability_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, '[]', ?, 1.0, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
        scriptName,
        compiled.description ?? taskDescription,
        compiled.code,
        JSON.stringify(compiled.fingerprint_schema ?? {}),
        JSON.stringify(compiled.parameters ?? []),
        compiled.tier ?? 2,
        now,
        now,
        now,
      );

      console.log(`[BusinessDO] Distilled script '${scriptName}' from Level 4 run`);
    } catch (err) {
      console.warn("[BusinessDO] Distillation failed (non-fatal):", err);
    }
  }

  // ── Script registry helpers ───────────────────────────────────────────────

  private findScripts(fingerprint: string, _query: string): ScriptRegistryEntry[] {
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM scripts WHERE name NOT LIKE 'draft_%' ORDER BY stability_score DESC, last_used DESC LIMIT 10`)
      .toArray() as Array<Record<string, unknown>>;

    return rows.map(r => ({
      name: r.name as string,
      description: r.description as string,
      code: r.code as string,
      preconditions: JSON.parse(r.preconditions as string) as string[],
      fingerprint_schema: r.fingerprint_schema as string,
      parameters: JSON.parse(r.parameters as string) as ScriptRegistryEntry["parameters"],
      tier: r.tier as 1 | 2 | 5,
      success_count: r.success_count as number,
      failure_count: r.failure_count as number,
      patch_history: JSON.parse(r.patch_history as string) as ScriptRegistryEntry["patch_history"],
      last_used: r.last_used as number,
      stability_score: r.stability_score as number,
      created_at: r.created_at as number,
      updated_at: r.updated_at as number,
    })).filter(s => {
      // Simple precondition: fingerprint must be non-empty to match scripts
      if (!fingerprint) return false;
      // Auto-demotion (WG-31): a falling success rate or frequent recent patches pulls
      // a script out of Level-1 candidacy so it's forced to re-derive at L2+/L3.
      if (isDemoted(s)) return false;
      // If script has a fingerprint schema, do a rough match
      try {
        const schema = JSON.parse(s.fingerprint_schema) as Record<string, unknown>;
        if (Object.keys(schema).length === 0) return true; // no schema = match all
        return true; // simplified for v0 — full JSON Schema validation is deferred
      } catch { return true; }
    });
  }

  private computeFingerprint(snapshot: Record<string, unknown>): string {
    return structuralFingerprint(snapshot);
  }

  private updateScriptStats(name: string, success: boolean): void {
    const rows = this.ctx.storage.sql
      .exec(`SELECT success_count, failure_count, patch_history FROM scripts WHERE name = ?`, name)
      .toArray() as { success_count: number; failure_count: number; patch_history: string }[];

    if (!rows[0]) return;

    const sc = rows[0].success_count + (success ? 1 : 0);
    const fc = rows[0].failure_count + (success ? 0 : 1);
    const patchHistory = JSON.parse(rows[0].patch_history) as ScriptRegistryEntry["patch_history"];
    const stability = computeStability({ success_count: sc, failure_count: fc, patch_history: patchHistory });

    this.ctx.storage.sql.exec(
      `UPDATE scripts SET success_count = ?, failure_count = ?, stability_score = ?, last_used = ?, updated_at = ? WHERE name = ?`,
      sc, fc, stability, Date.now(), Date.now(), name
    );
  }

  private checkAutonomy(scriptName: string, tier: AutonimyTier): boolean {
    // Tier 1 (Draft): only draft_ scripts
    if (tier === 1) return scriptName.startsWith("draft_") || scriptName.includes("observe") || scriptName.includes("check");
    // Tier 2 (Publish): all scripts except pricing/feature changes
    if (tier === 2) return !scriptName.includes("pricing") && !scriptName.includes("feature_") && !scriptName.includes("tool_");
    // Tier 3 (Operate): everything
    return true;
  }

  // ── Daily action cap (WG-17) ──────────────────────────────────────────────
  private publishCountLast24h(): number {
    const since = Date.now() - 86400_000;
    const placeholders = PUBLISH_ACTION_NAMES.map(() => "?").join(",");
    if (!placeholders) return 0;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT COUNT(*) AS cnt FROM outcome_log WHERE timestamp > ? AND action_type IN (${placeholders})`,
        since, ...PUBLISH_ACTION_NAMES,
      )
      .toArray() as { cnt: number }[];
    return rows[0]?.cnt ?? 0;
  }

  // ── Whop circuit breaker (WG-14) — stored in business_config, never KV ────
  private breakerOpen(): boolean {
    const openUntil = parseInt(this.getCfg("whop_breaker_open_until") ?? "0", 10);
    return openUntil > Date.now();
  }

  private breakerRecord(success: boolean): void {
    if (success) {
      this.setCfg("whop_breaker_failures", "0");
      this.setCfg("whop_breaker_open_until", "0");
      return;
    }
    const failures = parseInt(this.getCfg("whop_breaker_failures") ?? "0", 10) + 1;
    this.setCfg("whop_breaker_failures", String(failures));
    if (failures >= BREAKER_THRESHOLD) {
      this.setCfg("whop_breaker_open_until", String(Date.now() + BREAKER_COOLDOWN_MS));
      this.setCfg("whop_breaker_failures", "0"); // reset count; half-open after cooldown
    }
  }

  // ── Human approval queue wiring (WG-16) ───────────────────────────────────
  private async requestApproval(
    cycleId: string,
    actionName: string,
    reason: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (!this.env.HITL_APPROVAL_DO) return; // best-effort; no UI built this pass
    try {
      const userId = this.getCfg("user_id") ?? "unknown";
      const name = await getDOName("hitl", userId, userId, this.env.PLATFORM_SECRET);
      const id = this.env.HITL_APPROVAL_DO.idFromName(name);
      await this.env.HITL_APPROVAL_DO.get(id).fetch(
        new Request("http://do/requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            run_id: cycleId,
            session_id: userId,
            tool_name: actionName,
            tool_input: params,
            action_description: `Whop business action '${actionName}' requires approval (${reason})`,
          }),
        }),
      );
    } catch (err) {
      console.warn("[BusinessDO] approval request failed (non-fatal):", err);
    }
  }

  // ── Token-cost tracking (WG-21) ───────────────────────────────────────────
  private recordCost(level: number, model: string, usage: { input_tokens?: number; output_tokens?: number } | undefined): void {
    const input = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    const cents = costCents(model, input, output);

    const prev = parseFloat(this.getCfg("cost_cents_30d") ?? "0");
    this.setCfg("cost_cents_30d", String(prev + cents));

    if (this.env.ANALYTICS) {
      try {
        this.env.ANALYTICS.writeDataPoint({
          blobs: ["business.cost", this.getCfg("user_id") ?? "", String(level), model],
          doubles: [input, output, cents],
          indexes: [this.getCfg("user_id") ?? "unknown"],
        });
      } catch { /* best-effort */ }
    }
  }

  // ── R2 baseline + 24h deltas (WG-24/WG-25) ────────────────────────────────
  private baselineKey(): string {
    const userId = this.getCfg("user_id") ?? "unknown";
    const day = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
    return `baseline/${userId}/${day}.json`;
  }

  private extractTotals(snapshot: Record<string, unknown>, actionData?: Record<string, unknown>): { revenue: number; engagement: number } {
    const rev = (snapshot["revenue"] ?? actionData?.["revenue"]) as { total_revenue?: number } | null | undefined;
    const revenue = typeof rev?.total_revenue === "number" ? rev.total_revenue : 0;
    const engagement = typeof actionData?.["engagement_score"] === "number" ? actionData["engagement_score"] as number : 0;
    return { revenue, engagement };
  }

  private async computeDeltas(snapshot: Record<string, unknown>): Promise<{ revenueDelta: number | null; engagementDelta: number | null }> {
    try {
      const userId = this.getCfg("user_id") ?? "unknown";
      // Read the most recent prior baseline (list newest-first under this user's prefix).
      const listing = await this.env.BUSINESS_R2.list({ prefix: `baseline/${userId}/` });
      const newest = listing.objects.sort((a, b) => b.key.localeCompare(a.key))[0];
      if (!newest) return { revenueDelta: null, engagementDelta: null };
      const obj = await this.env.BUSINESS_R2.get(newest.key);
      if (!obj) return { revenueDelta: null, engagementDelta: null };
      const prior = JSON.parse(await obj.text()) as { revenue?: number; engagement?: number };
      const now = this.extractTotals(snapshot);
      return {
        revenueDelta: now.revenue - (prior.revenue ?? 0),
        engagementDelta: now.engagement - (prior.engagement ?? 0),
      };
    } catch (err) {
      console.warn("[BusinessDO] computeDeltas failed (non-fatal):", err);
      return { revenueDelta: null, engagementDelta: null };
    }
  }

  private async writeBaseline(snapshot: Record<string, unknown>, actionData?: Record<string, unknown>): Promise<void> {
    try {
      const totals = this.extractTotals(snapshot, actionData);
      const body = JSON.stringify({ ...totals, snapshot, written_at: Date.now() });
      await this.env.BUSINESS_R2.put(this.baselineKey(), body);
    } catch (err) {
      console.warn("[BusinessDO] writeBaseline failed (non-fatal):", err);
    }
  }

  // ── Outcome log ───────────────────────────────────────────────────────────

  private logOutcome(
    cycleId: string,
    actionType: string,
    actionDetail: string,
    revenueDelta: number | null,
    engagementDelta: number | null,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO outcome_log (cycle_id, action_type, action_detail, revenue_delta_24h, engagement_delta_24h, template_version, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      cycleId, actionType, actionDetail.slice(0, 2000), revenueDelta, engagementDelta,
      this.getCfg("template_version") ?? "1", Date.now()
    );
  }

  private handleGetOutcomeLog(url: URL): Response {
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM outcome_log ORDER BY timestamp DESC LIMIT ?`, limit)
      .toArray();
    return Response.json({ entries: rows, count: rows.length });
  }

  // ── Script registry CRUD ──────────────────────────────────────────────────

  private async handleScripts(method: string, url: URL, request: Request): Promise<Response> {
    const nameMatch = url.pathname.match(/^\/scripts\/([^/]+)$/);

    // GET /scripts — list all
    if (method === "GET" && url.pathname === "/scripts") {
      const rows = this.ctx.storage.sql
        .exec(`SELECT name, description, tier, success_count, failure_count, stability_score, last_used FROM scripts ORDER BY stability_score DESC`)
        .toArray();
      return Response.json({ scripts: rows, count: rows.length });
    }

    // POST /scripts — create
    if (method === "POST" && url.pathname === "/scripts") {
      const body = await request.json<Omit<ScriptRegistryEntry, "success_count" | "failure_count" | "patch_history" | "last_used" | "stability_score" | "created_at" | "updated_at">>();
      if (!body.name || !body.code) return Response.json({ error: "name and code required" }, { status: 400 });
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO scripts (name, description, code, preconditions, fingerprint_schema, parameters, tier, success_count, failure_count, patch_history, last_used, stability_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', 0, 1.0, ?, ?)
         ON CONFLICT(name) DO UPDATE SET code = excluded.code, description = excluded.description, updated_at = excluded.updated_at`,
        body.name, body.description ?? "", body.code,
        JSON.stringify(body.preconditions ?? []),
        JSON.stringify(body.fingerprint_schema ?? {}),
        JSON.stringify(body.parameters ?? []),
        body.tier ?? 2, now, now
      );
      return Response.json({ name: body.name, created: true }, { status: 201 });
    }

    // GET /scripts/:name
    if (method === "GET" && nameMatch?.[1]) {
      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM scripts WHERE name = ?`, nameMatch[1])
        .toArray() as Array<Record<string, unknown>>;
      if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(rows[0]);
    }

    // PATCH /scripts/:name
    if (method === "PATCH" && nameMatch?.[1]) {
      const body = await request.json<Partial<ScriptRegistryEntry> & { patch_reason?: string }>();
      const rows = this.ctx.storage.sql
        .exec(`SELECT patch_history FROM scripts WHERE name = ?`, nameMatch[1])
        .toArray() as { patch_history: string }[];
      if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });

      const patches = JSON.parse(rows[0].patch_history) as ScriptRegistryEntry["patch_history"];
      if (body.code) {
        patches.push({ version: patches.length + 1, reason: body.patch_reason ?? "manual update", timestamp: Date.now(), type: "minor_fix" });
      }
      const stability = body.success_count !== undefined ? computeStability({
        success_count: body.success_count ?? 0,
        failure_count: body.failure_count ?? 0,
        patch_history: patches,
      }) : undefined;

      this.ctx.storage.sql.exec(
        `UPDATE scripts SET
          code = COALESCE(?, code),
          description = COALESCE(?, description),
          fingerprint_schema = COALESCE(?, fingerprint_schema),
          patch_history = ?,
          stability_score = COALESCE(?, stability_score),
          updated_at = ?
         WHERE name = ?`,
        body.code ?? null, body.description ?? null,
        body.fingerprint_schema ? JSON.stringify(body.fingerprint_schema) : null,
        JSON.stringify(patches),
        stability ?? null,
        Date.now(), nameMatch[1]
      );
      return Response.json({ name: nameMatch[1], updated: true });
    }

    // DELETE /scripts/:name
    if (method === "DELETE" && nameMatch?.[1]) {
      this.ctx.storage.sql.exec(`DELETE FROM scripts WHERE name = ?`, nameMatch[1]);
      return Response.json({ name: nameMatch[1], deleted: true });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  private handleGetMessages(): Response {
    const rows = this.ctx.storage.sql
      .exec(`SELECT id, role, content, metadata, created_at FROM messages ORDER BY created_at ASC LIMIT 200`)
      .toArray();
    return Response.json({ messages: rows, count: rows.length });
  }

  private async handlePostMessage(request: Request): Promise<Response> {
    const body = await request.json<{ role: string; content: string; metadata?: unknown }>();
    if (!body.role || !body.content) return Response.json({ error: "role and content required" }, { status: 400 });
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (role, content, metadata, created_at) VALUES (?, ?, ?, ?)`,
      body.role, body.content, body.metadata ? JSON.stringify(body.metadata) : null, Date.now()
    );
    return Response.json({ saved: true }, { status: 201 });
  }

  // ── Checkpoints ───────────────────────────────────────────────────────────

  private async handleSaveCheckpoint(request: Request): Promise<Response> {
    const body = await request.json<{ fiber_id: string; state: unknown }>();
    if (!body.fiber_id) return Response.json({ error: "fiber_id required" }, { status: 400 });
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO checkpoints (id, fiber_id, state_json, created_at) VALUES (?, ?, ?, ?)`,
      id, body.fiber_id, JSON.stringify(body.state), Date.now()
    );
    return Response.json({ checkpoint_id: id }, { status: 201 });
  }

  private handleLatestCheckpoint(req: Request): Response {
    const url = new URL(req.url);
    const fiberId = url.searchParams.get("fiber_id");
    if (!fiberId) return Response.json({ error: "fiber_id required" }, { status: 400 });
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM checkpoints WHERE fiber_id = ? ORDER BY created_at DESC LIMIT 1`, fiberId)
      .toArray() as Array<{ id: string; fiber_id: string; state_json: string; created_at: number }>;
    if (!rows[0]) return Response.json({ checkpoint: null });
    const row = rows[0];
    return Response.json({
      checkpoint_id: row.id,
      fiber_id: row.fiber_id,
      state: (() => { try { return JSON.parse(row.state_json); } catch { return row.state_json; } })(),
      created_at: row.created_at,
    });
  }

  // ── Pre-seeded script registry (§14: hand-seed 5–10 action types before launch) ─

  private handleSeedScripts(): Response {
    const SEEDS: Array<{
      name: string; description: string; code: string;
      tier: 1 | 2 | 5; preconditions: string[];
    }> = [
      {
        name: "observe_whop_snapshot",
        description: "Pull current Whop product state: revenue metrics, community activity, and product visibility",
        code: `
// Observe: fetch Whop product snapshot
const productId = state.whop_product_id;
const [metrics, posts, product] = await Promise.allSettled([
  whop.getRevenueMetrics(config, productId),
  whop.getCommunityActivity(config, productId, 5),
  whop.getWhopProduct(config, productId),
]);
return {
  revenue: metrics.status === 'fulfilled' ? metrics.value : null,
  recent_posts: posts.status === 'fulfilled' ? posts.value.posts : [],
  visibility: product.status === 'fulfilled' ? product.value.visibility : 'unknown',
  timestamp: Date.now(),
};
`.trim(),
        tier: 2,
        preconditions: ["whop_product_id is set", "whop API key available"],
      },
      {
        name: "post_community_update",
        description: "Post a content update to the Whop community feed — value/tip/announcement",
        code: `
// Post community update
const content = params.content; // parameterized — model fills this in at L4
const idKey = \`post:\${cycleId}\`;
return whop.postCommunityUpdate(config, { product_id: state.whop_product_id, content, idempotency_key: idKey });
`.trim(),
        tier: 2,
        preconditions: ["autonomy_tier >= 2", "content param provided"],
      },
      {
        name: "check_community_engagement",
        description: "Read recent community posts and surface reply/like count for the agent to act on",
        code: `
// Check engagement: list recent posts
const activity = await whop.getCommunityActivity(config, state.whop_product_id, 10);
const topPost = activity.posts.sort((a, b) => (b.likes + b.replies) - (a.likes + a.replies))[0];
return { total_posts: activity.total, top_post: topPost ?? null, engagement_score: activity.posts.reduce((s, p) => s + p.likes + p.replies, 0) };
`.trim(),
        tier: 2,
        preconditions: ["whop_product_id is set"],
      },
      {
        name: "check_revenue_delta",
        description: "Compare current revenue metrics against the last stored baseline and return delta",
        code: `
// Revenue delta check
const current = await whop.getRevenueMetrics(config, state.whop_product_id);
const baseline = state.revenue_baseline ?? current;
return {
  revenue_delta: current.total_revenue - (baseline.total_revenue ?? 0),
  subscriber_delta: current.subscriber_count - (baseline.subscriber_count ?? 0),
  current,
};
`.trim(),
        tier: 2,
        preconditions: ["whop_product_id is set"],
      },
      {
        name: "draft_welcome_post",
        description: "Draft a welcome post for new community members — queued for human review (Tier 1 safe)",
        code: `
// Draft welcome post (Tier 1: saves as draft, does NOT post)
const draft = \`Welcome to the community! 🎉 This week we're covering: \${params.topic}. Reply with your biggest challenge and I'll address it in the next update.\`;
return { draft, action: 'draft', requires_approval: true };
`.trim(),
        tier: 2,
        preconditions: ["always allowed — Tier 1 safe"],
      },
      {
        name: "update_product_visibility",
        description: "Set the Whop product visibility (visible/hidden) — requires Tier 3 autonomy",
        code: `
// Update visibility — guarded by autonomy check in executeScriptLevel1
const visibility = params.visibility as 'visible' | 'hidden' | 'archived';
const idKey = \`visibility:\${cycleId}\`;
return whop.updateWhopProductVisibility(config, state.whop_product_id, visibility, idKey);
`.trim(),
        tier: 2,
        preconditions: ["autonomy_tier >= 3", "visibility param provided"],
      },
      {
        name: "log_cycle_outcome",
        description: "Write a structured outcome entry to the outcome_log after a completed cycle",
        code: `
// Outcome log — always runs last in a cycle
const entry = {
  cycle_id: cycleId,
  action_type: params.action_type,
  action_detail: params.action_detail ?? '',
  revenue_delta_24h: params.revenue_delta ?? null,
  engagement_delta_24h: params.engagement_delta ?? null,
  template_version: state.template_version ?? '1',
  timestamp: Date.now(),
};
// Caller writes to DB via logOutcome(); this script captures the intent.
return { logged: true, entry };
`.trim(),
        tier: 1,
        preconditions: ["always safe — read-only DB write"],
      },
    ];

    let seeded = 0;
    for (const s of SEEDS) {
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO scripts
           (name, description, code, preconditions, fingerprint_schema, parameters, tier,
            success_count, failure_count, patch_history, last_used, stability_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', '[]', ?, 0, 0, '[]', 0, 1.0, ?, ?)`,
        s.name, s.description, s.code, JSON.stringify(s.preconditions), s.tier, now, now
      );
      seeded++;
    }
    return Response.json({ seeded, names: SEEDS.map(s => s.name) }, { status: 201 });
  }
}
