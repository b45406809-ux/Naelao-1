import { describe, expect, it } from "vitest";
import {
  PROJECT_KINDS,
  PROJECT_KIND_MANIFESTS,
  acceptCanvasEvent,
  validateGeneratedWidget,
} from "../../packages/agent-sdk/src/canvas-runtime";
import {
  gadgetStorageKey,
  requireExtensionPermission,
  validateExtensionManifest,
} from "../../packages/agent-sdk/src/extensions";
import { WORKFLOW_CLASS_POLICIES } from "../../packages/agent-sdk/src/workflow-taxonomy";

describe("configuration-driven canvas and extension security", () => {
  it("defines exactly the seven foundational project manifests", () => {
    expect(Object.keys(PROJECT_KIND_MANIFESTS)).toEqual(PROJECT_KINDS);
  });
  it("validates iframe origin and schema and refuses executable generated widgets", () => {
    expect(() =>
      acceptCanvasEvent(
        { origin: "https://evil.example", data: {} } as MessageEvent,
        "https://canvas.naelao.com",
        "p1"
      )
    ).toThrow("origin");
    expect(() =>
      validateGeneratedWidget({
        kind: "approval",
        props: { script: "alert(1)" },
      })
    ).toThrow("executable");
  });
  it("enforces declared permissions, bounded daemon retries, and namespaced gadget keys", () => {
    const manifest = validateExtensionManifest({
      id: "citation-graph",
      version: "1.0.0",
      permissions: ["storage:read"],
      tools: [],
      maxRetries: 3,
    });
    expect(() => requireExtensionPermission(manifest, "network")).toThrow(
      "denied"
    );
    expect(() =>
      validateExtensionManifest({ ...manifest, maxRetries: 6 })
    ).toThrow("between 0 and 5");
    expect(gadgetStorageKey("t", "s", "p", "g", "rows/1")).toBe(
      "gadgets/t/s/p/g/rows/1"
    );
  });
  it("maps every workflow class to explicit lifecycle and billing behavior", () => {
    for (const policy of Object.values(WORKFLOW_CLASS_POLICIES)) {
      expect(policy.owner).toBeTruthy();
      expect(policy.persistence).toBeTruthy();
      expect(policy.maxAttempts).toBeGreaterThan(0);
      expect(policy.cancellation).toBeTruthy();
      expect(policy.billing).toBeTruthy();
    }
  });
});
