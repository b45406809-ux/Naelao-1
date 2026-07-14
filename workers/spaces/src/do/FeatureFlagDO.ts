// G-AX08: Platform Feature Flag System for Gradual Rollouts.
// FeatureFlagDO stores all flags and evaluates them with targeting rules.
//
// Flag shape:
//   { flag_id, state: "on"|"off"|"rollout", enabled_pct, targeting_rules, updated_at }
// Targeting rule shape:
//   { attribute: "account_id"|"plan_tier"|"tenant_id", operator: "eq"|"in"|"ne", value: string|string[] }
//
// HTTP interface (internal):
//   POST /flags                  { flag_id, state, enabled_pct?, targeting_rules? } → 201
//   GET  /flags/:flagId          → flag row
//   DELETE /flags/:flagId        → 204
//   POST /evaluate               { flag_id, context: {account_id?, plan_tier?, tenant_id?} } → { enabled: boolean }
//
// Evaluation logic (O(1) for simple flags):
//   1. If state=off → false
//   2. If state=on → true
//   3. If state=rollout → check targeting_rules first; if matched → true, else hash(flag_id:account_id) % 100 < enabled_pct

import { DurableObject } from "cloudflare:workers";

interface FlagRow {
  flag_id: string;
  state: "on" | "off" | "rollout";
  enabled_pct: number;
  targeting_rules: string; // JSON array of TargetingRule
  updated_at: string;
}

interface TargetingRule {
  attribute: string;
  operator: "eq" | "in" | "ne";
  value: string | string[];
}

interface EvalContext {
  account_id?: string;
  plan_tier?: string;
  tenant_id?: string;
  [key: string]: string | undefined;
}

function evalRules(rules: TargetingRule[], ctx: EvalContext): boolean {
  for (const rule of rules) {
    const ctxVal = ctx[rule.attribute];
    if (ctxVal === undefined) continue;
    if (rule.operator === "eq" && ctxVal === rule.value) return true;
    if (rule.operator === "ne" && ctxVal !== rule.value) return true;
    if (rule.operator === "in" && Array.isArray(rule.value) && rule.value.includes(ctxVal)) return true;
  }
  return false;
}

async function deterministicPct(flagId: string, accountId: string): Promise<number> {
  const key = `${flagId}:${accountId}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const view = new DataView(buf);
  return view.getUint32(0, false) % 100;
}

export class FeatureFlagDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS flags (
        flag_id         TEXT PRIMARY KEY,
        state           TEXT NOT NULL DEFAULT 'off',
        enabled_pct     INTEGER NOT NULL DEFAULT 0,
        targeting_rules TEXT NOT NULL DEFAULT '[]',
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    // POST /flags — create or update a flag
    if (method === "POST" && url.pathname === "/flags") {
      const body = await request.json<{
        flag_id: string;
        state: "on" | "off" | "rollout";
        enabled_pct?: number;
        targeting_rules?: TargetingRule[];
      }>();
      if (!body.flag_id || !body.state) {
        return Response.json({ error: "flag_id and state required" }, { status: 400 });
      }
      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO flags (flag_id, state, enabled_pct, targeting_rules, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        body.flag_id,
        body.state,
        body.enabled_pct ?? 0,
        JSON.stringify(body.targeting_rules ?? []),
        now
      );
      return Response.json({ flag_id: body.flag_id, state: body.state }, { status: 201 });
    }

    // GET /flags/:flagId
    const flagMatch = url.pathname.match(/^\/flags\/([^/]+)$/);
    if (method === "GET" && flagMatch?.[1]) {
      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM flags WHERE flag_id = ?`, flagMatch[1])
        .toArray() as unknown as FlagRow[];
      if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ ...rows[0], targeting_rules: JSON.parse(rows[0].targeting_rules) });
    }

    // DELETE /flags/:flagId
    if (method === "DELETE" && flagMatch?.[1]) {
      this.ctx.storage.sql.exec(`DELETE FROM flags WHERE flag_id = ?`, flagMatch[1]);
      return new Response(null, { status: 204 });
    }

    // GET /flags — list all flags
    if (method === "GET" && url.pathname === "/flags") {
      const rows = this.ctx.storage.sql
        .exec(`SELECT flag_id, state, enabled_pct, updated_at FROM flags ORDER BY flag_id`)
        .toArray() as unknown as Pick<FlagRow, "flag_id" | "state" | "enabled_pct" | "updated_at">[];
      return Response.json({ flags: rows });
    }

    // POST /evaluate — evaluate a flag for a given context
    if (method === "POST" && url.pathname === "/evaluate") {
      const body = await request.json<{ flag_id: string; context: EvalContext }>();
      if (!body.flag_id) return Response.json({ error: "flag_id required" }, { status: 400 });

      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM flags WHERE flag_id = ?`, body.flag_id)
        .toArray() as unknown as FlagRow[];

      if (!rows[0]) {
        // Unknown flags default to disabled
        return Response.json({ enabled: false, reason: "unknown_flag" });
      }

      const flag = rows[0];

      if (flag.state === "off") return Response.json({ enabled: false, reason: "disabled" });
      if (flag.state === "on") return Response.json({ enabled: true, reason: "enabled" });

      // state === "rollout"
      const rules: TargetingRule[] = JSON.parse(flag.targeting_rules);
      if (rules.length > 0 && evalRules(rules, body.context)) {
        return Response.json({ enabled: true, reason: "targeting_rule_match" });
      }

      const accountId = body.context.account_id ?? body.context.tenant_id ?? "anonymous";
      const pct = await deterministicPct(body.flag_id, accountId);
      const enabled = pct < flag.enabled_pct;
      return Response.json({ enabled, reason: `rollout_pct_${flag.enabled_pct}` });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
