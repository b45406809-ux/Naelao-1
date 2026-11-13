import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "./index.js";

describe("sidecar artifact transfer receipt route", () => {
  it("requires Space owner/admin authority before exposing private paths and hashes", async () => {
    const secret = "sidecar-receipt-route-secret";
    const spacesWorker = { fetch: vi.fn() };
    const env = {
      PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ role: "member" }) }) }) },
      SPACES_WORKER: spacesWorker,
    } as never;
    const response = await app.request("/spaces/space/projects/project/runtime-installations/install/containers/build/artifact-transfers?branch=runs/review", {
      headers: { "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "member", "x-naelao-role": "product_end_user",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant") },
    }, env);

    expect(response.status).toBe(403);
    expect(spacesWorker.fetch).not.toHaveBeenCalled();
  });
});
