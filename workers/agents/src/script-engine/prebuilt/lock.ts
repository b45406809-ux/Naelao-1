/**
 * lock — a generic named-lock primitive (spec §28 ConcurrencyDO, generalized). Naelao does
 * not ship a bespoke locking mechanism per use case (e.g. "lock a CSV row before writing");
 * instead it exposes acquire/release/status, and an assistant or agent composes its OWN
 * concurrency strategy on top of it — a script that acquires a lock keyed by row number
 * before writing, aborts if not granted, releases after. The assistant then tells its agents
 * (via agents.md / a skill) to call that script instead of the raw file-write prebuilt.
 *
 * Keys are automatically namespaced by space (+ project, when the run is project-scoped) —
 * see NaelaoAgentDO.buildScriptEngineEnv — so two different spaces/projects can never
 * collide on the same literal lock name a script picks.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

const DEFAULT_LOCK_TTL_MS = 30_000;

function reqStr(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v.length === 0) throw new Error(`'${name}' (string) is required`);
  return v;
}

export const lock: PrebuiltScript = {
  name: "lock",
  description:
    "Acquire, release, and check a named lock — the building block for scripts that need their own concurrency strategy (e.g. locking a spreadsheet row before writing it).",
  domain: "orchestration",
  requires_tier: 1,
  operations: {
    async "lock.acquire"(args, ctx: PrebuiltOpContext) {
      if (!ctx.env.lockGateway) return { granted: false, active: 0, reason: "lock primitive not available in this environment" };
      const key = reqStr(args, "key");
      const holderId = reqStr(args, "holder_id");
      const limit = typeof args["limit"] === "number" ? (args["limit"] as number) : 1; // exclusive by default
      const ttlMs = typeof args["ttl_ms"] === "number" ? (args["ttl_ms"] as number) : DEFAULT_LOCK_TTL_MS;
      return ctx.env.lockGateway.acquire({ key, holderId, limit, ttlMs });
    },

    async "lock.release"(args, ctx: PrebuiltOpContext) {
      if (!ctx.env.lockGateway) return { ok: false, reason: "lock primitive not available in this environment" };
      const key = reqStr(args, "key");
      const holderId = reqStr(args, "holder_id");
      await ctx.env.lockGateway.release({ key, holderId });
      return { ok: true };
    },

    async "lock.status"(args, ctx: PrebuiltOpContext) {
      if (!ctx.env.lockGateway) return { active: 0, reason: "lock primitive not available in this environment" };
      const key = reqStr(args, "key");
      return ctx.env.lockGateway.status(key);
    },
  },
};
