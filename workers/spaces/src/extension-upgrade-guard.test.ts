import { describe, expect, it } from "vitest";
import { findUnsafeProjectExtensionUpgrade } from "./extension-upgrade-guard.js";

describe("project extension upgrade guard", () => {
  const target = { extensionId: "ext_example", projectId: "project-a", instanceKey: "default" };
  const install = (overrides: Record<string, unknown> = {}) => ({
    instance_id: "install-a", extension_id: "ext_example", project_id: "project-a", scope: "PROJECT_BOUND", instance_key: "default", status: "active", ...overrides,
  });

  it("allows a single target instance and ignores removed history", () => {
    expect(findUnsafeProjectExtensionUpgrade([install(), install({ instance_id: "old", status: "removed" })], target)).toEqual([]);
  });

  it("blocks when the shared release would change a sibling project or named instance", () => {
    expect(findUnsafeProjectExtensionUpgrade([
      install(),
      install({ instance_id: "install-b", project_id: "project-b" }),
      install({ instance_id: "install-c", instance_key: "secondary" }),
    ], target).map((item) => item.instance_id)).toEqual(["install-b", "install-c"]);
  });

  it("also blocks paused or incomplete sibling installations", () => {
    expect(findUnsafeProjectExtensionUpgrade([
      install({ instance_id: "paused", project_id: "project-b", status: "disabled" }),
      install({ instance_id: "staged", project_id: "project-b", status: "staging" }),
    ], target).map((item) => item.instance_id)).toEqual(["paused", "staged"]);
  });
});
