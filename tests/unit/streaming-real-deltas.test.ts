import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// §A1.27: the SSE stream endpoint used to emit NAMED events (`event: status`/`event: done`) with
// no `type` field — a browser's native EventSource never fires `onmessage` for a named event, and
// even if it somehow did, none of the three known clients (apps/shell, apps/widget, apps/portal)
// could route a payload with no `type` field. This drives the REAL endpoint end-to-end and parses
// the actual SSE wire format, proving the server now emits unnamed `data:`-only frames carrying
// `type: "status"|"done"|"error"` — exactly what every existing client's `es.onmessage` already
// expects, per bug #4 in the session's own plan.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil: (p: Promise<unknown>) => { void p; }, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(runBody: { id: string; status: string; final_answer?: string; error?: string }) {
  const agentDoStub = {
    async fetch() {
      return new Response(JSON.stringify(runBody), { status: 200 });
    },
  };
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return this;
        },
        async first() {
          if (sql.includes("FROM spaces")) return { id: "space-1" };
          if (sql.includes("FROM orgs")) return { plan_tier: "growth" }; // sse_streaming: true
          return null;
        },
      };
    },
  };
  return {
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: db,
    NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
  } as unknown as AgentsEnv;
}

/** Parses `data: {...}\n\n` SSE frames out of a raw response body string into their JSON payloads. */
function parseSseFrames(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      expect(dataLine, `frame has no data: line: ${block}`).toBeDefined();
      // Every frame must be a bare `data:` line — a named `event:` line would mean the dead-
      // onmessage bug is back.
      expect(block.includes("event:")).toBe(false);
      return JSON.parse(dataLine!.slice("data: ".length)) as Record<string, unknown>;
    });
}

async function streamReq(env: AgentsEnv) {
  const token = await mintInternalToken(SECRET, "tenant-a");
  const res = await app.fetch(
    new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/agent/runs/run-1/stream", {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
    }),
    env,
    execCtx
  );
  const text = await res.text();
  return { res, frames: parseSseFrames(text) };
}

describe("GET .../agent/runs/:runId/stream — real event shape, not named SSE events", () => {
  it("emits a done event with type:'done' and the final answer, as a bare data: frame", async () => {
    const env = makeEnv({ id: "run-1", status: "completed", final_answer: "The answer is 42." });
    const { res, frames } = await streamReq(env);
    expect(res.status).toBe(200);
    const done = frames.find((f) => f.type === "done");
    expect(done).toBeDefined();
    expect(done!.final_answer).toBe("The answer is 42.");
    expect(done!.run_id).toBe("run-1");
  });

  it("emits the final answer as a delta event too (client accumulates deltas as they arrive)", async () => {
    const env = makeEnv({ id: "run-1", status: "completed", final_answer: "Hello world" });
    const { frames } = await streamReq(env);
    const delta = frames.find((f) => f.type === "delta");
    expect(delta).toBeDefined();
    expect(delta!.content).toBe("Hello world");
  });

  it("emits a status event with type:'status' before the terminal done event", async () => {
    const env = makeEnv({ id: "run-1", status: "completed", final_answer: "ok" });
    const { frames } = await streamReq(env);
    const statusIdx = frames.findIndex((f) => f.type === "status");
    const doneIdx = frames.findIndex((f) => f.type === "done");
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(statusIdx);
  });

  it("emits type:'done' with the error message when the run failed", async () => {
    const env = makeEnv({ id: "run-1", status: "failed", error: "script threw" });
    const { frames } = await streamReq(env);
    const done = frames.find((f) => f.type === "done");
    expect(done).toBeDefined();
    expect(done!.status).toBe("failed");
    expect(done!.error).toBe("script threw");
  });
});
