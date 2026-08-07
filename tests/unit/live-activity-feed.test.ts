import { describe, it, expect, afterEach } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// §A1 Harness Excellence (chat UI parity): a script-native run writes NO `agent_runs` row (that
// table is legacy-ReAct-only), so GET /runs/:runId always 404'd for the run every real chat message
// actually uses — a client polling mid-run learned nothing beyond "the id doesn't exist yet". This
// proves the fix: while a run is still executing, the SAME route synthesizes a "running" response
// from NaelaoAgentDO's in-memory live-progress map (fed by loop.ts's onProgress checkpoints); once
// the run resolves, the map entry is cleared and the route goes back to its prior 404 behavior
// (there is still no `agent_runs` row — that's the durable TaskDO/run_traces record's job, not
// this ephemeral map's).

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

const ORIGINAL_FETCH = globalThis.fetch;

describe("NaelaoAgentDO — live activity feed", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("GET /runs/:runId reports live_steps while the run is mid-flight, then 404s again once it completes", async () => {
    const r2 = makeR2();
    const ctx = { storage: { sql: createDOSqlStorage() } };

    // Gate the reasoner's ONE outbound AI Gateway call so the test controls exactly when the run
    // is allowed to finish — giving a real window to observe live progress mid-run rather than
    // racing against however fast the loop happens to execute.
    let releaseGateway: (() => void) | null = null;
    const gatewayGate = new Promise<void>((resolve) => { releaseGateway = resolve; });
    globalThis.fetch = (async () => {
      await gatewayGate;
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ function: { name: "answer", arguments: '{"text":"done"}' } }] } }],
      }), { status: 200 });
    }) as typeof fetch;

    const env = { PLATFORM_SECRET: "test", NAELAO_AIG_TOKEN: "tok", SCRIPTS_R2: r2 };
    const spaceDO = new NaelaoAgentDO(ctx as never, env as never);
    await writeAgentConfig(r2, "space1", "naelao-agent", {
      agentsMd: "# Agent",
      systemPrompt: "You are a helpful assistant.",
      scripts: { prebuilt: [], agent_scripts: "auto", startup_observe: "observe_filesystem" },
      skills: { skills: [] },
    });

    const runId = "run-live-1";
    const runPromise = spaceDO.fetch(new Request("http://agent-do/script/run", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant1" },
      body: JSON.stringify({ goal: "hi", spaceId: "space1", agentId: "naelao-agent", apiKey: "", runId }),
    }));

    // Let the loop's synchronous-ish OBSERVE/FIND/GATE steps and the pre-decide "Thinking…" ping
    // run before it blocks on the gated fetch — a few microtask/macrotask ticks is enough since
    // none of those steps do real I/O beyond in-memory R2 reads.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    const midRunResp = await spaceDO.fetch(new Request(`http://agent-do/runs/${runId}`));
    expect(midRunResp.status).toBe(200);
    const midRunBody = await midRunResp.json<{ status: string; live_steps?: Array<{ phase: string; detail?: string }> }>();
    expect(midRunBody.status).toBe("running");
    expect(midRunBody.live_steps?.length).toBeGreaterThan(0);
    expect(midRunBody.live_steps?.some((s) => s.phase === "observe")).toBe(true);
    expect(midRunBody.live_steps?.some((s) => s.phase === "reason")).toBe(true);

    releaseGateway!();
    const finalResp = await runPromise;
    expect(finalResp.status).toBe(200);

    // The run has resolved — and it must STILL be answerable. This used to assert 404, pinning
    // the behaviour a user reported as "API error 404 when I click continue": a script-native run
    // has no `agent_runs` row, and one dispatched straight into this DO has no TaskDO task, so
    // dropping the entry the moment it finished meant the run existed nowhere and the client's
    // very next poll was told it did not exist — on a run that had actually succeeded.
    const afterResp = await spaceDO.fetch(new Request(`http://agent-do/runs/${runId}`));
    expect(afterResp.status).toBe(200);
    const afterBody = await afterResp.json<{ status: string; final_answer?: string }>();
    expect(afterBody.status).toBe("completed");
    expect(afterBody.final_answer).toBe("done");
  });
});
