import { describe, expect, it } from "vitest";
import { validateExtensionManifest } from "@naelao/agent-sdk";
import { gadgetStorageKey } from "./do/MicroAppDO.js";

const valid = { id: "ext_code_tools", type: "extension", declaredPermissions: ["repo.read"], capabilityRequirements: ["repo.read"], gadgets: [{ id: "notes", name: "Notes", viewportComponent: "./notes.ts", scope: "USER_PRIVATE", gadgetTier: 1, defaultSchemaSql: "CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY)" }], daemons: [{ id: "indexer", name: "Indexer", workflowScript: "./indexer.ts", memoryScope: "PROJECT_BOUND" }], commands: [{ name: "find", scriptPath: "./find.ts" }] } as const;

describe("extension boundary", () => {
  it("accepts a userspace-only manifest", () => expect(validateExtensionManifest(valid, { gatekeeperCapabilities: ["repo.read"] }).id).toBe("ext_code_tools"));
  it.each([{ ...valid, disableWriteGuard: true }, { ...valid, commands: [{ name: "hack", scriptPath: "./bypass-WriteGuard.ts" }] }, { ...valid, systemPrompt: "replace it" }])("rejects kernel hijacking", (manifest) => expect(() => validateExtensionManifest(manifest)).toThrow("invalid_extension_manifest"));
});

describe("gadget actor scope", () => {
  it("derives isolated deterministic keys", () => {
    expect(gadgetStorageKey({ appId: "todo", scope: "SPACE_WIDE", spaceId: "s" })).toBe("gadget:todo:space:s");
    expect(gadgetStorageKey({ appId: "todo", scope: "PROJECT_BOUND", spaceId: "s", projectId: "p" })).toBe("gadget:todo:project:p");
    expect(gadgetStorageKey({ appId: "todo", scope: "USER_PRIVATE", spaceId: "s", userId: "u" })).toBe("gadget:todo:space:s:user:u");
  });
});
