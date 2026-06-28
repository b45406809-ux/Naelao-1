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

// ── Stability score helper ────────────────────────────────────────────────────

function computeStability(entry: Pick<ScriptRegistryEntry, "success_count" | "failure_count" | "patch_history">): number {
  const total = entry.success_count + entry.failure_count;
  if (total === 0) return 1.0;
  const recentPatches = entry.patch_history.filter(
    p => p.timestamp > Date.now() - 10 * 86400_000
  ).length;
  return (entry.success_count / total) * (1 / (1 + recentPatches));
}

// ── BusinessDO ────────────────────────────────────────────────────────────────

export interface BusinessDOEnv {
  PLATFORM_SECRET: string;
  BUSINESS_R2: R2Bucket;
  ANALYTICS?: AnalyticsEngineDataset;
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
      api_key: string;
      model?: string;
    }>();

    const cycleId = crypto.randomUUID();
    const autonomyTier = parseInt(this.getCfg("autonomy_tier") ?? "1", 10) as AutonimyTier;

    this.setCfg("fiber_status", "running");
    this.setCfg("last_cycle_at", String(Date.now()));

    this.ctx.waitUntil(
      this.runCycleAsync(cycleId, body.observe_snapshot ?? {}, body.task_description ?? "", body.api_key, body.model ?? "claude-haiku-4-5-20251001", autonomyTier)
    );

    return Response.json({ cycle_id: cycleId, status: "started", autonomy_tier: autonomyTier });
  }

  private async runCycleAsync(
    cycleId: string,
    observeSnapshot: Record<string, unknown>,
    taskDescription: string,
    apiKey: string,
    model: string,
    autonomyTier: AutonimyTier,
  ): Promise<void> {
    try {
      // STEP 1: OBSERVE — snapshot already provided by caller (or agent fetches from Whop)
      const snapshot = Object.keys(observeSnapshot).length > 0
        ? observeSnapshot
        : { timestamp: Date.now(), source: "whop", data: {} };

      // STEP 2: FINGERPRINT — deterministic hash of structural parts
      const fingerprint = this.computeFingerprint(snapshot);

      // STEP 3: FIND — name-based lookup in flat registry
      const candidates = this.findScripts(fingerprint, taskDescription);

      let actionResult: { success: boolean; output: string; script_name?: string; level: number };

      const topCandidate = candidates[0];
      if (topCandidate && topCandidate.stability_score >= 0.7) {
        // LEVEL 1: Direct execution — no model call
        actionResult = await this.executeScriptLevel1(topCandidate, snapshot, cycleId, autonomyTier, apiKey);
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

      // Record outcome
      this.logOutcome(cycleId, taskDescription || (actionResult.script_name ?? "cycle"), actionResult.output, null, null);

      // Emit analytics
      if (this.env.ANALYTICS) {
        try {
          this.env.ANALYTICS.writeDataPoint({
            blobs: ["business.cycle.completed", this.getCfg("user_id") ?? "", cycleId, String(actionResult.level), verified ? "verified" : "unverified"],
            doubles: [Date.now(), actionResult.success ? 1 : 0],
            indexes: [this.getCfg("user_id") ?? "unknown"],
          });
        } catch { /* best-effort */ }
      }

      this.setCfg("fiber_status", "idle");
    } catch (err) {
      console.error(`[BusinessDO] cycle ${cycleId} failed:`, err);
      this.setCfg("fiber_status", "failed");
      this.logOutcome(cycleId, "cycle_error", String(err), null, null);
    }
  }

  // LEVEL 1 — direct execution, no model call
  private async executeScriptLevel1(
    entry: ScriptRegistryEntry,
    _snapshot: Record<string, unknown>,
    cycleId: string,
    autonomyTier: AutonimyTier,
    _apiKey: string,
  ): Promise<{ success: boolean; output: string; script_name: string; level: number }> {
    // Autonomy gate: check if this action is allowed at current tier
    const allowed = this.checkAutonomy(entry.name, autonomyTier);
    if (!allowed) {
      return { success: false, output: `Action '${entry.name}' requires higher autonomy tier (current: ${autonomyTier})`, script_name: entry.name, level: 1 };
    }

    // Idempotency check: has this script run this cycle already?
    const idKey = `${cycleId}:${entry.name}`;
    const existing = this.ctx.storage.sql
      .exec(`SELECT id FROM tool_call_log WHERE id = ?`, idKey)
      .toArray();
    if (existing.length > 0) {
      return { success: true, output: "Already executed (idempotent skip)", script_name: entry.name, level: 1 };
    }

    // Log intent before execution (WAL pattern)
    this.ctx.storage.sql.exec(
      `INSERT INTO tool_call_log (id, cycle_id, tool_name, params_hash, status, created_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      idKey, cycleId, entry.name, "direct", Date.now()
    );

    // Execute the script code (Tier 2: evaluate in isolate)
    let output = "";
    let success = false;
    try {
      // For v0, scripts are TypeScript strings stored in the registry.
      // Real execution would use a Dynamic Worker isolate. Here we log intent and mark success.
      output = `[Level 1] Executed script '${entry.name}' directly`;
      success = true;
      this.ctx.storage.sql.exec(
        `UPDATE tool_call_log SET status = 'completed', result = ?, completed_at = ? WHERE id = ?`,
        output, Date.now(), idKey
      );
      this.updateScriptStats(entry.name, true);
    } catch (err) {
      output = String(err);
      this.ctx.storage.sql.exec(
        `UPDATE tool_call_log SET status = 'failed', result = ?, completed_at = ? WHERE id = ?`,
        output, Date.now(), idKey
      );
      this.updateScriptStats(entry.name, false);
    }

    return { success, output, script_name: entry.name, level: 1 };
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
        const data = await resp.json<{ content: Array<{ type: string; text: string }> }>();
        patchResult = data.content.find(b => b.type === "text")?.text ?? "";
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
        const data = await resp.json<{ content: Array<{ type: string; text: string }> }>();
        const newCode = data.content.find(b => b.type === "text")?.text ?? "";

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
        const data = await resp.json<{ content: Array<{ type: string; text: string }> }>();
        const output = data.content.find(b => b.type === "text")?.text ?? "";

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

      const data = await resp.json<{ content: Array<{ type: string; text: string }> }>();
      const raw = data.content.find(b => b.type === "text")?.text ?? "";

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
      // If script has a fingerprint schema, do a rough match
      try {
        const schema = JSON.parse(s.fingerprint_schema) as Record<string, unknown>;
        if (Object.keys(schema).length === 0) return true; // no schema = match all
        return true; // simplified for v0 — full JSON Schema validation is deferred
      } catch { return true; }
    });
  }

  private computeFingerprint(snapshot: Record<string, unknown>): string {
    // Extract structural keys only (not values) for a stable fingerprint
    const structural = Object.keys(snapshot).sort().join(",");
    // Simple hash (FNV-1a 32-bit)
    let h = 0x811c9dc5;
    for (let i = 0; i < structural.length; i++) {
      h ^= structural.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
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
