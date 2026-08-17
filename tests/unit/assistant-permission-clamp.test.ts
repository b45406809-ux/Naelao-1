import { describe, it, expect } from "vitest";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import {
  resolveAssistantApprovalPlan,
  READ_SAFE_PREBUILT_OPS,
} from "../../workers/agents/src/script-engine/assistant-access.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// F-36 enforcement (assistant per-user clamp was defined but never called): SpaceDO's
// `resolveAssistantEffectiveRole` + the `/projects/:id/assistant-access` endpoint have existed
// since the F-36 pass, but nothing in workers/agents ever consulted them — an assistant acting
// on behalf of a `read_only`/`none`-clamped user ran with full space-scoped authority anyway.
// These tests pin down the three wired enforcement points:
//   1. ScriptToolSurface — env.effectiveRole="viewer" makes the six-op surface read-only.
//   2. NaelaoAgentDO.handleScriptRun — a project-scoped run on behalf of a user resolves the
//      clamp at entry: null => 403, lookup error => 403 (fail closed), no acting user => no
//      clamp (base grant).
//   3. resolveAssistantApprovalPlan — space policy `yolo` no longer grants un-gated autonomy
//      to a run made on behalf of a caller who couldn't self-authorize those actions.

// ── Minimal in-memory R2 (same subset as script-engine.test.ts) ───────────────
function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const bucket = {
    async put(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : String(value));
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { size: text.length, uploaded: new Date(), async text() { return text; }, get body() { return text; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      return store.has(key) ? ({} as R2Object) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: store.get(k)!.length, uploaded: new Date(), etag: "x" }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  };
  return bucket as unknown as R2Bucket;
}

