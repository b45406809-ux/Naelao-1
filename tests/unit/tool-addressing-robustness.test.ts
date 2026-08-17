import { describe, it, expect } from "vitest";
import { suggestModels, isAllowedModel, ALLOWED_MODELS } from "@naelao/billing-core";
import { applyToolResultLimit } from "../../workers/agents/src/script-engine/tool-surface.js";
import { projectCoordination } from "../../workers/agents/src/script-engine/prebuilt/project-coordination.js";
import { subAgent } from "../../workers/agents/src/script-engine/prebuilt/sub-agent.js";
import type { ScriptEngineEnv, OrchestrationHooks } from "../../workers/agents/src/script-engine/types.js";

// Steps 8, 9, 10: model/agent addressing robustness and tool-result pagination.

const PLATFORM_SECRET = "test-platform-secret";
const noopRun = async () => ({});

interface Call { method: string; url: string; body: unknown }

function makeEnv(responder?: (call: Call) => unknown, orchestration?: OrchestrationHooks): ScriptEngineEnv {
  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const body = await req.clone().json().catch(() => null);
      const call: Call = { method: req.method, url: req.url, body };
      return Response.json((responder ? responder(call) : {}) ?? {});
    },
  };
  return {
    scriptsBucket: {} as never,
    spaceId: "space-1",
    tenantId: "tenant-1",
    platformSecret: PLATFORM_SECRET,
    spacesWorker: spacesWorker as unknown as Fetcher,
    ...(orchestration ? { orchestration } : {}),
  } as unknown as ScriptEngineEnv;
}

describe("suggestModels — did-you-mean over the model allowlist", () => {
  it("suggests real ids for a provider-prefix-less / partial guess", () => {
    const s = suggestModels("gemini-flash");
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((m) => isAllowedModel(m))).toBe(true);
    expect(s.some((m) => m.includes("gemini") && m.includes("flash"))).toBe(true);
  });

  it("matches llama-70b to the real llama 3.3 70b id", () => {
    const s = suggestModels("llama-70b");
    expect(s[0]).toContain("llama-3.3-70b");
  });

  it("returns nothing for an empty or gibberish guess", () => {
    expect(suggestModels("")).toEqual([]);
    expect(suggestModels("zzzzqqq-nonsense")).toEqual([]);
  });
});

describe("applyToolResultLimit — generic tool-result pagination (step 9)", () => {
  it("leaves a small result byte-identical when no paging arg is passed", () => {
    const out = { data: [1, 2, 3], count: 3 };
    expect(applyToolResultLimit(out, {})).toBe(out);
  });

  it("pages the primary list when the caller passes limit/offset", () => {
    const out = { data: Array.from({ length: 100 }, (_, i) => ({ id: i })), count: 100 };
    const paged = applyToolResultLimit(out, { limit: 10, offset: 20 }) as {
      data: Array<{ id: number }>;
      _pagination: { total: number; offset: number; limit: number; has_more: boolean; next_offset?: number };
    };
    expect(paged.data).toHaveLength(10);
    expect(paged.data[0]!.id).toBe(20);
    expect(paged._pagination.total).toBe(100);
    expect(paged._pagination.has_more).toBe(true);
    expect(paged._pagination.next_offset).toBe(30);
  });

  it("auto-pages a genuinely oversized list even with no paging arg, keeping the field name", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, text: "x".repeat(50) })) };
    const paged = applyToolResultLimit(big, {}) as { rows: unknown[]; _pagination: { total: number; has_more: boolean } };
    expect(paged.rows.length).toBeLessThan(5000);
    expect(paged._pagination.total).toBe(5000);
    expect(paged._pagination.has_more).toBe(true);
  });

  it("wraps a top-level oversized array as {items,_pagination}", () => {
    const arr = Array.from({ length: 4000 }, (_, i) => ({ i, s: "y".repeat(40) }));
    const paged = applyToolResultLimit(arr, {}) as { items: unknown[]; _pagination: { total: number } };
    expect(Array.isArray(paged.items)).toBe(true);
    expect(paged._pagination.total).toBe(4000);
  });

  it("truncates an oversized non-list blob with an instruction rather than paging", () => {
    const blob = { text: "z".repeat(50_000) };
    const trimmed = applyToolResultLimit(blob, {}) as { _truncated: boolean; preview: string; instruction: string };
    expect(trimmed._truncated).toBe(true);
    expect(trimmed.preview.length).toBeLessThanOrEqual(16_000);
    expect(trimmed.instruction).toMatch(/truncated/i);
  });
});

