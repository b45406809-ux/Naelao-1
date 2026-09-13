/** A small, Git-compatible object encoder and repository metadata model.
 *
 * Object ids are SHA-1 hashes of the canonical `type size\0body` Git envelope. The
 * implementation is deliberately WebCrypto-only so it runs in a Worker/WASM isolate without
 * Node polyfills. R2 stores these immutable envelopes while the repository Durable Object owns
 * mutable refs, worktrees and commit metadata.
 */

export interface RepositoryScope {
  tenantId: string;
  spaceId: string;
  projectId: string;
}

export interface CommitMetadata {
  agent_role: string;
  user_goal: string;
  task_id: string;
  rationale: string;
  thread_id: string;
  tool_turn_id: string;
}

export interface TreeEntry {
  path: string;
  oid: string;
  size: number;
}

export interface CommitRecord {
  oid: string;
  tree: string;
  parent?: string;
  message: string;
  metadata: CommitMetadata;
  createdAt: string;
  entries: Record<string, TreeEntry>;
}

const encoder = new TextEncoder();

export function assertSegment(value: string | undefined, name: string): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function normalizePath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!path || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid repository path");
  }
  return path;
}

export function repositoryName(scope: RepositoryScope): string {
  return `${assertSegment(scope.tenantId, "tenant")}:${assertSegment(scope.spaceId, "space")}:${assertSegment(scope.projectId, "project")}`;
}

export function objectKey(scope: RepositoryScope, oid: string): string {
  if (!/^[a-f0-9]{40}$/.test(oid)) throw new Error("Invalid object id");
  return `repositories/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function encodeGitObject(type: "blob" | "tree" | "commit", body: Uint8Array): Promise<{ oid: string; bytes: Uint8Array }> {
  const header = encoder.encode(`${type} ${body.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + body.byteLength);
  bytes.set(header);
  bytes.set(body, header.byteLength);
  return { oid: hex(await crypto.subtle.digest("SHA-1", bytes)), bytes };
}

export async function encodeTree(entries: Record<string, TreeEntry>): Promise<{ oid: string; bytes: Uint8Array }> {
  // A deterministic flat manifest is used as the tree body. Blob and commit envelopes are fully
  // Git compatible; this manifest retains full paths so metadata-only listings need no R2 reads.
  const body = encoder.encode(Object.values(entries).sort((a, b) => a.path.localeCompare(b.path)).map((e) => `100644 ${e.path}\t${e.oid}\n`).join(""));
  return encodeGitObject("tree", body);
}

export function validateMetadata(value: unknown): CommitMetadata {
  if (!value || typeof value !== "object") throw new Error("metadata is required");
  const input = value as Record<string, unknown>;
  const keys: Array<keyof CommitMetadata> = ["agent_role", "user_goal", "task_id", "rationale", "thread_id", "tool_turn_id"];
  const result = {} as CommitMetadata;
  for (const key of keys) {
    if (typeof input[key] !== "string" || !(input[key] as string).trim()) throw new Error(`metadata.${key} is required`);
    result[key] = (input[key] as string).slice(0, key === "user_goal" || key === "rationale" ? 10_000 : 512);
  }
  return result;
}

export function commitBody(tree: string, parent: string | undefined, message: string, metadata: CommitMetadata, timestamp: string): Uint8Array {
  const lines = [`tree ${tree}`];
  if (parent) lines.push(`parent ${parent}`);
  lines.push(`author Naelao Agent <agent@naelao.ai> ${Math.floor(new Date(timestamp).getTime() / 1000)} +0000`);
  lines.push(`committer Naelao Agent <agent@naelao.ai> ${Math.floor(new Date(timestamp).getTime() / 1000)} +0000`);
  lines.push("", message, "", `naelao-metadata ${JSON.stringify(metadata)}`);
  return encoder.encode(`${lines.join("\n")}\n`);
}

