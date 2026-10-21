import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "./index.js";

const secret = "approval-route-secret";

function env(active: boolean) {
  const agentFetch = vi.fn(async () => Response.json({ created: true }));
  const hitlFetch = vi.fn(async () => Response.json({ consumed: true }));
  const value = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => active ? { id: "space-a" } : null }) }) },
    NAELAO_AGENT_DO: { idFromName: (name: string) => name, get: () => ({ fetch: agentFetch }) },
    HITL_APPROVAL_DO: { idFromName: (name: string) => name, get: () => ({ fetch: hitlFetch }) },
  } as never;
  return { value, agentFetch, hitlFetch };
}

async function post(path: string, binding: ReturnType<typeof env>) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant-a",
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
    },
    body: JSON.stringify(path.endsWith("/consume")
      ? { spaceId: "space-a", approvalId: "approval-a", agentId: "agent-a", actionKey: "invoice.create" }
      : { spaceId: "space-a", tenantId: "tenant-a", agentId: "agent-a", actionKey: "invoice.create", description: "Create invoice" }),
  }, binding.value);
}

describe("tenant suspension on external agent approvals", () => {
  it("blocks approval creation and consumption before either Durable Object is reached", async () => {
    const binding = env(false);
    const create = await post("/internal/agent-approvals", binding);
    const consume = await post("/internal/agent-approvals/consume", binding);

    expect(create.status).toBe(403);
    expect(await create.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect(consume.status).toBe(403);
    expect(await consume.json()).toMatchObject({ consumed: false, reason: "tenant_suspended" });
    expect(binding.agentFetch).not.toHaveBeenCalled();
    expect(binding.hitlFetch).not.toHaveBeenCalled();
  });
});
