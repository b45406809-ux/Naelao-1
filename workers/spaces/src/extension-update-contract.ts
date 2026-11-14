import type { ExtensionManifest } from "@naelao/agent-sdk";
import { SPACE_SHARED_PACKAGE_CAPABILITIES, SPACE_SHARED_PACKAGE_PERMISSIONS } from "./shared-extension-package-policy.js";

function isVersionOnlyManifestChange(current: ExtensionManifest, candidate: ExtensionManifest): boolean {
  if (current.id !== candidate.id || !current.bundle || !candidate.bundle
    || current.bundle.version === candidate.bundle.version) return false;
  const normalize = (manifest: ExtensionManifest): string => {
    const copy = JSON.parse(JSON.stringify(manifest)) as ExtensionManifest;
    if (!copy.bundle) return "";
    copy.bundle.version = "__release_version__";
    for (const primitive of copy.bundle.primitives) primitive.version = "__release_version__";
    // validateExtensionManifest derives this compatibility view from bundle primitives.
    for (const channel of copy.channels ?? []) channel.version = "__release_version__";
    return JSON.stringify(copy);
  };
  return normalize(current) === normalize(candidate);
}

function normalizeGadgetMigrationLists(manifest: ExtensionManifest): string {
  const copy = JSON.parse(JSON.stringify(manifest)) as ExtensionManifest;
  if (!copy.bundle) return "";
  copy.bundle.version = "__release_version__";
  for (const primitive of copy.bundle.primitives) {
    primitive.version = "__release_version__";
    if (primitive.kind === "gadget") primitive.migrations = [];
    if (primitive.kind === "channel") primitive.version = "__release_version__";
  }
  for (const gadget of copy.gadgets ?? []) gadget.migrations = [];
  for (const channel of copy.channels ?? []) channel.version = "__release_version__";
  return JSON.stringify(copy);
}

