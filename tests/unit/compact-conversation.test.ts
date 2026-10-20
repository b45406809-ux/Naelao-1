import { describe, it, expect } from "vitest";
import app from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { getDOName } from "@naelao/crypto";
import type { AgentsEnv } from "../../workers/agents/src/index.js";

// Regression coverage for session-scoped memory maintenance and its tenant/membership gates.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv() {
  const doNames: string[] = [];
  const maintenanceBodies: Array<Record<string, unknown>> = [];
  const stub = {
    fetch: async (r: Request) => {
      maintenanceBodies.push((await r.json().catch(() => ({}))) as Record<string, unknown>);
      return Response.json({ decayed: 0, pruned_facts: 0, promoted: 0, pruned_episodic: 0 });
    },
  } as unknown as DurableObjectStub;

  return {
    __doNames: doNames,
    __maintenanceBodies: maintenanceBodies,
    PLATFORM_SECRET: SECRET,
    NAELAO_AGENT_DO: {
      idFromName: (name: string) => {
        doNames.push(name);
        return { toString: () => name };
      },
      get: () => stub,
    },
    PLATFORM_DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ id: "space1" }) }),
      }),
    },
    SPACES_WORKER: {
      async fetch(input: RequestInfo) {
        const path = new URL((input as Request).url).pathname;
        if (path.endsWith("/compact-scope")) return Response.json({ project_id: null, owned_by_caller: false, private_scratchpad: false });
        if (path.endsWith("/members")) return Response.json({ data: [{ user_id: "user-1", role: "owner" }] });
        return new Response("not found", { status: 404 });
      },
    },
  } as unknown as AgentsEnv & { __doNames: string[]; __maintenanceBodies: Array<Record<string, unknown>> };
}

async function compactReq(spaceId: string, sessionId: string) {
  const token = await mintInternalToken(SECRET, "tenant-1");
  return new Request(`http://agents/spaces/${spaceId}/sessions/${sessionId}/compact`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-internal-token": token,
      "x-naelao-tenant-id": "tenant-1",
      "x-naelao-role": "owner",
      "x-naelao-user-id": "user-1",
    },
  });
}

describe("POST .../sessions/:sessionId/compact", () => {
  it("forwards the sessionId it was given (it used to drop it entirely)", async () => {
    const env = makeEnv();
    const res = await app.fetch(await compactReq("space1", "sess-7"), env, execCtx);
    expect(res.status).toBe(200);
    expect(env.__maintenanceBodies[0]).toMatchObject({ spaceId: "space1", sessionId: "sess-7", tenantId: "tenant-1" });
  });

  it("addresses the SESSION's own DO, where conversation_summaries actually lives", async () => {
    const env = makeEnv();
    await app.fetch(await compactReq("space1", "sess-7"), env, execCtx);

    const sessionDo = await getDOName("agent", "sess-7", "tenant-1", SECRET);
    expect(env.__doNames).toContain(sessionDo);

    const spaceWide = await getDOName("agent", "space1:naelao-agent", "tenant-1", SECRET);
    expect(env.__doNames).not.toContain(spaceWide);
  });

  it("surfaces the DO's result to the caller so the UI can report what happened", async () => {
    const env = makeEnv();
    const res = await app.fetch(await compactReq("space1", "sess-7"), env, execCtx);
    const body = await res.json<{ ok: boolean; result: Record<string, unknown> }>();
    expect(body.ok).toBe(true);
    expect(body.result).toHaveProperty("promoted");
  });
});
