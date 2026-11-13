import { describe, expect, it } from "vitest";
import { validateExtensionManifest } from "@naelao/agent-sdk";
import { supportsVersionOnlySpaceSharedCodeUpdate } from "./extension-update-contract.js";

function packageManifest(version: string, options: { channel?: boolean; gadget?: boolean; dynamicCanvas?: boolean; permission?: string } = {}) {
  return validateExtensionManifest({
    id: "ext_update_contract", type: "extension", declaredPermissions: options.permission ? [options.permission] : [],
    capabilityRequirements: ["extension.project_canvas"], gadgets: [], daemons: [], commands: [],
    bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_update_contract", version,
      primitives: [
        { schemaVersion: "1.0", kind: "canvas", id: "dashboard", version, permissions: [], capabilityRequirements: [], lifecycle: {},
          component: "./dashboard.html", layout: "CanvasMount", dynamicPage: options.dynamicCanvas === true },
        ...(options.channel ? [{ schemaVersion: "1.0", kind: "channel" as const, id: "inbound", version, permissions: [], capabilityRequirements: [], lifecycle: {},
          provider: "phone", handlerScript: "./handler.ts", context: "channel_only" as const, inboundEvents: ["message.received", "call.received"], outboundEvents: ["message.reply", "voice.reply"] }] : []),
        ...(options.gadget ? [{ schemaVersion: "1.0", kind: "gadget" as const, id: "records", version, permissions: [], capabilityRequirements: [], lifecycle: {},
          scope: "SPACE_SHARED" as const, schemaSql: "CREATE TABLE records(id TEXT PRIMARY KEY);", migrations: [] }] : []),
      ] },
  }, { gatekeeperCapabilities: ["extension.project_canvas"] });
}

describe("Space-shared code-only update contract", () => {
  it("allows a signed release-version change for static Canvas and channel handler code", () => {
    expect(supportsVersionOnlySpaceSharedCodeUpdate(
      packageManifest("1.0.0", { channel: true }), packageManifest("1.1.0", { channel: true }),
    )).toBe(true);
  });

  it("rejects package state schema, dynamic Canvas, authority and other manifest changes", () => {
    const current = packageManifest("1.0.0", { channel: true });
    expect(supportsVersionOnlySpaceSharedCodeUpdate(current, packageManifest("1.1.0", { channel: true, gadget: true }))).toBe(false);
    expect(supportsVersionOnlySpaceSharedCodeUpdate(current, packageManifest("1.1.0", { channel: true, dynamicCanvas: true }))).toBe(false);
    expect(supportsVersionOnlySpaceSharedCodeUpdate(current, packageManifest("1.1.0", { channel: true, permission: "assistant.phone.simulate" }))).toBe(false);
    expect(supportsVersionOnlySpaceSharedCodeUpdate(current, packageManifest("1.0.0", { channel: true }))).toBe(false);
  });
});
