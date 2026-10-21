import { describe, expect, it, vi } from "vitest";
import { provisionSpace } from "./index.js";
import type { Env } from "./index.js";
import type { ProvisionMessage } from "./message-contract.js";

const message: ProvisionMessage = {
  type: "space_provision",
  spaceId: "space-a",
  tenantId: "tenant-a",
  spaceTypeId: "launchpad",
  spaceName: "Acme",
  requestedAt: "2026-10-21T00:00:00.000Z",
};

describe("provisioning tenant suspension gate", () => {
  it("does not start provisioning for a suspended or unknown tenant", async () => {
    const first = vi.fn(async () => null);
    const run = vi.fn();
    const prepare = vi.fn(() => ({ bind: () => ({ first, run }) }));
    const put = vi.fn();
    const env = {
      PLATFORM_DB: { prepare },
      SPACES_KV: { put },
    } as unknown as Env;

    await provisionSpace(message, env);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("JOIN orgs"));
    expect(first).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("propagates an authorization lookup outage so queue delivery can retry", async () => {
    const prepare = vi.fn(() => { throw new Error("D1 unavailable"); });
    const env = { PLATFORM_DB: { prepare } } as unknown as Env;

    await expect(provisionSpace(message, env)).rejects.toThrow("D1 unavailable");
  });
});
