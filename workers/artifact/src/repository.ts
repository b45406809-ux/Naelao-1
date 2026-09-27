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
  /** First parent is `parent`; additional parents are present for merge commits. */
  parents?: string[];
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
  const parts = path.split("/");
  if (
    !path ||
    path.includes("\0") ||
    parts.some((part) => !part || part === "." || part === "..") ||
    parts[0] === ".avos"
  ) {
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
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function encodeGitObject(
  type: "blob" | "tree" | "commit" | "tag",
  body: Uint8Array
): Promise<{ oid: string; bytes: Uint8Array }> {
  const header = encoder.encode(`${type} ${body.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + body.byteLength);
  bytes.set(header);
  bytes.set(body, header.byteLength);
  return { oid: hex(await crypto.subtle.digest("SHA-1", bytes)), bytes };
}

export async function encodeTree(
  entries: Record<string, TreeEntry>
): Promise<{ oid: string; bytes: Uint8Array }> {
  // A deterministic flat manifest is used as the tree body. Blob and commit envelopes are fully
  // Git compatible; this manifest retains full paths so metadata-only listings need no R2 reads.
  const body = encoder.encode(
    Object.values(entries)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((e) => `100644 ${e.path}\t${e.oid}\n`)
      .join("")
  );
  return encodeGitObject("tree", body);
}

/** Encode a real hierarchy of canonical Git tree objects (raw 20-byte child OIDs). */
export async function encodeTreeHierarchy(entries: Record<string, TreeEntry>): Promise<{
  root: { oid: string; bytes: Uint8Array };
  objects: Array<{ oid: string; bytes: Uint8Array }>;
}> {
  type Node = { files: Map<string, TreeEntry>; dirs: Map<string, Node> };
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const entry of Object.values(entries)) {
    const parts = entry.path.split("/");
    const name = parts.pop()!;
    let node = root;
    for (const part of parts) {
      let child = node.dirs.get(part);
      if (!child) { child = { files: new Map(), dirs: new Map() }; node.dirs.set(part, child); }
      node = child;
    }
    node.files.set(name, entry);
  }
  const objects: Array<{ oid: string; bytes: Uint8Array }> = [];
  const rawOid = (oid: string) => Uint8Array.from(oid.match(/../g)!, (byte) => Number.parseInt(byte, 16));
  const encodeNode = async (node: Node): Promise<{ oid: string; bytes: Uint8Array }> => {
    const records: Array<{ name: string; bytes: Uint8Array }> = [];
    for (const [name, child] of node.dirs) {
      const tree = await encodeNode(child);
      const prefix = encoder.encode(`40000 ${name}\0`);
      const bytes = new Uint8Array(prefix.length + 20); bytes.set(prefix); bytes.set(rawOid(tree.oid), prefix.length);
      records.push({ name: `${name}/`, bytes });
    }
    for (const [name, file] of node.files) {
      const prefix = encoder.encode(`100644 ${name}\0`);
      const bytes = new Uint8Array(prefix.length + 20); bytes.set(prefix); bytes.set(rawOid(file.oid), prefix.length);
      records.push({ name, bytes });
    }
    records.sort((a, b) => a.name.localeCompare(b.name));
    const length = records.reduce((sum, item) => sum + item.bytes.length, 0);
    const body = new Uint8Array(length); let offset = 0;
    for (const record of records) { body.set(record.bytes, offset); offset += record.bytes.length; }
    const encoded = await encodeGitObject("tree", body); objects.push(encoded); return encoded;
  };
  const encodedRoot = await encodeNode(root);
  return { root: encodedRoot, objects };
}

/** Parse the canonical metadata trailer emitted by {@link commitBody}. */
export function parseCommitMetadata(message: string): CommitMetadata | null {
  const marker = "--AVOS-METADATA--";
  const start = message.lastIndexOf(marker);
  if (start < 0) return null;
  const values: Record<string, string> = {};
  for (const line of message.slice(start + marker.length).trim().split("\n")) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value) as string; } catch { return null; }
    }
    values[match[1]!] = value;
  }
  try {
    return validateMetadata({
      agent_role: values["author"], user_goal: values["goal"],
      rationale: values["rationale"], task_id: values["task_id"],
      thread_id: values["thread_id"], tool_turn_id: values["tool_turn_id"],
    });
  } catch { return null; }
}

function yamlString(value: string): string {
  // JSON strings are valid YAML scalars and avoid newline/colon injection into the trailer.
  return JSON.stringify(value);
}

export function metadataTrailer(metadata: CommitMetadata): string {
  return [
    "--AVOS-METADATA--",
    `author: ${yamlString(metadata.agent_role)}`,
    `goal: ${yamlString(metadata.user_goal)}`,
    `rationale: ${yamlString(metadata.rationale)}`,
    `task_id: ${yamlString(metadata.task_id)}`,
    `thread_id: ${yamlString(metadata.thread_id)}`,
    `tool_turn_id: ${yamlString(metadata.tool_turn_id)}`,
  ].join("\n");
}

export function validateMetadata(value: unknown): CommitMetadata {
  if (!value || typeof value !== "object")
    throw new Error("metadata is required");
  const input = value as Record<string, unknown>;
  const keys: Array<keyof CommitMetadata> = [
    "agent_role",
    "user_goal",
    "task_id",
    "rationale",
    "thread_id",
    "tool_turn_id",
  ];
  const result = {} as CommitMetadata;
  for (const key of keys) {
    if (typeof input[key] !== "string" || !(input[key] as string).trim())
      throw new Error(`metadata.${key} is required`);
    result[key] = (input[key] as string).slice(
      0,
      key === "user_goal" || key === "rationale" ? 10_000 : 512
    );
  }
  return result;
}

export function commitBody(
  tree: string,
  parent: string | string[] | undefined,
  message: string,
  metadata: CommitMetadata,
  timestamp: string
): Uint8Array {
  const lines = [`tree ${tree}`];
  for (const oid of Array.isArray(parent) ? parent : parent ? [parent] : []) lines.push(`parent ${oid}`);
  lines.push(
    `author Naelao Agent <agent@naelao.ai> ${Math.floor(new Date(timestamp).getTime() / 1000)} +0000`
  );
  lines.push(
    `committer Naelao Agent <agent@naelao.ai> ${Math.floor(new Date(timestamp).getTime() / 1000)} +0000`
  );
  lines.push("", message, "", metadataTrailer(metadata));
  return encoder.encode(`${lines.join("\n")}\n`);
}
