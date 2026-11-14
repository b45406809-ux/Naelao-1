import { describe, expect, it } from "vitest";
import { extensionDashboardPath, findMemberSpace, selectInstalledExtension, spaceCompatibilityHref } from "./space-extension-dashboard.js";

describe("Space extension dashboard handoff", () => {
  it("rejects a target Space that is absent from the authorized membership list", () => {
    const spaces = [{ id: "space-1", name: "One" }];
    expect(findMemberSpace(spaces, "space-1")).toEqual(spaces[0]);
    expect(findMemberSpace(spaces, "space-2")).toBeNull();
  });

  it("builds a same-product membership route with an encoded exact installation", () => {
    expect(spaceCompatibilityHref("team name", "space/one", "extensions", "install&1"))
      .toBe("/p/team%20name/spaces/space%2Fone?next=extensions&installationId=install%261");
    expect(spaceCompatibilityHref("team", "space-1", "settings", "ignored"))
      .toBe("/p/team/spaces/space-1?next=settings");
    expect(extensionDashboardPath("team name", "install&1"))
      .toBe("/p/team%20name/extensions?installationId=install%261");
    expect(extensionDashboardPath("team", "i".repeat(257))).toBe("/p/team/extensions");
  });

  it("auto-selects only the exact installation listed for the active Space", () => {
    const apps = [
      { installation_id: "install-1", app_id: "app-a" },
      { installation_id: "install-2", app_id: "app-b" },
    ];
    expect(selectInstalledExtension(apps, "install-2")).toEqual(apps[1]);
    expect(selectInstalledExtension(apps, "app-b")).toBeNull();
    expect(selectInstalledExtension(apps, "install-from-another-space")).toBeNull();
    expect(selectInstalledExtension(apps, null)).toBeNull();
  });
});
