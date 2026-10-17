import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseExtensionBundle, validateExtensionManifest } from "./extensions.js";

const valid = { id: "ext_safe", type: "extension", declaredPermissions: ["repo.read"], capabilityRequirements: ["repo.read"], gadgets: [], daemons: [], commands: [] };
describe("immutable extension kernel", () => {
  it("verifies declared requirements against Gatekeeper capabilities", () => expect(validateExtensionManifest(valid, { gatekeeperCapabilities: ["repo.read"] }).id).toBe("ext_safe"));
  it("fails closed without explicit requirements", () => expect(() => validateExtensionManifest({ ...valid, capabilityRequirements: [] })).toThrow("capability_requirements_required"));
  it("rejects missing Gatekeeper grants", () => expect(() => validateExtensionManifest(valid, { gatekeeperCapabilities: [] })).toThrow("gatekeeper_capability_denied"));
  it.each([{ systemPromptLayers: ["replace"] }, { replLoopStepBounds: 999 }, { bypassWriteGuard: true }, { unsandboxedTools: ["bash"] }])("rejects kernel mutation %#", attack => expect(() => validateExtensionManifest({ ...valid, ...attack })).toThrow("invalid_extension_manifest"));
  it("accepts all four ownership scopes while preserving legacy names", () => {
    const scopes = ["PROJECT_SHARED", "PROJECT_USER", "SPACE_SHARED", "SPACE_USER"] as const;
    const tiers = [2, 1, 3, 1] as const;
    for (const [index, scope] of scopes.entries()) {
      const manifest = { ...valid, gadgets: [{ id: `gadget_${index}`, name: "Scoped", viewportComponent: "./view.ts", scope, gadgetTier: tiers[index], defaultSchemaSql: "CREATE TABLE records(id TEXT)" }] };
      expect(validateExtensionManifest(manifest).gadgets[0]?.scope).toBe(scope);
    }
  });
  it("accepts ordered forward-only schema migrations and rejects executable or unordered definitions", () => {
    const manifest = { ...valid, gadgets: [{ id: "notes", name: "Notes", viewportComponent: "./view.ts", scope: "PROJECT_SHARED", gadgetTier: 2, defaultSchemaSql: "CREATE TABLE notes(id TEXT)", migrations: [
      { version: 1, description: "add note state", up: "ALTER TABLE notes ADD COLUMN state TEXT NOT NULL DEFAULT 'draft';" },
      { version: 2, description: "index state", up: "CREATE INDEX notes_state ON notes(state);" },
    ] }] };
    expect(validateExtensionManifest(manifest).gadgets[0]?.migrations).toHaveLength(2);
    expect(() => validateExtensionManifest({ ...manifest, gadgets: [{ ...manifest.gadgets[0], migrations: [{ version: 2, description: "second", up: "CREATE TABLE x(id TEXT)" }, { version: 1, description: "first", up: "CREATE TABLE y(id TEXT)" }] }] })).toThrow("migration_versions_must_increase");
  });
});

