import type { GadgetScope } from "@naelao/agent-sdk";

export const MAX_MICRO_APP_ARCHIVE_SNAPSHOT_BYTES = 1024 * 1024;
export const MAX_MICRO_APP_ARCHIVE_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_MICRO_APP_ARCHIVE_TABLE_ROWS = 10_000;
export const MAX_MICRO_APP_ARCHIVE_SNAPSHOTS = 1_000;

export interface MicroAppArchiveOmissions {
  privateScopeInstallations: number;
  unsupportedInstallations: number;
  uninitializedActors: number;
}

export function isMicroAppArchiveOmissions(value: unknown): value is MicroAppArchiveOmissions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 3 && Object.keys(row).every(key =>
    ["privateScopeInstallations", "unsupportedInstallations", "uninitializedActors"].includes(key))
    && Object.values(row).every(count => Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 10_000);
}

export interface MicroAppArchiveSnapshot {
  version: 1;
  createdAt: string;
  scope: {
    tenantId: string;
    spaceId: string;
    projectId: string | null;
    installationId: string;
    extensionId: string;
    releaseVersion: string;
    artifactSha256: string;
    manifestSha256: string;
    appId: string;
    gadgetScope: GadgetScope;
  };
  tables: Array<{ name: string; schemaSha256: string; rows: Array<Record<string, unknown>> }>;
}

const GADGET_SCOPES = new Set<GadgetScope>(["SPACE_SHARED", "PROJECT_BOUND", "PROJECT_SHARED"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;

export function isMicroAppArchiveSnapshot(value: unknown, expected?: { tenantId?: string; spaceId?: string; projectId?: string | null }): value is MicroAppArchiveSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (Object.keys(snapshot).some(key => !["version", "createdAt", "scope", "tables"].includes(key)) || snapshot.version !== 1
    || typeof snapshot.createdAt !== "string" || !Number.isFinite(Date.parse(snapshot.createdAt))
    || !snapshot.scope || typeof snapshot.scope !== "object" || Array.isArray(snapshot.scope) || !Array.isArray(snapshot.tables)
    || snapshot.tables.length > 128) return false;
  const scope = snapshot.scope as Record<string, unknown>;
  if (Object.keys(scope).some(key => !["tenantId", "spaceId", "projectId", "installationId", "extensionId", "releaseVersion",
    "artifactSha256", "manifestSha256", "appId", "gadgetScope"].includes(key))
    || typeof scope.tenantId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(scope.tenantId)
    || typeof scope.spaceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(scope.spaceId)
    || !(scope.projectId === null || typeof scope.projectId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(scope.projectId))
    || typeof scope.installationId !== "string" || !/^[A-Za-z0-9._:-]{1,768}$/.test(scope.installationId)
    || typeof scope.extensionId !== "string" || !/^ext_[a-z][a-z0-9_]{0,59}$/.test(scope.extensionId)
    || typeof scope.releaseVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(scope.releaseVersion)
    || typeof scope.artifactSha256 !== "string" || !HEX_SHA256.test(scope.artifactSha256)
    || typeof scope.manifestSha256 !== "string" || !HEX_SHA256.test(scope.manifestSha256)
    || typeof scope.appId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(scope.appId)
    || !GADGET_SCOPES.has(scope.gadgetScope as GadgetScope)
    || (scope.gadgetScope === "SPACE_SHARED") !== (scope.projectId === null)
    || expected?.tenantId !== undefined && expected.tenantId !== scope.tenantId
    || expected?.spaceId !== undefined && expected.spaceId !== scope.spaceId
    || expected && "projectId" in expected && expected.projectId !== scope.projectId) return false;
  const names = new Set<string>();
  let totalRows = 0;
  for (const tableValue of snapshot.tables as unknown[]) {
    if (!tableValue || typeof tableValue !== "object" || Array.isArray(tableValue)) return false;
    const table = tableValue as Record<string, unknown>;
    if (Object.keys(table).some(key => !["name", "schemaSha256", "rows"].includes(key))
      || typeof table.name !== "string" || !IDENTIFIER.test(table.name) || names.has(table.name)
      || typeof table.schemaSha256 !== "string" || !HEX_SHA256.test(table.schemaSha256)
      || !Array.isArray(table.rows) || table.rows.length > MAX_MICRO_APP_ARCHIVE_TABLE_ROWS) return false;
    names.add(table.name);
    totalRows += table.rows.length;
    if (totalRows > MAX_MICRO_APP_ARCHIVE_TABLE_ROWS) return false;
    for (const rowValue of table.rows as unknown[]) {
      if (!rowValue || typeof rowValue !== "object" || Array.isArray(rowValue)) return false;
      const row = rowValue as Record<string, unknown>;
      if (Object.keys(row).some(key => !IDENTIFIER.test(key)) || Object.values(row).some(item => !isArchivedValue(item))) return false;
    }
  }
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <= MAX_MICRO_APP_ARCHIVE_SNAPSHOT_BYTES;
}

function isArchivedValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return Object.keys(raw).length === 1 && typeof raw.$naelaoArchiveBinary === "string"
    && raw.$naelaoArchiveBinary.length <= 2 * MAX_MICRO_APP_ARCHIVE_SNAPSHOT_BYTES
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.$naelaoArchiveBinary);
}

export function encodeMicroAppArchiveValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $naelaoArchiveBinary: bytesToBase64(value) };
  if (value instanceof ArrayBuffer) return { $naelaoArchiveBinary: bytesToBase64(new Uint8Array(value)) };
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("micro_app_archive_value_unsupported");
}

export function decodeMicroAppArchiveValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).length !== 1 || typeof raw.$naelaoArchiveBinary !== "string") throw new Error("micro_app_archive_value_invalid");
    return Uint8Array.from(atob(raw.$naelaoArchiveBinary), character => character.charCodeAt(0));
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("micro_app_archive_value_invalid");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  return btoa(binary);
}
