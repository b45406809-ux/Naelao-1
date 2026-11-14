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

export interface SpaceSharedGadgetMigrationRetentionPlanEntry {
  id: string;
  source: "bundle";
  migrations: Array<{ version: number; description: string }>;
}

export function isSpaceSharedGadgetMigrationRetentionPlan(value: unknown): value is SpaceSharedGadgetMigrationRetentionPlanEntry[] {
  if (!Array.isArray(value) || value.length > 32) return false;
  let totalMigrations = 0;
  let priorId = "";
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "id,migrations,source"
      || typeof entry.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(entry.id)
      || entry.id <= priorId || entry.source !== "bundle" || !Array.isArray(entry.migrations)
      || entry.migrations.length < 1 || entry.migrations.length > 32) return false;
    priorId = entry.id;
    let priorVersion = 0;
    for (const migration of entry.migrations) {
      if (!migration || typeof migration !== "object" || Array.isArray(migration)
        || Object.keys(migration).sort().join(",") !== "description,version"
        || !Number.isSafeInteger(migration.version) || migration.version <= priorVersion
        || typeof migration.description !== "string" || migration.description.length > 256
        || /[\u0000-\u001f\u007f]/.test(migration.description)) return false;
      priorVersion = migration.version;
      totalMigrations++;
      if (totalMigrations > 32) return false;
    }
  }
  return true;
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

/** Identify an older signed release whose Gadget migrations are an exact prefix of the current
 * release. The caller may roll back package code while retaining all additive schema/data in place;
 * this helper never authorizes destructive DDL. */
export function spaceSharedGadgetMigrationRetentionPlan(
  current: ExtensionManifest,
  candidate: ExtensionManifest,
): SpaceSharedGadgetMigrationRetentionPlanEntry[] | null {
  const currentVersion = current.bundle?.version, candidateVersion = candidate.bundle?.version;
  if (!currentVersion || !candidateVersion || currentVersion === candidateVersion
    || !isSpaceSharedPackageShape(current) || !isSpaceSharedPackageShape(candidate)) return null;
  const compareSemver = (left: string, right: string) => {
    const parse = (value: string) => {
      const [core, prerelease] = value.split("-", 2);
      return { core: core!.split(".").map(Number), prerelease: prerelease?.split(".") ?? null };
    };
    const a = parse(left), b = parse(right);
    for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index]! < b.core[index]! ? -1 : 1;
    if (!a.prerelease || !b.prerelease) return a.prerelease === b.prerelease ? 0 : a.prerelease ? -1 : 1;
    for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
      const av = a.prerelease[index], bv = b.prerelease[index];
      if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
      if (av === bv) continue;
      const an = /^\d+$/.test(av), bn = /^\d+$/.test(bv);
      if (an && bn) return Number(av) < Number(bv) ? -1 : 1;
      if (an !== bn) return an ? -1 : 1;
      return av < bv ? -1 : 1;
    }
    return 0;
  };
  if (compareSemver(candidateVersion, currentVersion) >= 0) return null;

  const currentPrimitives = current.bundle?.primitives ?? [], candidatePrimitives = candidate.bundle?.primitives ?? [];
  const before = new Map(currentPrimitives.filter((part): part is Extract<typeof part, { kind: "gadget" }> => part.kind === "gadget")
    .map(gadget => [gadget.id, gadget]));
  const after = new Map(candidatePrimitives.filter((part): part is Extract<typeof part, { kind: "gadget" }> => part.kind === "gadget")
    .map(gadget => [gadget.id, gadget]));
  if (!before.size || before.size !== after.size || [...before.keys()].some(id => !after.has(id))) return null;
  if (JSON.stringify((current.gadgets ?? []).map(gadget => gadget.migrations ?? []))
    !== JSON.stringify((candidate.gadgets ?? []).map(gadget => gadget.migrations ?? []))) return null;

  const plan: SpaceSharedGadgetMigrationRetentionPlanEntry[] = [];
  for (const [id, currentGadget] of before) {
    const candidateGadget = after.get(id)!;
    const currentMigrations = currentGadget.migrations ?? [], candidateMigrations = candidateGadget.migrations ?? [];
    if (candidateMigrations.length > currentMigrations.length
      || JSON.stringify(currentMigrations.slice(0, candidateMigrations.length)) !== JSON.stringify(candidateMigrations)
      || !currentMigrations.every(migration => additiveMigrationStatements(migration.up))) return null;
    const retained = currentMigrations.slice(candidateMigrations.length);
    if (!retained.every(migration => additiveMigrationStatements(migration.up))) return null;
    if (retained.length) plan.push({ id, source: "bundle", migrations: retained.map(({ version, description }) => ({ version, description })) });
  }
  const totalMigrations = plan.reduce((sum, entry) => sum + entry.migrations.length, 0);
  if (!plan.length || totalMigrations > 32 || !isSpaceSharedGadgetMigrationRetentionPlan(plan)
    || normalizeGadgetMigrationLists(current) !== normalizeGadgetMigrationLists(candidate)) return null;
  return plan.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
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
      && isSpaceSharedPackageShape(current) && isSpaceSharedPackageShape(candidate))
    || spaceSharedGadgetMigrationRetentionPlan(current, candidate) !== null;
}

