import { describe, expect, it, vi } from "vitest";
import { activateSpaceForActiveTenant } from "./space-provisioning-state.js";

describe("Space provisioning activation guard", () => {
  it("only activates while the same tenant is active and the Space is provisioning", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn((_spaceId: string, _tenantId: string) => ({ run }));
    const prepare = vi.fn((_sql: string) => ({ bind }));

    await expect(activateSpaceForActiveTenant({ prepare } as never, { spaceId: "space-a", tenantId: "tenant-a" }))
      .resolves.toBe(true);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("o.status = 'active'"));
    expect(prepare.mock.calls[0]?.[0]).toContain("status = 'provisioning'");
    expect(bind).toHaveBeenCalledWith("space-a", "tenant-a");
  });

  it("does not claim success when suspension wins the activation race", async () => {
    const db = { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }) };

    await expect(activateSpaceForActiveTenant(db as never, { spaceId: "space-a", tenantId: "tenant-a" }))
      .resolves.toBe(false);
  });
});
