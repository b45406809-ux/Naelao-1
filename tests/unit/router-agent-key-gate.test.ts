import { describe, it, expect } from "vitest";
import routerWorker from "../../workers/router/src/index.js";

// §A1.17 Phase O: an agent's own Bearer nak_... key authenticates it against the same routes a
// human uses, attributed to the agent itself (role:"agent") — and a MUTATING request is gated
// exactly like the in-loop HITL gate unless it's pre-approved or 'yolo'. This test exercises the
// router's resolution + gate middleware in isolation, stubbing SPACES_WORKER's
// /internal/agent-keys/verify and AGENTS_WORKER's /internal/agent-approvals[/consume].

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(opts: {
  verify: { valid: boolean; tenant_id?: string; agent_id?: string; approval_mode?: string; auto_approved_actions?: string[] };
  createApproval?: { approval_id: string; poll_url: string };
  consume?: { consumed: boolean };
}) {
  const calls: { url: string; body?: unknown }[] = [];
  const SPACES_WORKER = {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/internal/agent-keys/verify") {
        return Response.json(opts.verify);
      }
      calls.push({ url: req.url });
      return Response.json({ worker: "SPACES" });
    },
  } as unknown as Fetcher;
  const AGENTS_WORKER = {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/internal/agent-approvals") {
        return Response.json(opts.createApproval ?? { approval_id: "appr-1", poll_url: "/spaces/s1/sessions/agent-api/approvals/appr-1" }, { status: 201 });
      }
      if (url.pathname === "/internal/agent-approvals/consume") {
        return Response.json(opts.consume ?? { consumed: false });
      }
      calls.push({ url: req.url });
      return Response.json({ worker: "AGENTS" });
    },
  } as unknown as Fetcher;
  return {
    env: {
      ENVIRONMENT: "test",
      JWT_SECRET: "test-jwt-secret",
      PLATFORM_SECRET: "test-platform-secret",
      SPACES_WORKER,
      AGENTS_WORKER,
      KNOWLEDGE_WORKER: { fetch: async () => Response.json({ worker: "KNOWLEDGE" }) } as unknown as Fetcher,
      CREDENTIALS_WORKER: { fetch: async () => Response.json({ worker: "CREDENTIALS" }) } as unknown as Fetcher,
    },
    calls,
  };
}

function agentFetch(method: string, path: string, env: unknown, extraHeaders?: Record<string, string>) {
  return routerWorker.fetch(
    new Request(`https://router.naelao.com${path}`, {
      method,
      headers: { authorization: "Bearer nak_testkey", ...(extraHeaders ?? {}) },
    }),
    env as never,
    execCtx
  );
}

describe("router — agent nak_ key resolution", () => {
  it("rejects an invalid/unknown agent key", async () => {
    const { env } = makeEnv({ verify: { valid: false } });
    const res = await agentFetch("GET", "/v1/spaces/s1/projects", env);
    expect(res.status).toBe(401);
  });

  it("a non-mutating (GET) request passes straight through, no approval gate", async () => {
    const { env, calls } = makeEnv({ verify: { valid: true, tenant_id: "tenant-1", agent_id: "agent-1", approval_mode: "always_ask", auto_approved_actions: [] } });
    const res = await agentFetch("GET", "/v1/spaces/s1/projects", env);
    expect(await res.json()).toEqual({ worker: "SPACES" });
    expect(calls).toHaveLength(1);
  });
});

describe("router — agent mutating-action approval gate", () => {
  it("'yolo' mode lets a mutating request through with no approval at all", async () => {
    const { env, calls } = makeEnv({ verify: { valid: true, tenant_id: "tenant-1", agent_id: "agent-1", approval_mode: "yolo", auto_approved_actions: [] } });
    const res = await agentFetch("POST", "/v1/spaces/s1/projects", env);
    expect(await res.json()).toEqual({ worker: "SPACES" });
    expect(calls).toHaveLength(1);
  });

  it("a pre-approved action key (auto_approved_actions) passes straight through", async () => {
    const { env, calls } = makeEnv({ verify: { valid: true, tenant_id: "tenant-1", agent_id: "agent-1", approval_mode: "always_ask", auto_approved_actions: ["POST:projects"] } });
    const res = await agentFetch("POST", "/v1/spaces/s1/projects", env);
    expect(await res.json()).toEqual({ worker: "SPACES" });
    expect(calls).toHaveLength(1);
  });

  it("an ungated mutating action opens an approval and returns 202 without proxying", async () => {
    const { env, calls } = makeEnv({ verify: { valid: true, tenant_id: "tenant-1", agent_id: "agent-1", approval_mode: "always_ask", auto_approved_actions: [] } });
    const res = await agentFetch("POST", "/v1/spaces/s1/projects", env);
    expect(res.status).toBe(202);
    const body = await res.json<{ status: string; approval_id: string; poll_url: string }>();
    expect(body.status).toBe("pending_approval");
    expect(body.approval_id).toBe("appr-1");
    expect(calls).toHaveLength(0); // never reached SPACES_WORKER's real route
  });

  it("resubmitting with an approved X-Naelao-Approval-Id lets the request through", async () => {
    const { env, calls } = makeEnv({
      verify: { valid: true, tenant_id: "tenant-1", agent_id: "agent-1", approval_mode: "always_ask", auto_approved_actions: [] },
      consume: { consumed: true },
    });
    const res = await agentFetch("POST", "/v1/spaces/s1/projects", env, { "x-naelao-approval-id": "appr-1" });
    expect(await res.json()).toEqual({ worker: "SPACES" });
    expect(calls).toHaveLength(1);
  });

  it("resubmitting with a NOT-yet-approved or already-used approval id is rejected 409", async () => {
    const { env, calls } = makeEnv({
      verify: { valid: true, tenant_id: "tenant-1", agent_id: "agent-1", approval_mode: "always_ask", auto_approved_actions: [] },
      consume: { consumed: false },
    });
    const res = await agentFetch("POST", "/v1/spaces/s1/projects", env, { "x-naelao-approval-id": "appr-1" });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});
