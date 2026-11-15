import { describe, expect, it } from "vitest";
import { LIST_LOW_STOCK_INPUT_SCHEMA, LIST_LOW_STOCK_OUTPUT_SCHEMA, validateExtensionManifest } from "@naelao/agent-sdk";
import { spaceSharedAuthorityExpansion, spaceSharedGadgetMigrationPlan, supportsOwnerApprovedSpaceSharedAuthorityExpansion,
  spaceSharedDependencyExpansion, spaceSharedGadgetMigrationRetentionPlan, supportsOwnerApprovedSpaceSharedDependencyExpansion,
  supportsVersionOnlySpaceSharedCodeUpdate, supportsVersionOnlySpaceSharedPackageUpdate } from "./extension-update-contract.js";

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

function gadgetPackage(version: string, migrations: Array<{ version: number; description: string; up: string }>) {
  return validateExtensionManifest({
    id: "ext_update_contract", type: "extension", declaredPermissions: [], capabilityRequirements: ["extension.project_canvas"],
    gadgets: [], daemons: [], commands: [],
    bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_update_contract", version,
      primitives: [
        { schemaVersion: "1.0", kind: "canvas", id: "dashboard", version, permissions: [], capabilityRequirements: [], lifecycle: {},
          component: "./dashboard.html", layout: "CanvasMount", dynamicPage: false },
        { schemaVersion: "1.0", kind: "gadget", id: "records", version, permissions: [], capabilityRequirements: [], lifecycle: {},
          scope: "SPACE_SHARED", schemaSql: "CREATE TABLE records(id TEXT PRIMARY KEY);", migrations },
      ] },
  }, { gatekeeperCapabilities: ["extension.project_canvas"] });
}