function additiveMigrationStatements(sql: string): boolean {
  if (!sql || sql.length > 64_000 || /\b(?:ATTACH|DETACH|PRAGMA|VACUUM|DROP|RENAME|TRIGGER|VIEW)\b/i.test(sql)) return false;
  const statements = sql.split(";").map(part => part.trim()).filter(Boolean);
  return statements.length > 0 && statements.every(statement =>
    /^CREATE\s+(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-zA-Z_]/i.test(statement)
    || /^ALTER\s+TABLE\s+[a-zA-Z_][\w]*\s+ADD\s+COLUMN\s+[a-zA-Z_][\w]*\s+(?:TEXT|INTEGER|REAL|BLOB)(?:\s+NOT\s+NULL)?(?:\s+DEFAULT\s+(?:NULL|-?\d+(?:\.\d+)?|'[^']{0,256}'))?$/i.test(statement));
}

export interface SpaceSharedGadgetMigrationPlanEntry {
  id: string;
  source: "bundle";
  migrations: Array<{ version: number; description: string; up: string }>;
}

/** Only allow append-only, additive SQL migrations on already-installed modular Space gadgets.
 * Gadget identity, scope, default schema, owner settings and every other manifest field remain
 * unchanged; MicroAppDO repeats the DDL validation before applying each migration. */
export function spaceSharedGadgetMigrationPlan(current: ExtensionManifest, candidate: ExtensionManifest): SpaceSharedGadgetMigrationPlanEntry[] | null {
  const currentPrimitives = current.bundle?.primitives ?? [];
  const candidatePrimitives = candidate.bundle?.primitives ?? [];
  const before = new Map(currentPrimitives.filter((part): part is Extract<typeof part, { kind: "gadget" }> => part.kind === "gadget")
    .map(gadget => [gadget.id, gadget]));
  const after = new Map(candidatePrimitives.filter((part): part is Extract<typeof part, { kind: "gadget" }> => part.kind === "gadget")
    .map(gadget => [gadget.id, gadget]));
  if (!before.size || before.size !== after.size || [...before.keys()].some(id => !after.has(id))) return null;

  // Legacy declarations use the same actor namespace. Reject mixed duplicate IDs so the update
  // cannot ambiguously target one actor through two schema declarations.
  const legacyIds = new Set((current.gadgets ?? []).filter(gadget => gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3).map(gadget => gadget.id));
  if ([...before.keys()].some(id => legacyIds.has(id)) || legacyIds.size !== (candidate.gadgets ?? [])
    .filter(gadget => gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3).length
    || [...legacyIds].some(id => !(candidate.gadgets ?? []).some(gadget => gadget.id === id && gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3))) return null;
  if (JSON.stringify((current.gadgets ?? []).map(gadget => gadget.migrations ?? []))
    !== JSON.stringify((candidate.gadgets ?? []).map(gadget => gadget.migrations ?? []))) return null;

  const plan: SpaceSharedGadgetMigrationPlanEntry[] = [];
  for (const [id, next] of after) {
    const prior = before.get(id)!;
    const oldMigrations = prior.migrations ?? [], nextMigrations = next.migrations ?? [];
    if (nextMigrations.length <= oldMigrations.length
      || JSON.stringify(nextMigrations.slice(0, oldMigrations.length)) !== JSON.stringify(oldMigrations)) return null;
    const appended = nextMigrations.slice(oldMigrations.length).map(migration => ({
      version: migration.version, description: migration.description, up: migration.up,
    }));
    if (!appended.every(migration => additiveMigrationStatements(migration.up))) return null;
    plan.push({ id, source: "bundle", migrations: appended });
  }
  const totalBytes = plan.reduce((sum, gadget) => sum + gadget.migrations.reduce((nested, migration) => nested
    + new TextEncoder().encode(JSON.stringify(migration)).byteLength, 0), 0);
  const migrationCount = plan.reduce((sum, gadget) => sum + gadget.migrations.length, 0);
  if (!plan.length || migrationCount > 32 || totalBytes > 128_000
    || normalizeGadgetMigrationLists(current) !== normalizeGadgetMigrationLists(candidate)) return null;
  return plan.sort((left, right) => left.id.localeCompare(right.id));
}

function isCodeOnlySpaceSharedPackage(manifest: ExtensionManifest): boolean {
  const bundle = manifest.bundle;
  if (!bundle || !bundle.primitives.length
    || manifest.declaredPermissions.some(permission => !SPACE_SHARED_PACKAGE_PERMISSIONS.has(permission))
    || manifest.capabilityRequirements.some(capability => !SPACE_SHARED_PACKAGE_CAPABILITIES.has(capability))
    || (manifest.gadgets?.length ?? 0) > 0 || (manifest.daemons?.length ?? 0) > 0
    || (manifest.commands?.length ?? 0) > 0 || (manifest.containers?.length ?? 0) > 0
    || (manifest.widgetSubscriptions?.length ?? 0) > 0
    || (manifest.dependencies?.length ?? 0) > 0 || (manifest.shared_filesystem?.length ?? 0) > 0
    || manifest.settingsSchema || (bundle.workerRoles?.length ?? 0) > 0) return false;

  return bundle.primitives.every(part => {
    if (part.version !== bundle.version) return false;
    if (part.kind === "canvas") {
      return part.layout === "CanvasMount" && part.dynamicPage === false
        && part.permissions.length === 0 && part.capabilityRequirements.length === 0;
    }
    if (part.kind === "channel") {
      return part.context === "channel_only" && /^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(part.handlerScript);
    }
    // Gadget schema and migration changes need their own preview and recovery path.
    return false;
  });
}

/** Permit owner-reviewed artifact code updates only when authority and all declared package
 * configuration remain byte-for-byte stable apart from the signed release version. */
export function supportsVersionOnlySpaceSharedCodeUpdate(current: ExtensionManifest, candidate: ExtensionManifest): boolean {
  return isCodeOnlySpaceSharedPackage(current) && isCodeOnlySpaceSharedPackage(candidate)
    && isVersionOnlyManifestChange(current, candidate);
}

/** Static Canvas/channel releases retain the existing behavior. A package with Space-shared
 * Gadgets may additionally append owner-reviewed additive SQL migrations without changing any
 * other configuration or authority. */
export function supportsVersionOnlySpaceSharedPackageUpdate(current: ExtensionManifest, candidate: ExtensionManifest): boolean {
  return supportsVersionOnlySpaceSharedCodeUpdate(current, candidate)
    || (spaceSharedGadgetMigrationPlan(current, candidate) !== null
      && isSpaceSharedPackageShape(current) && isSpaceSharedPackageShape(candidate));
}

function isSpaceSharedPackageShape(manifest: ExtensionManifest): boolean {
  const bundle = manifest.bundle;
  if (!bundle || !bundle.primitives.some(part => part.kind === "canvas")
    || manifest.declaredPermissions.some(permission => !SPACE_SHARED_PACKAGE_PERMISSIONS.has(permission))
    || manifest.capabilityRequirements.some(capability => !SPACE_SHARED_PACKAGE_CAPABILITIES.has(capability))
    || (manifest.daemons?.length ?? 0) > 0 || (manifest.commands?.length ?? 0) > 0
    || (manifest.containers?.length ?? 0) > 0 || (manifest.widgetSubscriptions?.length ?? 0) > 0
    || (manifest.dependencies?.length ?? 0) > 0 || (manifest.shared_filesystem?.length ?? 0) > 0
    || manifest.settingsSchema || (bundle.workerRoles?.length ?? 0) > 0) return false;
  return bundle.primitives.every(part => {
    if (part.version !== bundle.version) return false;
    if (part.kind === "canvas") return part.layout === "CanvasMount" && part.dynamicPage === false
      && part.permissions.length === 0 && part.capabilityRequirements.length === 0;
    if (part.kind === "channel") return part.context === "channel_only"
      && /^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(part.handlerScript);
    return part.kind === "gadget" && part.scope === "SPACE_SHARED"
      && part.permissions.length === 0 && part.capabilityRequirements.length === 0;
  }) && (manifest.gadgets ?? []).every(gadget => gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3);
}
