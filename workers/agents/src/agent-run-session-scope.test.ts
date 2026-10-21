import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";
import { mintInternalToken } from "@naelao/http";

async function postRun(options: {
  role: string;
  scope: Record<string, unknown>;
}) {
  const secret = "agent-session-scope-test-secret";
  const tenantId = "tenant-a";
  const fetch = vi.fn(async () => Response.json(options.scope));
  const response = await worker.fetch(new Request(
    "https://agents.test/spaces/space-a/sessions/session-b/agent/run",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-user-id": "customer-a",
        "x-naelao-role": options.role,
        "x-naelao-internal-token": await mintInternalToken(secret, tenantId),
      },
      body: JSON.stringify({ goal: "Run a normal task" }),
    },
  ), {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: {
      prepare() { return { bind() { return { first: async () => ({ id: "space-a" }) }; } }; },
    },
    SPACES_WORKER: { fetch },
  } as never, {} as never);
  return { response, fetch };
}

describe("agent run session ownership", () => {
  it("does not read or run another product user's conversation", async () => {
    const { response, fetch } = await postRun({
      role: "product_end_user",
      scope: { project_id: null, owned_by_caller: false, private_scratchpad: false },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error_code: "session_unavailable" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(fetch.mock.calls[0]![0] instanceof Request ? fetch.mock.calls[0]![0].url : String(fetch.mock.calls[0]![0])).pathname)
      .toContain("/sessions/session-b/compact-scope");
  });

  it("keeps private scratchpads out of model execution", async () => {
    const { response, fetch } = await postRun({
      role: "product_end_user",
      scope: { project_id: null, owned_by_caller: true, private_scratchpad: true },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error_code: "private_scratchpad_client_only" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("blocks builders from sending encrypted scratchpads to a model", async () => {
    const { response, fetch } = await postRun({
      role: "owner",
      scope: { project_id: null, private_scratchpad: true },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error_code: "private_scratchpad_client_only" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("applies the same ownership gate to connector preferences and other session subroutes", async () => {
    const secret = "agent-session-scope-test-secret";
    const tenantId = "tenant-a";
    const fetch = vi.fn(async () => Response.json({
      project_id: null,
      owned_by_caller: false,
      private_scratchpad: false,
    }));
    const response = await worker.fetch(new Request(
      "https://agents.test/spaces/space-a/sessions/session-b/connector-mode",
      { headers: {
        "x-naelao-tenant-id": tenantId,
        "x-naelao-user-id": "customer-a",
        "x-naelao-role": "product_end_user",
        "x-naelao-internal-token": await mintInternalToken(secret, tenantId),
      } },
    ), {
      PLATFORM_SECRET: secret,
      SPACES_WORKER: { fetch },
    } as never, {} as never);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error_code: "session_unavailable" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