function readActionPackage(version: string, migrations: Array<{ version: number; description: string; up: string }> = []) {
  const action = { schemaVersion: 1, id: "listLowStock", name: "List low stock", description: "Read a bounded stock page.",
    operation: "inventory.listLowStock.v1", installationScope: "SPACE_SHARED", dataScope: "SPACE_SHARED", table: "inventory",
    idColumn: "id", quantityColumn: "quantity", versionColumn: "version", permission: "inventory.stock.read", roles: ["owner", "admin"],
    effects: "read_only", idempotency: "none", approval: "none", inputSchema: LIST_LOW_STOCK_INPUT_SCHEMA,
    outputSchema: LIST_LOW_STOCK_OUTPUT_SCHEMA };
  const gadget = { schemaVersion: "1.0", kind: "gadget", id: "inventory", version, scope: "SPACE_SHARED",
    permissions: [{ scope: "SPACE_SHARED", actions: ["read"], resource: action.permission }],
    capabilityRequirements: ["extension.gadget.business_action"], lifecycle: {},
    schemaSql: "CREATE TABLE inventory(id TEXT PRIMARY KEY, quantity INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)",
    migrations, businessActions: [action] };
  return validateExtensionManifest({ id: "ext_update_contract", type: "extension", declaredPermissions: [action.permission],
    capabilityRequirements: ["extension.project_canvas", "extension.gadget.business_action"], gadgets: [], daemons: [], commands: [],
    bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_update_contract", version, primitives: [
      { schemaVersion: "1.0", kind: "canvas", id: "dashboard", version, permissions: [], capabilityRequirements: [], lifecycle: {},
        component: "./dashboard.html", layout: "CanvasMount", dynamicPage: false }, gadget,
    ] },
  }, { gatekeeperCapabilities: ["extension.project_canvas", "extension.gadget.business_action"] });
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

  it("permits only append-only additive migrations for an unchanged Space-shared Gadget", () => {
    const prior = [{ version: 1, description: "create records", up: "CREATE TABLE records(id TEXT PRIMARY KEY);" }];
    const added = { version: 2, description: "add status", up: "ALTER TABLE records ADD COLUMN status TEXT DEFAULT 'open';" };
    const current = gadgetPackage("1.0.0", prior);
    const candidate = gadgetPackage("1.1.0", [...prior, added]);
    expect(supportsVersionOnlySpaceSharedPackageUpdate(current, candidate)).toBe(true);
    expect(spaceSharedGadgetMigrationPlan(current, candidate)).toEqual([{ id: "records", source: "bundle", migrations: [added] }]);
    expect(supportsVersionOnlySpaceSharedCodeUpdate(current, candidate)).toBe(false);

    expect(supportsVersionOnlySpaceSharedPackageUpdate(current, gadgetPackage("1.1.0", [
      { ...prior[0]!, up: "DROP TABLE records;" }, added,
    ]))).toBe(false);
    expect(supportsVersionOnlySpaceSharedPackageUpdate(current, gadgetPackage("1.1.0", [
      prior[0]!, { ...added, up: "ALTER TABLE records DROP COLUMN status;" },
    ]))).toBe(false);
    expect(supportsVersionOnlySpaceSharedPackageUpdate(current, gadgetPackage("1.1.0", prior))).toBe(false);
  });

  it("keeps read-only business actions eligible for a reviewed additive package update", () => {
    expect(supportsVersionOnlySpaceSharedPackageUpdate(readActionPackage("1.0.0"), readActionPackage("1.1.0", [
      { version: 1, description: "add optional inventory label", up: "ALTER TABLE inventory ADD COLUMN label TEXT;" },
    ]))).toBe(true);
  });

  it("permits code rollback only when signed Gadget migrations are an exact prefix and remain applied", () => {
    const first = { version: 1, description: "create records", up: "CREATE TABLE records(id TEXT PRIMARY KEY);" };
    const second = { version: 2, description: "add status", up: "ALTER TABLE records ADD COLUMN status TEXT DEFAULT 'open';" };
    const current = gadgetPackage("1.2.0", [first, second]);
    const candidate = gadgetPackage("1.0.0", [first]);
    expect(supportsVersionOnlySpaceSharedPackageUpdate(current, candidate)).toBe(true);
    expect(spaceSharedGadgetMigrationRetentionPlan(current, candidate)).toEqual([{
      id: "records", source: "bundle", migrations: [{ version: 2, description: "add status" }],
    }]);

    expect(spaceSharedGadgetMigrationRetentionPlan(current, gadgetPackage("1.0.0", [
      first, { ...second, up: "ALTER TABLE records DROP COLUMN status;" },
    ]))).toBeNull();
    expect(spaceSharedGadgetMigrationRetentionPlan(current, gadgetPackage("1.0.0", [
      { ...first, up: "DROP TABLE records;" },
    ]))).toBeNull();
    expect(spaceSharedGadgetMigrationRetentionPlan(gadgetPackage("1.2.0", [first, { ...second, up: "DROP TABLE records;" }]), candidate)).toBeNull();
    expect(spaceSharedGadgetMigrationRetentionPlan(current, gadgetPackage("1.3.0", [first]))).toBeNull();
    const changedSchema = validateExtensionManifest({ ...candidate, bundle: { ...candidate.bundle!, primitives: candidate.bundle!.primitives.map(primitive =>
      primitive.kind === "gadget" ? { ...primitive, schemaSql: "CREATE TABLE records(id TEXT PRIMARY KEY, status TEXT);" } : primitive) } });
    expect(spaceSharedGadgetMigrationRetentionPlan(current, changedSchema)).toBeNull();
    const removedGadget = validateExtensionManifest({ ...candidate, bundle: { ...candidate.bundle!, primitives: candidate.bundle!.primitives.filter(primitive => primitive.kind !== "gadget") } });
    expect(spaceSharedGadgetMigrationRetentionPlan(current, removedGadget)).toBeNull();
  });

  it("allows only additive top-level authority changes when all other package fields stay fixed", () => {
    const current = packageManifest("1.0.0", { channel: true });
    const candidate = validateExtensionManifest({ ...current, channels: undefined, declaredPermissions: ["assistant.phone.simulate"],
      capabilityRequirements: [...current.capabilityRequirements, "assistant.phone.simulate"],
      bundle: { ...current.bundle!, version: "1.1.0", primitives: current.bundle!.primitives.map(primitive => ({ ...primitive, version: "1.1.0" })) },
    }, { gatekeeperCapabilities: ["extension.project_canvas", "assistant.phone.simulate"] });
    expect(supportsVersionOnlySpaceSharedPackageUpdate(current, candidate)).toBe(false);
    expect(supportsOwnerApprovedSpaceSharedAuthorityExpansion(current, candidate)).toBe(true);
    expect(spaceSharedAuthorityExpansion(current, candidate)).toEqual({
      permissions: ["assistant.phone.simulate"], capabilities: ["assistant.phone.simulate"],
    });

    const removed = validateExtensionManifest({ ...candidate, channels: undefined, declaredPermissions: [],
      capabilityRequirements: ["extension.project_canvas"],
      bundle: { ...candidate.bundle!, version: "1.2.0", primitives: candidate.bundle!.primitives.map(primitive => ({ ...primitive, version: "1.2.0" })) },
    }, { gatekeeperCapabilities: ["extension.project_canvas"] });
    expect(spaceSharedAuthorityExpansion(candidate, removed)).toBeNull();

    const changedHandler = validateExtensionManifest({ ...candidate, channels: undefined, bundle: { ...candidate.bundle!, version: "1.2.0",
      primitives: candidate.bundle!.primitives.map(primitive => primitive.kind === "channel"
        ? { ...primitive, version: "1.2.0", handlerScript: "./other.ts" } : { ...primitive, version: "1.2.0" }) },
    }, { gatekeeperCapabilities: ["extension.project_canvas", "assistant.phone.simulate"] });
    expect(spaceSharedAuthorityExpansion(current, changedHandler)).toBeNull();
  });

  it("allows only additive dependency pins in the owner-reviewed package update contract", () => {
    const current = packageManifest("1.0.0", { channel: true });
    const dependency = { extensionId: "ext_calendar", version: "1.2.0", manifestSha256: "a".repeat(64) };
    const candidate = validateExtensionManifest({ ...current, channels: undefined, dependencies: [dependency],
      bundle: { ...current.bundle!, version: "1.1.0", primitives: current.bundle!.primitives.map(primitive => ({ ...primitive, version: "1.1.0" })) } });
    expect(supportsOwnerApprovedSpaceSharedDependencyExpansion(current, candidate)).toBe(true);
    expect(spaceSharedDependencyExpansion(current, candidate)).toEqual([dependency]);
    expect(supportsVersionOnlySpaceSharedPackageUpdate(current, candidate)).toBe(false);

    const replaced = validateExtensionManifest({ ...candidate, channels: undefined, dependencies: [{ ...dependency, version: "1.3.0" }] });
    expect(spaceSharedDependencyExpansion(candidate, replaced)).toBeNull();
    const changedHandler = validateExtensionManifest({ ...candidate, channels: undefined, bundle: { ...candidate.bundle!, version: "1.2.0",
      primitives: candidate.bundle!.primitives.map(primitive => primitive.kind === "channel"
        ? { ...primitive, version: "1.2.0", handlerScript: "./changed.ts" } : { ...primitive, version: "1.2.0" }) } });
    expect(spaceSharedDependencyExpansion(current, changedHandler)).toBeNull();
    expect(spaceSharedDependencyExpansion(candidate, current)).toBeNull();
  });
});
