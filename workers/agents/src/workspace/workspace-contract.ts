/** Versioned internal contract for project workspace operations. */
export const WORKSPACE_CONTRACT_VERSION = 1 as const;

export type WorkspaceConsistencyMode = "checked_handoff" | "live_single_writer";
export type WorkspaceScope = {
  tenantId: string;
  spaceId: string;
  projectId: string;
  jurisdiction: "global" | "eu";
};
export type WorkspaceEntry = {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
  objectKey: string;
  contentType?: string;
};
export type WorkspaceHead = {
  version: 1;
  scope: WorkspaceScope;
  branch: string;
  revision: number;
  manifestHash: string;
  parentRevision: number | null;
  publicationId: string | null;
  updatedAt: string;
};
export type WorkspaceArchiveBranch = {
  head: WorkspaceHead;
  /** The immutable three-way merge base required when this branch is reopened. */
  base: { parentBranch: string; revision: number; manifestHash: string } | null;
};
export type WorkspaceArchiveSnapshot = {
  version: 1;
  scope: WorkspaceScope;
  policyGeneration: number;
  /** Current committed heads only; active sessions, staging and older history are excluded. */
  branches: WorkspaceArchiveBranch[];
};
export type WorkspaceArchiveObjectReference = { key: string; etag: string; size: number };
export type WorkspaceConflict = {
  path: string;
  expectedHash: string | null;
  actualHash: string | null;
};
export type WorkspacePublicationReceipt = {
  id: string;
  idempotencyKey: string;
  status: "published" | "conflicted" | "noop";
  branch: string;
  baseRevision: number;
  revision: number;
  appliedPaths: string[];
  conflicts: WorkspaceConflict[];
  changeSetHash: string;
  fence: number;
  allocationGeneration: number;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const EXCLUDED = new Set([".avos", ".naelao", ".git", "node_modules", ".cache", ".turbo", ".next", ".vite", "coverage", "tmp", ".tmp"]);

export function validateWorkspaceScope(value: unknown): value is WorkspaceScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return typeof scope.tenantId === "string" && ID.test(scope.tenantId) &&
    typeof scope.spaceId === "string" && ID.test(scope.spaceId) &&
    typeof scope.projectId === "string" && ID.test(scope.projectId) &&
    (scope.jurisdiction === "global" || scope.jurisdiction === "eu");
}

export function validateWorkspaceBranch(value: unknown): value is string {
  return typeof value === "string" && BRANCH.test(value) && !value.includes("..") && !value.startsWith("/");
}

export function validateWorkspacePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every((part) => part && part !== "." && part !== ".." && new TextEncoder().encode(part).byteLength <= 255) &&
    !value.split("/").some((part) => EXCLUDED.has(part) || part === ".env" || (part.startsWith(".env.") && part !== ".env.example"));
}

export function validateWorkspaceContentType(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/.test(value);
}

export function validateWorkspaceMode(value: unknown): value is WorkspaceConsistencyMode {
  return value === "checked_handoff" || value === "live_single_writer";
}

export function validateWorkspaceEntry(value: unknown): value is WorkspaceEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return validateWorkspacePath(entry.path) && typeof entry.sha256 === "string" && HASH.test(entry.sha256) &&
    Number.isSafeInteger(entry.size) && Number(entry.size) >= 0 && typeof entry.executable === "boolean" &&
    typeof entry.objectKey === "string" && entry.objectKey.length <= 1024 &&
    (entry.contentType === undefined || validateWorkspaceContentType(entry.contentType));
}

export function canonicalManifest(entries: WorkspaceEntry[]): string {
  return JSON.stringify([...entries].sort((a, b) => a.path.localeCompare(b.path)));
}

export function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}
