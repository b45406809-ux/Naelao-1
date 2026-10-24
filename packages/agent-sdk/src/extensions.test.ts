import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSharedFilesystemPathAllowed, parseExtensionBundle, validateExtensionManifest } from "./extensions.js";

const valid = { id: "ext_safe", type: "extension", declaredPermissions: ["repo.read"], capabilityRequirements: ["repo.read"], gadgets: [], daemons: [], commands: [] };
describe("immutable extension kernel", () => {
  it("requires explicit read and write capabilities for shared-drive grants", () => {
    const grant = { path: "/space/shared/dropzones/audio/", access: "READ_WRITE" };
    expect(() => validateExtensionManifest({ ...valid, capabilityRequirements: ["space.shared.read"], shared_filesystem: [grant] }))
      .toThrow("shared_filesystem_write_capability_required");
    const manifest = validateExtensionManifest({ ...valid, capabilityRequirements: ["space.shared.read", "space.shared.write"], shared_filesystem: [grant] });
    expect(manifest.shared_filesystem).toEqual([grant]);
    expect(() => validateExtensionManifest({ ...valid, capabilityRequirements: ["space.shared.read"], shared_filesystem: [{ path: "/space/shared/dropzones/audio/", access: "READ" }] }))
      .not.toThrow();
  });
  it.each(["/space/shared/../assistant/", "/space/shared//audio/", "/space/shared/audio", "/space/private/"])("rejects noncanonical or out-of-root shared grants: %s", path => {
    expect(() => validateExtensionManifest({ ...valid, capabilityRequirements: ["space.shared.read"], shared_filesystem: [{ path, access: "READ" }] }))
      .toThrow("invalid_shared_filesystem_path");
  });
  it("jails shared-drive paths to the granted directory and access mode", () => {
    const grants = [{ path: "/space/shared/dropzones/audio/", access: "READ" as const }];
    expect(isSharedFilesystemPathAllowed(grants, "dropzones/audio/in.wav", "read")).toBe(true);
    expect(isSharedFilesystemPathAllowed(grants, "dropzones/audio/in.wav", "write")).toBe(false);
    expect(isSharedFilesystemPathAllowed(grants, "dropzones/audio-old/in.wav", "read")).toBe(false);
    expect(isSharedFilesystemPathAllowed(grants, "dropzones/audio/../../assistant/memory.sqlite", "read")).toBe(false);
    expect(isSharedFilesystemPathAllowed(grants, "/space/shared/dropzones/audio/in.wav", "read")).toBe(false);
  });
  it("verifies declared requirements against Gatekeeper capabilities", () => expect(validateExtensionManifest(valid, { gatekeeperCapabilities: ["repo.read"] }).id).toBe("ext_safe"));
  it("validates modular releaseVersion without treating it as the legacy version field", () => {
    expect(validateExtensionManifest({ ...valid, releaseVersion: "1.2.3" }).releaseVersion).toBe("1.2.3");
    expect(() => validateExtensionManifest({ ...valid, releaseVersion: "latest" })).toThrow("invalid_release_version");
  });
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
  it("rejects traversal in legacy script and viewport paths", () => {
    expect(() => validateExtensionManifest({ ...valid, gadgets: [{ id: "gadget_a", name: "A", viewportComponent: "./../escape.ts", scope: "PROJECT_SHARED", gadgetTier: 2, defaultSchemaSql: "" }] }))
      .toThrow("invalid_extension_manifest:invalid_viewport");
    expect(() => validateExtensionManifest({ ...valid, daemons: [{ id: "daemon_a", name: "A", workflowScript: "./../../escape.ts", memoryScope: "PROJECT_BOUND" }] }))
      .toThrow("invalid_extension_manifest:invalid_workflow_script");
    expect(() => validateExtensionManifest({ ...valid, commands: [{ name: "command_a", scriptPath: "../escape.ts" }] }))
      .toThrow("invalid_extension_manifest:invalid_command_path");
  });
  it("bounds recursive manifest inspection and repeated references", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 70; index++) { cursor.next = {}; cursor = cursor.next as Record<string, unknown>; }
    expect(() => validateExtensionManifest({ ...valid, metadata: deep })).toThrow("invalid_extension_manifest:manifest_complexity_limit");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => validateExtensionManifest({ ...valid, metadata: cycle })).toThrow("invalid_extension_manifest:manifest_cycle");
    expect(() => validateExtensionManifest({ ...valid, gadgets: Array.from({ length: 129 }, () => ({})) })).toThrow("invalid_extension_manifest:arrays_required_or_limit_exceeded");
  });
});