function makeEngineEnv(): ScriptEngineEnv {
  return { scriptsBucket: makeR2(), spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1" };
}

describe("ScriptToolSurface — F-36 viewer clamp makes the six-op surface read-only", () => {
  it("refuses script.create / update / delete under a viewer clamp", async () => {
    const env = makeEngineEnv();
    env.effectiveRole = "viewer";
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    await expect(
      tools.create({ name: "s1", metadata: { description: "x", domain: "compute", requires_tier: 1 } })
    ).rejects.toThrow(/read-only/);
    await expect(tools.update("s1", { code: "x" }, "why")).rejects.toThrow(/read-only/);
    await expect(tools.delete("s1")).rejects.toThrow(/read-only/);
  });

  it("read_only clamps even a project OWNER's assistant: reads pass, writes refuse", async () => {
    // assistant_mode='read_only' maps to effective role 'viewer' server-side regardless of the
    // user's own role — so at this layer "viewer" IS the read_only-owner case.
    const env = makeEngineEnv();
    const unclamped = new ScriptToolSurface(env, ["r2-workspace"]);
    const w = await unclamped.run("write_file", { path: "notes/a.txt", content: "hello" });
    expect(w.ok).toBe(true);

    env.effectiveRole = "viewer";
    const clamped = new ScriptToolSurface(env, ["r2-workspace"]);
    const r = await clamped.run("read_file", { path: "notes/a.txt" });
    expect(r.ok).toBe(true);
    expect((r.output as { content: string }).content).toBe("hello");
    const ls = await clamped.run("list_directory", { path: "notes" });
    expect(ls.ok).toBe(true);

    const w2 = await clamped.run("write_file", { path: "notes/b.txt", content: "nope" });
    expect(w2.ok).toBe(false);
    expect(w2.error).toMatch(/read-only/);
    const del = await clamped.run("delete_file", { path: "notes/a.txt" });
    expect(del.ok).toBe(false);
  });

  it("refuses running a STORED script under a viewer clamp (arbitrary code = assumed mutating)", async () => {
    const env = makeEngineEnv();
    const unclamped = new ScriptToolSurface(env, ["r2-workspace"]);
    await unclamped.create({ name: "benign-read", metadata: { description: "reads things", domain: "compute", requires_tier: 1 } });

    env.effectiveRole = "viewer";
    const clamped = new ScriptToolSurface(env, ["r2-workspace"]);
    const res = await clamped.run("benign-read", {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/read-only/);
    // script.read / script.find (the pure read halves of the surface) still work.
    const stored = await clamped.read("benign-read");
    expect(stored?.metadata.name).toBe("benign-read");
    const found = await clamped.find("reads things");
    expect(Array.isArray(found)).toBe(true);
  });

  it("editor / absent effectiveRole are unclamped (existing behavior unchanged)", async () => {
    const env = makeEngineEnv();
    env.effectiveRole = "editor";
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const w = await tools.run("write_file", { path: "x.txt", content: "ok" });
    expect(w.ok).toBe(true);
    const meta = await tools.create({ name: "s2", metadata: { description: "x", domain: "compute", requires_tier: 1 } });
    expect(meta.name).toBe("s2");
  });

  it("read-safe allowlist never contains a known mutating/money-in op", () => {
    for (const op of ["write_file", "delete_file", "commerce.checkout", "wallet.fund", "notify.email", "code.execute_bash", "agent.spawn", "call", "register", "project.configure", "local.exec"]) {
      expect(READ_SAFE_PREBUILT_OPS.has(op)).toBe(false);
    }
  });
});

describe("resolveAssistantApprovalPlan — yolo intersected with the acting caller's role", () => {
  const yolo = { approval_mode: "yolo" as const, auto_approved_actions: ["notify.email"] };
  const ask = { approval_mode: "always_ask" as const, auto_approved_actions: ["knowledge.search"] };

  it("yolo applies fully for owner/admin callers and system wakes (no role header)", () => {
    for (const role of ["owner", "admin", undefined]) {
      const plan = resolveAssistantApprovalPlan(yolo, role);
      expect(plan.approvalMode).toBe("gate_listed");
      expect(plan.requiresApprovalFor).toEqual([]);
    }
  });

  it("yolo downgrades to always_ask for every caller who couldn't self-authorize (fail closed on unknown roles)", () => {
    for (const role of ["editor", "viewer", "product_end_user", "agent", "something-new"]) {
      const plan = resolveAssistantApprovalPlan(yolo, role);
      expect(plan.approvalMode).toBe("gate_unless_listed");
      expect(plan.requiresApprovalFor).toEqual(["notify.email"]);
    }
  });

  it("always_ask keeps its allowlist for everyone; a null policy gates everything", () => {
    expect(resolveAssistantApprovalPlan(ask, "owner")).toEqual({ approvalMode: "gate_unless_listed", requiresApprovalFor: ["knowledge.search"] });
    expect(resolveAssistantApprovalPlan(null, "owner")).toEqual({ approvalMode: "gate_unless_listed", requiresApprovalFor: [] });
    expect(resolveAssistantApprovalPlan(null, undefined)).toEqual({ approvalMode: "gate_unless_listed", requiresApprovalFor: [] });
  });
});

// ── NaelaoAgentDO /script/run entry gate (harness mirrors handlescriptrun-spend-cap.test.ts) ──

type AccessBehavior = { effective_role: "owner" | "editor" | "viewer" | null } | "http_error";

function makeSpacesWorker(access: AccessBehavior) {
  const calls: string[] = [];
  const fetcher = {
    async fetch(input: RequestInfo) {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      calls.push(url.pathname);
      if (/\/projects\/[^/]+\/assistant-access$/.test(url.pathname)) {
        if (access === "http_error") return new Response("boom", { status: 500 });
        return Response.json({ project_id: "proj1", user_id: url.searchParams.get("user_id"), effective_role: access.effective_role });
      }
      if (/\/projects\/[^/]+\/spend$/.test(url.pathname)) {
        return Response.json({ project_id: "proj1", day: "d", spent_today: 0, cap: 0, capped: false });
      }
      if (/^\/spaces\/[^/]+\/projects\/[^/]+$/.test(url.pathname)) {
        return Response.json({ execution_ceiling: 2, daily_spend_cap_credits: 0 });
      }
      if (url.pathname === "/internal/pricing-catalog") return Response.json({ external_revenue_cut: { enabled: false } });
      if (url.pathname === "/internal/business-subscription-status") return Response.json({ gated: false, active: true, reason: "" });
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

async function makeDO(access: AccessBehavior) {
  const r2 = makeR2();
  const ctx = { storage: { sql: createDOSqlStorage() } };
  const { fetcher: spacesWorker, calls } = makeSpacesWorker(access);
  const env = {
    PLATFORM_SECRET: "test",
    KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
    SPACES_WORKER: spacesWorker,
    SCRIPTS_R2: r2,
  };
  const agentDO = new NaelaoAgentDO(ctx as never, env as never);
  await writeAgentConfig(r2, "space1", "naelao-agent", {
    agentsMd: "# Agent",
    systemPrompt: "You are an assistant.",
    scripts: { prebuilt: ["r2-workspace"], agent_scripts: "auto", startup_observe: "observe_filesystem" },
    skills: { skills: [] },
  });
  return { agentDO, calls };
}

async function scriptRun(doInstance: NaelaoAgentDO, opts: { projectId?: string; userId?: string }) {
  return doInstance.fetch(new Request("http://agent-do/script/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "do something in the project",
      spaceId: "space1",
      agentId: "naelao-agent",
      tenantId: "tenant1",
      apiKey: "",
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    }),
  }));
}

describe("NaelaoAgentDO /script/run — F-36 clamp resolved at run entry", () => {
  it("assistant_mode='none' (effective role null): the run is refused outright for that user", async () => {
    const { agentDO } = await makeDO({ effective_role: null });
    const res = await scriptRun(agentDO, { projectId: "proj1", userId: "user-1" });
    expect(res.status).toBe(403);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("assistant_access_denied");
  });

  it("fails CLOSED (403) when the assistant-access lookup itself errors — never assumes access", async () => {
    const { agentDO } = await makeDO("http_error");
    const res = await scriptRun(agentDO, { projectId: "proj1", userId: "user-1" });
    expect(res.status).toBe(403);
    const body = await res.json() as { error_code?: string };
    expect(body.error_code).toBe("assistant_access_unverified");
  });

  it("no acting user (cron/heartbeat/system wake): no clamp lookup, run falls back to the base grant", async () => {
    // access="http_error" proves the outcome can't come from the endpoint answering — it is
    // simply never consulted when there's no user to clamp for.
    const { agentDO, calls } = await makeDO("http_error");
    const res = await scriptRun(agentDO, { projectId: "proj1" });
    expect(res.status).not.toBe(403);
    expect(calls.some((p) => p.includes("assistant-access"))).toBe(false);
  });

  it("a synthetic channel identity is not a clampable user (belt-and-braces for the drain path)", async () => {
    const { agentDO, calls } = await makeDO("http_error");
    const res = await scriptRun(agentDO, { projectId: "proj1", userId: "channel:whatsapp:+1555" });
    expect(res.status).not.toBe(403);
    expect(calls.some((p) => p.includes("assistant-access"))).toBe(false);
  });

  it("a viewer-clamped user is admitted (read-only enforcement happens at the tool surface, not entry)", async () => {
    const { agentDO, calls } = await makeDO({ effective_role: "viewer" });
    const res = await scriptRun(agentDO, { projectId: "proj1", userId: "user-1" });
    expect(res.status).not.toBe(403);
    expect(calls.some((p) => p.includes("assistant-access"))).toBe(true);
  });

  it("a non-project (Space Assistant) run never consults the per-project clamp", async () => {
    const { agentDO, calls } = await makeDO({ effective_role: null });
    const res = await scriptRun(agentDO, { userId: "user-1" });
    expect(res.status).not.toBe(403);
    expect(calls.some((p) => p.includes("assistant-access"))).toBe(false);
  });
});

// A product end user can be the OWNER of their own business, not just a customer of it. Without
// that distinction the F-36 clamp downgraded yolo for them unconditionally — so an owner who set
// their own business to autonomous still had every action gated, with nobody but themself to
// approve it. Found live: a real business set to yolo still returned deferred_approvals.
describe("yolo and the business owner", () => {
  const yolo = { approval_mode: "yolo" as const, auto_approved_actions: ["project.list"] };

  it("applies yolo for a business owner acting as a product end user", () => {
    const plan = resolveAssistantApprovalPlan(yolo, "product_end_user", "owner");
    expect(plan.approvalMode).toBe("gate_listed");
    expect(plan.requiresApprovalFor).toEqual([]);
  });

  it("applies it for a business admin too", () => {
    expect(resolveAssistantApprovalPlan(yolo, "product_end_user", "admin").approvalMode).toBe("gate_listed");
  });

  it("still downgrades a plain member — yolo is the owner's choice about their own business", () => {
    const plan = resolveAssistantApprovalPlan(yolo, "product_end_user", "member");
    expect(plan.approvalMode).toBe("gate_unless_listed");
    expect(plan.requiresApprovalFor).toEqual(["project.list"]);
  });

  it("downgrades when the business role could not be resolved at all", () => {
    // Fail soft, not open: an unresolvable role keeps the always_ask posture.
    expect(resolveAssistantApprovalPlan(yolo, "product_end_user", undefined).approvalMode).toBe("gate_unless_listed");
  });

  it("leaves builder and system callers exactly as they were", () => {
    expect(resolveAssistantApprovalPlan(yolo, "owner").approvalMode).toBe("gate_listed");
    expect(resolveAssistantApprovalPlan(yolo, undefined).approvalMode).toBe("gate_listed");
    expect(resolveAssistantApprovalPlan(yolo, "viewer").approvalMode).toBe("gate_unless_listed");
    // A business role must never promote a caller the platform role already refused.
    expect(resolveAssistantApprovalPlan(yolo, "viewer", "owner").approvalMode).toBe("gate_unless_listed");
  });

  it("never grants yolo when the policy isn't yolo, whatever the business role", () => {
    const askFirst = { approval_mode: "always_ask" as const, auto_approved_actions: [] };
    expect(resolveAssistantApprovalPlan(askFirst, "product_end_user", "owner").approvalMode).toBe("gate_unless_listed");
  });
});
