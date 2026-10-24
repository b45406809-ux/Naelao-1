import { describe, it, expect } from "vitest";
import { packageAuthoring } from "./package-authoring.js";
import { PREBUILT_SCRIPTS } from "./index.js";
import { isReadSafeOperation } from "../assistant-access.js";
import { DEFAULT_NAELAO_AGENT } from "../profiles.js";
describe("shared package authoring inspection", () => {
  it("is discoverable and read-only", () => {
    expect(isReadSafeOperation("package.inspect")).toBe(true);
    expect(packageAuthoring.requires_tier).toBe(1);
    expect(PREBUILT_SCRIPTS["package-authoring"]).toBe(packageAuthoring);
    expect(DEFAULT_NAELAO_AGENT.config.scripts.prebuilt).toContain("package-authoring");
  });
  it("returns blockers without needing execution context or invoking a provider", async () => {
    const result = await packageAuthoring.operations["package.inspect"]!(
      { manifest: {}, files: {} },
      {} as never
    );
    expect(result).toMatchObject({
      state: "blocked",
      evidence: { hostExecuted: false, installed: false, certified: false },
    });
  });
});
