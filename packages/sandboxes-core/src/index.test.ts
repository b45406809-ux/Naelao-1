import { describe, expect, it } from "vitest";
import {
  assertWorkspacePath,
  estimateAgent37Monthly,
  selectProvider,
  validateComputerScope,
  validateResourceShape,
} from "./index.js";

describe("sandbox contracts", () => {
  it("requires tenant/space/project scope hierarchy", () => {
    expect(() =>
      validateComputerScope({ tenantId: "t", ownerId: "u", projectId: "p" })
    ).toThrow("invalid_computer_scope_hierarchy");
    expect(() =>
      validateComputerScope({
        tenantId: "t",
        ownerId: "u",
        spaceId: "s",
        projectId: "p",
      })
    ).not.toThrow();
  });
  it("rejects unsafe or runtime-owned paths", () => {
    expect(assertWorkspacePath("src/main.ts")).toBe("src/main.ts");
    for (const path of [
      "../secret",
      "/etc/passwd",
      "src\\..\\secret",
      "node_modules/x",
      ".git/config",
    ])
      expect(() => assertWorkspacePath(path)).toThrow();
  });
  it("only auto-selects connections that have passed verification", () => {
    const connections = [
      {
        provider: "agent37" as const,
        status: "configured_unverified" as const,
        capabilities: ["exec" as const],
      },
      {
        provider: "opensandbox" as const,
        status: "verified" as const,
        capabilities: ["exec" as const],
      },
    ];
    expect(selectProvider(connections, ["exec"], "auto")?.provider).toBe(
      "opensandbox"
    );
    expect(selectProvider(connections, ["desktop.control"], "auto")).toBeNull();
    expect(selectProvider(connections, ["exec"], "agent37")).toBeNull();
  });
  it("validates shapes and records a transparent USD micro estimate", () => {
    expect(() =>
      validateResourceShape({ cpu: 1, memoryMiB: 512, diskGiB: 2 })
    ).not.toThrow();
    expect(() =>
      validateResourceShape({ cpu: 0, memoryMiB: 512, diskGiB: 2 })
    ).toThrow("invalid_cpu");
    const estimate = estimateAgent37Monthly(
      { cpu: 2, memoryMiB: 4096, diskGiB: 4 },
      0.5,
      "2026-11-06T00:00:00Z"
    );
    expect(estimate.currency).toBe("USD");
    expect(estimate.micros).toBe(3_960_000);
    expect(
      estimateAgent37Monthly(
        { cpu: 2, memoryMiB: 4096, diskGiB: 4 },
        1,
        "2026-11-06T00:00:00Z"
      ).micros
    ).toBe(4_760_000);
    expect(
      estimateAgent37Monthly(
        { cpu: 2, memoryMiB: 4096, diskGiB: 4 },
        1,
        "2026-11-06T00:00:00Z",
        "vm"
      ).micros
    ).toBe(7_160_000);
  });
});
