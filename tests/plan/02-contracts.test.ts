import { describe, expect, it } from "vitest";
import {
  migrateLegacyExtensionManifest,
  parseExtensionPrimitive,
  serializeExtensionPrimitive,
  type ExtensionPrimitiveManifest,
} from "@naelao/sdk";
import { createSdkContext } from "@naelao/sdk";
import { defineChannelAdapter, type ChannelAdapter } from "@naelao/sdk/channel";
import { createContractTestHarness } from "@naelao/sdk/testing";
import { restartLocalWorkers, retrieveSeededSpace, seedSpace } from "./support/runtime";

const base = {
  schemaVersion: "1.0" as const,
  version: "1.0.0",
  permissions: [{ scope: "PROJECT_BOUND" as const, actions: ["read" as const], resource: "project" }],
  capabilityRequirements: ["project.read"],
  lifecycle: {},
};

const manifests: ExtensionPrimitiveManifest[] = [
  { ...base, kind: "gadget", id: "gadget.notes", scope: "PROJECT_BOUND", schemaSql: "CREATE TABLE notes (id TEXT PRIMARY KEY)" },
  { ...base, kind: "canvas", id: "canvas.notes", layout: "CanvasFirst", component: "src/notes.tsx", dynamicPage: true },
  { ...base, kind: "channel", id: "channel.email", provider: "email", inboundEvents: ["message.received"], outboundEvents: ["message.send"] },
  { ...base, kind: "container", id: "container.worker", image: "registry.example/test@sha256:" + "a".repeat(64), resources: { memoryMb: 128, cpuCores: 1, timeoutSeconds: 30 }, exportedBinaries: ["run"] },
  { ...base, kind: "linter", id: "linter.policy", mode: "deterministic", entry: "src/lint.ts", failureMode: "block" },
  { ...base, kind: "workflow", id: "workflow.sync", executionMode: "headless", steps: ["src/steps/sync.ts"], toolNames: ["project.read"] },
];

describe("Step 02 versioned extension contracts", () => {
  it("round-trips all six primitive kinds through the public facade", () => {
    const harness = createContractTestHarness();
    for (const manifest of manifests) expect(harness.roundTrip(manifest)).toEqual(manifest);
  });

  it("rejects unknown versions and security-sensitive fields", () => {
    expect(() => parseExtensionPrimitive({ ...manifests[0], schemaVersion: "9.0" })).toThrow(/unsupported_schema_version/);
    expect(() => parseExtensionPrimitive({ ...manifests[0], unexpected: true })).toThrow(/unknown_field/);
    expect(() => parseExtensionPrimitive({ ...manifests[0], kind: "project_manager" })).toThrow(/unknown_primitive_kind/);
  });

  it("migrates the old manifest shape and keeps new manifests out of the legacy parser", () => {
    const migrated = migrateLegacyExtensionManifest({ id: "legacy", version: "1.0.0", permissions: ["storage:read"], tools: ["read"], maxRetries: 1 });
    expect(migrated.schemaVersion).toBe("1.0");
    expect(migrated.primitives).toHaveLength(1);
    expect(() => parseExtensionPrimitive(migrated)).toThrow(/unknown_primitive_kind/);
    expect(parseExtensionPrimitive(migrated.primitives[0]).kind).toBe("gadget");
  });

  it("exposes a thin SDK context and channel/testing subpaths", () => {
    expect(createSdkContext({ spaceId: "space-1", projectId: "project-1", extensionId: "gadget.notes", scope: "PROJECT_BOUND" }).spaceId).toBe("space-1");
    const adapter: ChannelAdapter = { manifest: manifests[2] as Extract<ExtensionPrimitiveManifest, { kind: "channel" }>, receive: async () => [], send: async () => undefined };
    expect(defineChannelAdapter(adapter).manifest.kind).toBe("channel");
    expect(serializeExtensionPrimitive(manifests[0])).toContain('"schemaVersion":"1.0"');
  });

  it("retains the contract state across a restart/replay probe", async () => {
    const seeded = await seedSpace();
    await restartLocalWorkers();
    expect(await retrieveSeededSpace()).toEqual(seeded);
  });
});
