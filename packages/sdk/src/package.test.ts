import { describe, it, expect } from "vitest";
import {
  inspectExtensionPackage,
  type ExtensionPackageDraft,
} from "./package.js";
const draft = (): ExtensionPackageDraft => ({
  manifest: {
    schemaVersion: "1.0",
    kind: "extension_bundle",
    id: "ext_example",
    version: "1.0.0",
    primitives: [
      {
        schemaVersion: "1.0",
        kind: "linter",
        id: "example_linter",
        version: "1.0.0",
        permissions: [],
        capabilityRequirements: [],
        lifecycle: {},
        entry: "./lint.ts",
        mode: "deterministic",
        failureMode: "block",
      },
    ],
  },
  files: { "lint.ts": "export default () => true;" },
});
describe("private package inspection", () => {
  it("never claims execution, installation or certification", () => {
    expect(inspectExtensionPackage(draft())).toMatchObject({
      state: "validated",
      entrypoints: ["lint.ts"],
      evidence: { hostExecuted: false, installed: false, certified: false },
    });
  });
  it("requires entrypoint artifacts", () => {
    const d = draft();
    d.files = {};
    expect(inspectExtensionPackage(d).blockers).toContainEqual({
      code: "missing_entrypoint",
      path: "lint.ts",
    });
  });
  it.each([
    "../secret",
    "/assistant/memory",
    "a/../../b",
    "a\\b",
    "./lint.ts",
    "constructor/x",
  ])("rejects unsafe path %s", (path) => {
    const d = draft();
    d.files = { ...d.files, [path]: "x" };
    expect(inspectExtensionPackage(d).state).toBe("blocked");
  });
  it("bounds file count and UTF8 bytes", () => {
    const d = draft();
    d.files = { ...d.files, "large.txt": "é".repeat(1100000) };
    expect(inspectExtensionPackage(d).blockers).toContainEqual({
      code: "package_bytes_exceeded",
    });
    d.files = Object.fromEntries(
      Array.from({ length: 257 }, (_, i) => [`${i}.txt`, ""])
    );
    expect(inspectExtensionPackage(d).state).toBe("blocked");
  });
  it("fails invalid manifests closed", () => {
    expect(
      inspectExtensionPackage({ manifest: {}, files: {} } as never)
    ).toMatchObject({
      state: "blocked",
      blockers: [{ code: "invalid_manifest" }],
    });
  });
});
