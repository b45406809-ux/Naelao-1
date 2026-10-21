import { describe, expect, it, vi } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

const secret = "tenant-continuation-secret";

describe("continuation dispatch suspension gate", () => {
  it("does not resume an interrupted agent run for a suspended organization", async () => {
    const doFetch = vi.fn(async () => Response.json({ resumed: true }));
    const env = {
      PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
      NAELAO_AGENT_DO: { idFromName: (name: string) => name, get: () => ({ fetch: doFetch }) },
    } as never;
    const response = await app.request("/spaces/space-a/sessions/session-a/agent/interrupted", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
      },
      body: JSON.stringify({ run_id: "run-a", action: "continue" }),
    }, env);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect(doFetch).not.toHaveBeenCalled();
  });
});
