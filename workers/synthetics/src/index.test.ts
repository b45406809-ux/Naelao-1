import { describe, expect, it } from "vitest";
import { buildSyntheticChecks } from "./index";

describe("synthetic check targets", () => {
  it("uses distinct router and backend dependency probes", () => {
    const checks = buildSyntheticChecks("https://api.example.test/");
    expect(checks).toEqual([
      { name: "router_health", url: "https://api.example.test/health" },
      {
        name: "platform_dependencies",
        url: "https://api.example.test/health/dependencies",
      },
    ]);
    expect(new Set(checks.map((check) => check.url)).size).toBe(checks.length);
  });
});
