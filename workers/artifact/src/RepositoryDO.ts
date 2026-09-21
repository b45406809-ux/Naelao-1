import { DurableObject } from "cloudflare:workers";
import {
  commitBody, encodeGitObject, encodeTree, normalizePath, objectKey, type CommitRecord,
  type RepositoryScope, type TreeEntry, validateMetadata,
} from "./repository.js";

interface RepoState {
  initialized: boolean;
  head: string;
  refs: Record<string, string | null>;
  worktrees: Record<string, Record<string, TreeEntry>>;
  commits: Record<string, CommitRecord>;
  temporary: string[];
}

interface Env { REPOSITORY_OBJECTS: R2Bucket }
const EMPTY: RepoState = { initialized: false, head: "main", refs: {}, worktrees: {}, commits: {}, temporary: [] };

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class RepositoryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

  private async state(): Promise<RepoState> { return (await this.ctx.storage.get<RepoState>("repository")) ?? structuredClone(EMPTY); }
  private async save(state: RepoState): Promise<void> { await this.ctx.storage.put("repository", state); }
  private scope(request: Request): RepositoryScope {
    return JSON.parse(request.headers.get("x-repository-scope") ?? "null") as RepositoryScope;
  }
  private async putObject(scope: RepositoryScope, oid: string, bytes: Uint8Array): Promise<void> {
    const key = objectKey(scope, oid);
    if (!(await this.env.REPOSITORY_OBJECTS.head(key))) await this.env.REPOSITORY_OBJECTS.put(key, bytes, { customMetadata: { oid } });
  }
  private async entrySha256(scope: RepositoryScope, entry: TreeEntry): Promise<string> {
    if (entry.sha256) return entry.sha256;
    const object = await this.env.REPOSITORY_OBJECTS.get(objectKey(scope, entry.oid));
    if (!object) throw new Error("Object missing");
    const envelope = new Uint8Array(await object.arrayBuffer());
    const separator = envelope.indexOf(0);
    if (separator < 0) throw new Error("Invalid Git object envelope");
    entry.sha256 = await sha256(envelope.slice(separator + 1));
    return entry.sha256;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const scope = this.scope(request);
      const url = new URL(request.url);
      const op = url.pathname.replace(/^\/+/, "");
      const state = await this.state();
      const body = request.method === "GET" ? {} : await request.json<Record<string, unknown>>().catch(() => ({}));
      if (op === "init" && request.method === "POST") {
        if (!state.initialized) { state.initialized = true; state.refs.main = null; state.worktrees.main = {}; await this.save(state); }
        return Response.json({ initialized: true, branch: state.head, commit_id: state.refs[state.head] });
      }
      if (!state.initialized) return jsonError("Repository not initialized", 409);
      const branch = String(body.branch ?? url.searchParams.get("branch") ?? state.head);
      if (!(branch in state.refs)) return jsonError("Branch not found", 404);

      if (op === "tree" && request.method === "GET") {
        const at = url.searchParams.get("at");
        const entries = at ? state.commits[at]?.entries : state.worktrees[branch];
        if (!entries) return jsonError("Commit not found", 404);
        const prefix = (url.searchParams.get("path") ?? "").replace(/^\/+|\/+$/g, "");
        const data = Object.values(entries).filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`));
        return Response.json({ data, commit_id: at ?? state.refs[branch] });
      }
      if (op === "file" && request.method === "GET") {
        const path = normalizePath(url.searchParams.get("path") ?? "");
        const at = url.searchParams.get("at");
        const entry = (at ? state.commits[at]?.entries : state.worktrees[branch])?.[path];
        if (!entry) return jsonError("File not found", 404);
        const object = await this.env.REPOSITORY_OBJECTS.get(objectKey(scope, entry.oid));
        if (!object) return jsonError("Object missing", 500);
        const envelope = new Uint8Array(await object.arrayBuffer());
        const separator = envelope.indexOf(0);
        return new Response(envelope.slice(separator + 1), { headers: { "content-type": "application/octet-stream", "x-git-oid": entry.oid } });
      }
      if (op === "write" && request.method === "PUT") {
        const path = normalizePath(String(body.path ?? ""));
        const bytes = typeof body.content_base64 === "string"
          ? Uint8Array.from(atob(body.content_base64), (char) => char.charCodeAt(0))
          : new TextEncoder().encode(String(body.content ?? ""));
        const current = state.worktrees[branch]![path];
        if (current) {
          const currentSha256 = await this.entrySha256(scope, current);
          if (typeof body.base_sha256 !== "string") return Response.json({ error_code: "base_sha256_required", path, current_sha256: currentSha256 }, { status: 428 });
          if (body.base_sha256 !== currentSha256) return Response.json({ error_code: "cas_conflict", path, expected_sha256: body.base_sha256, current_sha256: currentSha256, branch_head: state.refs[branch] }, { status: 409 });
        }
        const contentSha256 = await sha256(bytes);
        const blob = await encodeGitObject("blob", bytes);
        await this.putObject(scope, blob.oid, blob.bytes);
        state.worktrees[branch]![path] = { path, oid: blob.oid, size: bytes.byteLength, sha256: contentSha256 };
        await this.save(state);
        return Response.json({ path, oid: blob.oid, sha256: contentSha256, size: bytes.byteLength });
      }
      if (op === "file" && request.method === "DELETE") {
        const path = normalizePath(String(body.path ?? ""));
        const current = state.worktrees[branch]![path];
        if (!current) return jsonError("File not found", 404);
        const currentSha256 = await this.entrySha256(scope, current);
        if (typeof body.base_sha256 !== "string") return Response.json({ error_code: "base_sha256_required", path, current_sha256: currentSha256 }, { status: 428 });
        if (body.base_sha256 !== currentSha256) return Response.json({ error_code: "cas_conflict", path, expected_sha256: body.base_sha256, current_sha256: currentSha256, branch_head: state.refs[branch] }, { status: 409 });
        delete state.worktrees[branch]![path];
        await this.save(state);
        return Response.json({ deleted: true, path, deleted_sha256: current.sha256 });
      }
      if (op === "commit" && request.method === "POST") {
        const expected = body.expected_head;
        if (expected !== undefined && expected !== state.refs[branch]) return jsonError("Head changed", 409);
        const metadata = validateMetadata(body.metadata);
        const tree = await encodeTree(state.worktrees[branch]!);
        await this.putObject(scope, tree.oid, tree.bytes);
        const timestamp = new Date().toISOString();
        const message = String(body.message ?? metadata.rationale).slice(0, 10_000);
        const parent = state.refs[branch] ?? undefined;
        const encoded = await encodeGitObject("commit", commitBody(tree.oid, parent, message, metadata, timestamp));
        await this.putObject(scope, encoded.oid, encoded.bytes);
        state.commits[encoded.oid] = { oid: encoded.oid, tree: tree.oid, ...(parent ? { parent } : {}), message, metadata, createdAt: timestamp, entries: structuredClone(state.worktrees[branch]!) };
        state.refs[branch] = encoded.oid;
        await this.save(state);
        return Response.json({ commit_id: encoded.oid, tree_id: tree.oid, parent, metadata }, { status: 201 });
      }
      if (op === "branch" && request.method === "POST") {
        const name = String(body.name ?? "");
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(name) || name.includes("..")) return jsonError("Invalid branch name");
        if (name in state.refs) return jsonError("Branch exists", 409);
        const from = String(body.from ?? state.refs[branch] ?? "");
        if (from && !state.commits[from]) return jsonError("Commit not found", 404);
        state.refs[name] = from || null;
        state.worktrees[name] = from ? structuredClone(state.commits[from]!.entries) : {};
        if (body.temporary === true) state.temporary.push(name);
        await this.save(state);
        return Response.json({ branch: name, commit_id: state.refs[name], copy_on_write: true }, { status: 201 });
      }
      if (op === "checkout" && request.method === "POST") {
        state.head = branch; await this.save(state);
        return Response.json({ branch, commit_id: state.refs[branch] });
      }
      if (op === "diff" && request.method === "GET") {
        const from = url.searchParams.get("from"); const to = url.searchParams.get("to");
        const a = from ? state.commits[from]?.entries : {}; const b = to ? state.commits[to]?.entries : state.worktrees[branch];
        if (!a || !b) return jsonError("Commit not found", 404);
        const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
        return Response.json({ data: paths.filter((p) => a[p]?.oid !== b[p]?.oid).map((path) => ({ path, status: !a[path] ? "added" : !b[path] ? "deleted" : "modified", before: a[path]?.oid, after: b[path]?.oid })) });
      }
      if (op === "rollback" && request.method === "POST") {
        const commit = state.commits[String(body.commit_id ?? "")];
        if (!commit) return jsonError("Commit not found", 404);
        state.worktrees[branch] = structuredClone(commit.entries); state.refs[branch] = commit.oid;
        await this.save(state);
        return Response.json({ branch, commit_id: commit.oid });
      }
      if (op === "cleanup" && request.method === "POST") {
        const names = body.branch ? [String(body.branch)] : [...state.temporary];
        for (const name of names) { if (state.temporary.includes(name) && name !== state.head) { delete state.refs[name]; delete state.worktrees[name]; state.temporary = state.temporary.filter((v) => v !== name); } }
        await this.save(state); return Response.json({ deleted: names.filter((n) => !(n in state.refs)) });
      }
      return jsonError("Route not found", 404);
    } catch (error) { return jsonError(error instanceof Error ? error.message : "Invalid request"); }
  }
}