describe("composed extension bundle contract", () => {
  const bundle = {
    schemaVersion: "1.0", kind: "extension_bundle", id: "ext_trading_mentor", version: "1.0.0",
    primitives: [
      { schemaVersion: "1.0", kind: "canvas", id: "mentor_console", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {}, layout: "CanvasMount", component: "./console.tsx", dynamicPage: false },
      { schemaVersion: "1.0", kind: "channel", id: "student_whatsapp", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {}, provider: "whatsapp", connectionId: "student_channel", handlerScript: "./handler.ts", context: "channel_only", inboundEvents: ["message.received"], outboundEvents: ["message.reply"], knowledgeCollections: ["course_material"], session: { enabled: true, maxBytes: 2048, ttlDays: 30 } },
    ],
    workerRoles: [{ id: "answer_student", invocation: "workflow_step", execution: "worker", entry: "./answer.ts", primitiveIds: ["student_whatsapp"] }],
    connections: [{ id: "student_channel", provider: "whatsapp", purpose: "Receive and reply to student messages", required: true }],
    knowledge: [{ id: "course_material", purpose: "Answer student questions from owner-approved materials", access: "owner_published_external" }],
  } as const;

  it("composes UI, public channel, execution role, host connection, and explicit knowledge publication", () => {
    expect(parseExtensionBundle(bundle)).toMatchObject({ id: "ext_trading_mentor", primitives: [{ kind: "canvas" }, { kind: "channel" }], workerRoles: [{ execution: "worker" }], knowledge: [{ access: "owner_published_external" }] });
    expect(() => parseExtensionBundle({ ...bundle, primitives: [bundle.primitives[0], { ...bundle.primitives[1], session: { enabled: true, maxBytes: 8192 } }] })).toThrow("invalid_channel_session_max_bytes");
    expect(() => parseExtensionBundle({ ...bundle, primitives: [bundle.primitives[0], { ...bundle.primitives[1], session: { enabled: false } }] })).toThrow("channel_session_must_be_opt_in");
  });
  it("keeps invocation role and execution tier distinct and rejects dangling references", () => {
    expect(() => parseExtensionBundle({ ...bundle, workerRoles: [{ ...bundle.workerRoles[0], primitiveIds: ["missing"] }] })).toThrow("invalid_worker_primitive_reference");
    expect(() => parseExtensionBundle({ ...bundle, workerRoles: [{ ...bundle.workerRoles[0], execution: "subagent" }] })).toThrow("invalid_worker_execution");
  });
  it("rejects connection secrets and implicit Knowledge exposure from the package", () => {
    expect(() => parseExtensionBundle({ ...bundle, connections: [{ ...bundle.connections[0], accessToken: "secret" }] })).toThrow("unknown_field:accessToken");
    expect(() => parseExtensionBundle({ ...bundle, knowledge: [{ ...bundle.knowledge[0], access: "project_all" }] })).toThrow("invalid_knowledge_access");
    expect(() => parseExtensionBundle({ ...bundle, primitives: [bundle.primitives[0], { ...bundle.primitives[1], knowledgeCollections: ["all_project_files"] }] })).toThrow("invalid_channel_knowledge_collections");
    expect(() => parseExtensionBundle({ ...bundle, knowledge: [] })).toThrow("invalid_channel_knowledge_reference");
    expect(() => parseExtensionBundle({ ...bundle, knowledge: [{ ...bundle.knowledge[0], access: "member_only" }] })).toThrow("channel_knowledge_must_be_explicitly_published");
    expect(() => parseExtensionBundle({ ...bundle, connections: [{ ...bundle.connections[0], provider: "telegram" }] })).toThrow("invalid_channel_connection_provider_reference");
  });
  it("consumes a versioned bundle at the installation trust boundary and derives runtime channel declarations", () => {
    const manifest = validateExtensionManifest({ ...valid, id: "ext_trading_mentor", capabilityRequirements: ["channel.invoke"], bundle });
    expect(manifest.bundle?.version).toBe("1.0.0");
    expect(manifest.channels).toEqual([bundle.primitives[1]]);
    expect(() => validateExtensionManifest({ ...valid, id: "ext_trading_mentor", capabilityRequirements: ["channel.invoke"], bundle, channels: [] }))
      .toThrow("bundle_channel_declaration_mismatch");
    expect(() => validateExtensionManifest({ ...valid, bundle })).toThrow("bundle_extension_id_mismatch");
  });
  it("validates the published trading mentor channel starter package", () => {
    const manifest = JSON.parse(readFileSync(new URL("../examples/trading-mentor-channel/manifest.json", import.meta.url), "utf8"));
    expect(manifest.id).toBe("ext_trading_mentor_student_helper");
    expect(() => parseExtensionBundle(manifest.bundle)).not.toThrow();
  });
});