export interface SpaceSharedAuthorityExpansion {
  permissions: string[];
  capabilities: string[];
}

/** Return the exact additive top-level authority delta when every other signed package field is
 * unchanged apart from release versions and, optionally, validated additive Gadget migrations.
 * Permission removals, provider connections, dependencies, shared-drive access, and primitive-level
 * authority changes require a different review contract and remain unsupported here. */
export function spaceSharedAuthorityExpansion(
  current: ExtensionManifest,
  candidate: ExtensionManifest,
): SpaceSharedAuthorityExpansion | null {
  if (!isSpaceSharedPackageShape(current) || !isSpaceSharedPackageShape(candidate)
    || current.id !== candidate.id || !current.bundle || !candidate.bundle
    || current.bundle.version === candidate.bundle.version) return null;

  const added = (before: string[], after: string[]) => [...new Set(after)].filter(value => !before.includes(value)).sort();
  const removed = (before: string[], after: string[]) => [...new Set(before)].filter(value => !after.includes(value)).sort();
  const permissions = added(current.declaredPermissions, candidate.declaredPermissions);
  const capabilities = added(current.capabilityRequirements, candidate.capabilityRequirements);
  if ((!permissions.length && !capabilities.length)
    || removed(current.declaredPermissions, candidate.declaredPermissions).length
    || removed(current.capabilityRequirements, candidate.capabilityRequirements).length) return null;

  const normalize = (manifest: ExtensionManifest, ignoreMigrations: boolean): string => {
    const copy = JSON.parse(JSON.stringify(manifest)) as ExtensionManifest;
    if (!copy.bundle) return "";
    copy.bundle.version = "__release_version__";
    for (const primitive of copy.bundle.primitives) {
      primitive.version = "__release_version__";
      if (ignoreMigrations && primitive.kind === "gadget") primitive.migrations = [];
    }
    for (const channel of copy.channels ?? []) channel.version = "__release_version__";
    copy.declaredPermissions = ["__owner_reviewed_authority__"];
    copy.capabilityRequirements = ["__owner_reviewed_authority__"];
    if (ignoreMigrations) for (const gadget of copy.gadgets ?? []) gadget.migrations = [];
    return JSON.stringify(copy);
  };

  const sameExceptAuthorityAndRelease = normalize(current, false) === normalize(candidate, false);
  const migrationPlan = spaceSharedGadgetMigrationPlan(current, candidate);
  const sameExceptAuthorityReleaseAndAdditiveMigrations = migrationPlan !== null
    && normalize(current, true) === normalize(candidate, true);
  if (!sameExceptAuthorityAndRelease && !sameExceptAuthorityReleaseAndAdditiveMigrations) return null;
  return { permissions, capabilities };
}

/** Accept only the separately reviewed additive authority shape for Space-shared updates. */
export function supportsOwnerApprovedSpaceSharedAuthorityExpansion(
  current: ExtensionManifest,
  candidate: ExtensionManifest,
): boolean {
  return spaceSharedAuthorityExpansion(current, candidate) !== null;
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