describe("thread.list_project_agents / list_project_models (step 8)", () => {
  it("always includes the general agent, even when the space has no agent_definitions", async () => {
    const env = makeEnv(() => ({ data: [] }));
    const res = (await projectCoordination.operations["thread.list_project_agents"]!({}, { env, run: noopRun })) as {
      agents: Array<{ id: string; is_default?: boolean }>;
      default_agent: string;
    };
    expect(res.default_agent).toBe("naelao-agent");
    expect(res.agents.some((a) => a.id === "naelao-agent" && a.is_default)).toBe(true);
  });

  it("includes the space's own agents plus the general one", async () => {
    const env = makeEnv(() => ({ data: [{ id: "support-bot", name: "Support Bot" }] }));
    const res = (await projectCoordination.operations["thread.list_project_agents"]!({}, { env, run: noopRun })) as {
      agents: Array<{ id: string }>;
    };
    expect(res.agents.map((a) => a.id).sort()).toEqual(["naelao-agent", "support-bot"]);
  });

  it("list_project_models returns the same allowlist a spawn may name", async () => {
    const env = makeEnv();
    const res = (await projectCoordination.operations["thread.list_project_models"]!({}, { env, run: noopRun })) as {
      default: string;
      models: Array<{ id: string }>;
    };
    expect(res.models.map((m) => m.id)).toEqual([...ALLOWED_MODELS]);
  });
});

describe("thread.consult validates agent_id with did-you-mean (step 10)", () => {
  it("returns a did-you-mean error for an unknown agent instead of a bare 404", async () => {
    const orchestration: OrchestrationHooks = { consultAgent: async () => ({ ok: true }) };
    const env = makeEnv((call) => (call.url.includes("/agent-definitions") ? { data: [{ id: "support-agent", name: "Support" }] } : {}), orchestration);
    const res = (await projectCoordination.operations["thread.consult"]!(
      { agent_id: "support", message: "hi" },
      { env, run: noopRun }
    )) as { ok: boolean; error: string; did_you_mean: string[] };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/was not found/);
    expect(res.did_you_mean).toContain("support-agent");
  });
});

describe("agent.spawn validates model with did-you-mean (step 10)", () => {
  it("rejects an invalid model before delegating, with suggestions", async () => {
    let spawned = false;
    const orchestration: OrchestrationHooks = { spawnSubAgent: async () => { spawned = true; return { ok: true }; } };
    const env = makeEnv(undefined, orchestration);
    const res = (await subAgent.operations["agent.spawn"]!(
      { tasks: [{ goal: "do a thing", model: "gemini-flash" }] },
      { env, run: noopRun }
    )) as { ok: boolean; error: string; did_you_mean: string[] };
    expect(res.ok).toBe(false);
    expect(spawned).toBe(false);
    expect(res.error).toMatch(/not available/);
    expect(res.did_you_mean.length).toBeGreaterThan(0);
  });

  it("passes a valid model through to the spawn hook", async () => {
    let seen: unknown;
    const orchestration: OrchestrationHooks = { spawnSubAgent: async (a) => { seen = a; return { ok: true }; } };
    const env = makeEnv(undefined, orchestration);
    const res = (await subAgent.operations["agent.spawn"]!(
      { tasks: [{ goal: "do a thing", model: ALLOWED_MODELS[0] }] },
      { env, run: noopRun }
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(seen).toBeDefined();
  });
});