describe("composed extension bundle contract", () => {
  const bundle = {
    schemaVersion: "1.0", kind: "extension_bundle", id: "ext_trading_mentor", version: "1.0.0",
    primitives: [
      { schemaVersion: "1.0", kind: "canvas", id: "mentor_console", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {}, layout: "CanvasMount", component: "./console.tsx", dynamicPage: false },
      { schemaVersion: "1.0", kind: "channel", id: "student_whatsapp", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {}, provider: "whatsapp", connectionId: "student_channel", handlerScript: "./handler.ts", context: "channel_only", inboundEvents: ["message.received"], outboundEvents: ["message.reply"], knowledgeCollections: ["course_material"], session: { enabled: true, maxBytes: 2048, ttlDays: 30 } },
    ],
    workerRoles: [{ id: "answer_student", principal: "external_channel_subject", invocation: "workflow_step", execution: "worker", entry: "./answer.ts", primitiveIds: ["student_whatsapp"] }],
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
  it("rejects path traversal in composed asset, lifecycle, and worker entry paths", () => {
    expect(() => parseExtensionBundle({ ...bundle, primitives: [{ ...bundle.primitives[0], component: "./../outside.tsx" }, bundle.primitives[1]] }))
      .toThrow("invalid_extension_contract:invalid_canvas_component");
    expect(() => parseExtensionBundle({ ...bundle, primitives: [{ ...bundle.primitives[0], lifecycle: { onLoad: "./../outside.ts" } }, bundle.primitives[1]] }))
      .toThrow("invalid_extension_contract:invalid_lifecycle_hook");
    expect(() => parseExtensionBundle({ ...bundle, workerRoles: [{ ...bundle.workerRoles[0], entry: "../../outside.ts" }] }))
      .toThrow("invalid_extension_contract:invalid_worker_entry");
  });
  it("validates the published trading mentor channel starter package", () => {
    const manifest = JSON.parse(readFileSync(new URL("../examples/trading-mentor-channel/manifest.json", import.meta.url), "utf8"));
    expect(manifest.id).toBe("ext_trading_mentor_student_helper");
    expect(() => parseExtensionBundle(manifest.bundle)).not.toThrow();
    expect(() => validateExtensionManifest(manifest, { gatekeeperCapabilities: manifest.capabilityRequirements })).not.toThrow();
    expect(manifest.bundle.primitives.map((part: { id: string }) => part.id)).toEqual(["mentor_console", "trade_journal", "student_whatsapp", "place_order"]);
    expect(manifest.bundle.workerRoles[0].primitiveIds).toEqual(["place_order"]);
  });
  it("binds an executable workflow part to an explicit worker role and entry artifact", () => {
    const workflow = { schemaVersion: "1.0", kind: "workflow", id: "place_order", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {},
      executionMode: "interactive", entry: "./place-order.ts", steps: [], toolNames: ["orders.place", "orders.status"] };
    const composed = { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_trading_mentor", version: "1.0.0", primitives: [workflow],
      workerRoles: [{ id: "order_worker", principal: "project_member", invocation: "workflow_step", execution: "worker", entry: "./place-order.ts", primitiveIds: ["place_order"] }] };
    expect(parseExtensionBundle(composed).primitives[0]).toMatchObject({ kind: "workflow", entry: "./place-order.ts", toolNames: ["orders.place", "orders.status"] });
    expect(() => parseExtensionBundle({ ...composed, workerRoles: [] })).toThrow("workflow_worker_role_binding_required");
    expect(() => parseExtensionBundle({ ...composed, workerRoles: [{ ...composed.workerRoles[0], principal: "public" }] })).toThrow("invalid_worker_principal");
    expect(() => parseExtensionBundle({ ...composed, primitives: [{ ...workflow, entry: "../outside.ts" }] })).toThrow("invalid_workflow");
    const gadget = { schemaVersion: "1.0", kind: "gadget", id: "journal", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {}, scope: "PROJECT_BOUND", schemaSql: "CREATE TABLE trades(id TEXT PRIMARY KEY)" };
    const withGadget = { ...composed, primitives: [gadget, { ...workflow, toolNames: ["extension.gadget.insert"] }],
      workerRoles: [{ ...composed.workerRoles[0], gadgetActions: [{ gadgetId: "journal", operations: ["extension.gadget.insert"], tables: ["trades"] }] }] };
    expect(parseExtensionBundle(withGadget).primitives).toHaveLength(2);
    expect(() => parseExtensionBundle({ ...composed, primitives: [{ ...workflow, toolNames: ["extension.gadget.insert"] }] })).toThrow("invalid_workflow_gadget_capability");
    expect(() => parseExtensionBundle({ ...withGadget, primitives: [gadget, { ...workflow, toolNames: ["extension.gadget.drop"] }] })).toThrow("invalid_workflow_gadget_capability");
    expect(() => parseExtensionBundle({ ...composed, primitives: [gadget, { ...workflow, toolNames: ["extension.gadget.insert"] }] })).toThrow("workflow_gadget_action_grant_required");
    expect(() => parseExtensionBundle({ ...withGadget, workerRoles: [{ ...withGadget.workerRoles[0], gadgetActions: [{ gadgetId: "journal", operations: ["extension.gadget.delete"], tables: ["trades"] }] }] })).toThrow("worker_gadget_operation_not_declared");
    expect(() => parseExtensionBundle({ ...withGadget, workerRoles: [{ ...withGadget.workerRoles[0], gadgetActions: [{ gadgetId: "journal", operations: ["extension.gadget.insert"], tables: ["private_notes"] }] }] })).toThrow("worker_gadget_table_not_declared");
    expect(() => parseExtensionBundle({ ...withGadget, workerRoles: [withGadget.workerRoles[0], { ...withGadget.workerRoles[0], id: "duplicate_order_role" }] })).toThrow("workflow_gadget_role_ambiguous");
  });
});
