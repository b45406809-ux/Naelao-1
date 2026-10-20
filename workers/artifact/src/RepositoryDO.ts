import { DurableObject } from "cloudflare:workers";
import { readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";
import {
  type CommitRecord,
  type RepositoryScope,
  type TreeEntry,
  commitBody,
  encodeGitObject,
  encodeTreeHierarchy,
  normalizePath,
  objectKey,
  sha256,
  validateMetadata,
} from "./repository.js";

interface RepoState {
  initialized: boolean;
  head: string;
  refs: Record<string, string | null>;
  worktrees: Record<string, Record<string, TreeEntry>>;
  commits: Record<string, CommitRecord>;
  tags?: Record<string, { oid: string; target: string }>;
  temporary: string[];
}

type Entries = Record<string, TreeEntry>;

interface Env {
  REPOSITORY_OBJECTS: R2Bucket;
  /** Canonical mutable workspace files; Git refs/objects are a materialized projection. */
  WORKSPACE_R2?: R2Bucket;
}
const EMPTY: RepoState = {
  initialized: false,
  head: "main",
  refs: {},
  worktrees: {},
  commits: {},
  tags: {},
  temporary: [],
};

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export class RepositoryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async state(): Promise<RepoState> {
    const sql = (
      this.ctx.storage as DurableObjectStorage & { sql?: SqlStorage }
    ).sql;
    if (sql) {
      this.ensureRepositorySchema(sql);
      const meta = sql.exec("SELECT initialized, head FROM repository_meta WHERE id = 1").toArray()[0] as { initialized: number; head: string } | undefined;
      if (!meta) {
        const legacy = sql.exec("SELECT json FROM repository_state WHERE id = 1").toArray()[0] as { json?: SqlStorageValue } | undefined;
        if (typeof legacy?.json === "string") {
          const migrated = JSON.parse(legacy.json) as RepoState;
          await this.save(migrated);
          return migrated;
        }
        return structuredClone(EMPTY);
      }
      const refs: RepoState["refs"] = {};
      const worktrees: RepoState["worktrees"] = {};
      const temporary: string[] = [];
      for (const row of sql.exec("SELECT name, target_oid, temporary FROM repository_refs").toArray() as Array<{ name: string; target_oid: string | null; temporary: number }>) {
        refs[row.name] = row.target_oid;
        worktrees[row.name] ??= {};
        if (row.temporary) temporary.push(row.name);
      }
      for (const row of sql.exec("SELECT branch, path, oid, size, hash FROM repository_worktree_entries").toArray() as Array<{ branch: string; path: string; oid: string; size: number; hash: string }>) {
        (worktrees[row.branch] ??= {})[row.path] = { path: row.path, oid: row.oid, size: row.size, hash: row.hash };
      }
      const commits: RepoState["commits"] = {};
      for (const row of sql.exec("SELECT oid, tree_oid, parent_oids, message, metadata_json, created_at FROM repository_commits").toArray() as Array<{ oid: string; tree_oid: string; parent_oids: string; message: string; metadata_json: string; created_at: string }>) {
        const parents = JSON.parse(row.parent_oids) as string[];
        commits[row.oid] = {
          oid: row.oid, tree: row.tree_oid, ...(parents[0] ? { parent: parents[0] } : {}), ...(parents.length ? { parents } : {}),
          message: row.message, metadata: JSON.parse(row.metadata_json) as CommitRecord["metadata"], createdAt: row.created_at, entries: {},
        };
      }
      for (const row of sql.exec("SELECT commit_oid, path, oid, size, hash FROM repository_commit_entries").toArray() as Array<{ commit_oid: string; path: string; oid: string; size: number; hash: string }>) {
        const commit = commits[row.commit_oid];
        if (commit) commit.entries[row.path] = { path: row.path, oid: row.oid, size: row.size, hash: row.hash };
      }
      const tags: NonNullable<RepoState["tags"]> = {};
      for (const row of sql.exec("SELECT name, oid, target FROM repository_tags").toArray() as Array<{ name: string; oid: string; target: string }>) tags[row.name] = { oid: row.oid, target: row.target };
      return { initialized: meta.initialized === 1, head: meta.head, refs, worktrees, commits, tags, temporary };
    }
    return (
      (await this.ctx.storage.get<RepoState>("repository")) ??
      structuredClone(EMPTY)
    );
  }
  private ensureRepositorySchema(sql: SqlStorage): void {
    sql.exec("CREATE TABLE IF NOT EXISTS repository_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS repository_meta (id INTEGER PRIMARY KEY CHECK (id = 1), initialized INTEGER NOT NULL, head TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS repository_refs (name TEXT PRIMARY KEY, target_oid TEXT, temporary INTEGER NOT NULL DEFAULT 0)");
    sql.exec("CREATE TABLE IF NOT EXISTS repository_worktree_entries (branch TEXT NOT NULL, path TEXT NOT NULL, oid TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(branch,path))");
    sql.exec("CREATE TABLE IF NOT EXISTS repository_commits (oid TEXT PRIMARY KEY, tree_oid TEXT NOT NULL, parent_oids TEXT NOT NULL, message TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS repository_commit_entries (commit_oid TEXT NOT NULL, path TEXT NOT NULL, oid TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(commit_oid,path))");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_repository_commit_entries_blob ON repository_commit_entries(oid)");
    sql.exec("CREATE TABLE IF NOT EXISTS repository_tags (name TEXT PRIMARY KEY, oid TEXT NOT NULL, target TEXT NOT NULL)");
  }
  private async save(state: RepoState): Promise<void> {
    const sql = (
      this.ctx.storage as DurableObjectStorage & { sql?: SqlStorage }
    ).sql;
    if (sql) {
      this.ensureRepositorySchema(sql);
      const storage = this.ctx.storage as DurableObjectStorage & { transactionSync?: (fn: () => void) => void };
      const persist = () => {
        for (const table of ["repository_worktree_entries", "repository_commit_entries", "repository_commits", "repository_refs", "repository_tags"]) sql.exec(`DELETE FROM ${table}`);
        sql.exec("DELETE FROM repository_meta");
        sql.exec("INSERT INTO repository_meta (id, initialized, head) VALUES (1, ?, ?)", state.initialized ? 1 : 0, state.head);
        for (const [name, target] of Object.entries(state.refs)) sql.exec("INSERT INTO repository_refs (name,target_oid,temporary) VALUES (?,?,?)", name, target, state.temporary.includes(name) ? 1 : 0);
        for (const [branch, entries] of Object.entries(state.worktrees)) for (const entry of Object.values(entries)) sql.exec("INSERT INTO repository_worktree_entries (branch,path,oid,size,hash) VALUES (?,?,?,?,?)", branch, entry.path, entry.oid, entry.size, entry.hash);
        for (const commit of Object.values(state.commits)) {
          const parents = commit.parents ?? (commit.parent ? [commit.parent] : []);
          sql.exec("INSERT INTO repository_commits (oid,tree_oid,parent_oids,message,metadata_json,created_at) VALUES (?,?,?,?,?,?)", commit.oid, commit.tree, JSON.stringify(parents), commit.message, JSON.stringify(commit.metadata), commit.createdAt);
          for (const entry of Object.values(commit.entries)) sql.exec("INSERT INTO repository_commit_entries (commit_oid,path,oid,size,hash) VALUES (?,?,?,?,?)", commit.oid, entry.path, entry.oid, entry.size, entry.hash);
        }
        for (const [name, tag] of Object.entries(state.tags ?? {})) sql.exec("INSERT INTO repository_tags (name,oid,target) VALUES (?,?,?)", name, tag.oid, tag.target);
      };
      if (storage.transactionSync) storage.transactionSync(persist); else persist();
      return;
    }
    await this.ctx.storage.put("repository", state);
  }
  private scope(request: Request): RepositoryScope {
    return JSON.parse(
      request.headers.get("x-repository-scope") ?? "null"
    ) as RepositoryScope;
  }
  private async putObject(
    scope: RepositoryScope,
    oid: string,
    bytes: Uint8Array
  ): Promise<void> {
    const key = objectKey(scope, oid);
    const parsed = await this.parseVerifiedGitObject(oid, bytes);
    if (!parsed) throw new Error(`Git object verification failed before write: ${oid}`);
    if (!(await this.env.REPOSITORY_OBJECTS.head(key))) {
      await this.env.REPOSITORY_OBJECTS.put(key, bytes, { customMetadata: { oid } });
    }
    // R2 is the immutable object source of truth. Validate existing bytes too, including after a
    // concurrent content-addressed put, so an occupied key can never silently shadow bad data.
    await this.readVerifiedObject(scope, oid);
  }
  private async parseVerifiedGitObject(oid: string, bytes: Uint8Array): Promise<{ type: string; body: Uint8Array } | null> {
    const separator = bytes.indexOf(0);
    if (separator < 0) return null;
    const header = new TextDecoder().decode(bytes.slice(0, separator));
    const match = /^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(header);
    if (!match || Number(match[2]) !== bytes.byteLength - separator - 1) return null;
    const body = bytes.slice(separator + 1);
    const encoded = await encodeGitObject(match[1] as "blob" | "tree" | "commit" | "tag", body);
    return encoded.oid === oid ? { type: match[1]!, body } : null;
  }
  private async readVerifiedObject(scope: RepositoryScope, oid: string): Promise<{ type: string; body: Uint8Array }> {
    const object = await this.env.REPOSITORY_OBJECTS.get(objectKey(scope, oid));
    if (!object) throw new Error(`Object missing: ${oid}`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    const parsed = await this.parseVerifiedGitObject(oid, bytes);
    if (!parsed) throw new Error(`Git object integrity check failed: ${oid}`);
    return parsed;
  }
  private async collectUnreachableObjects(scope: RepositoryScope, state: RepoState): Promise<{ kept: number; deleted: number }> {
    const marked = new Set<string>();
    const visitTree = async (oid: string): Promise<void> => {
      if (marked.has(oid)) return;
      marked.add(oid);
      const object = await this.readVerifiedObject(scope, oid);
      if (object.type !== "tree") throw new Error(`Expected tree object: ${oid}`);
      for (let offset = 0; offset < object.body.length;) {
        const nul = object.body.indexOf(0, offset);
        if (nul < 0 || nul + 21 > object.body.length) throw new Error(`Malformed tree object: ${oid}`);
        const mode = new TextDecoder().decode(object.body.slice(offset, object.body.indexOf(32, offset)));
        const childOid = [...object.body.slice(nul + 1, nul + 21)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        marked.add(childOid);
        if (mode === "40000" || mode === "040000") await visitTree(childOid);
        offset = nul + 21;
      }
    };
    const visitCommit = async (oid: string): Promise<void> => {
      if (marked.has(oid)) return;
      const commit = state.commits[oid];
      if (!commit) throw new Error(`Reachable commit metadata missing: ${oid}`);
      marked.add(oid);
      await visitTree(commit.tree);
      for (const parent of commit.parents ?? (commit.parent ? [commit.parent] : [])) await visitCommit(parent);
    };
    for (const oid of Object.values(state.refs)) if (oid) await visitCommit(oid);
    for (const tag of Object.values(state.tags ?? {})) {
      marked.add(tag.oid);
      await visitCommit(tag.target);
    }
    // Unsaved worktree edits are reachable state too; retain their blobs until the branch is
    // deleted, committed, or explicitly cleaned up.
    for (const entries of Object.values(state.worktrees)) for (const entry of Object.values(entries)) marked.add(entry.oid);

    const prefix = `repositories/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/objects/`;
    let cursor: string | undefined;
    let kept = 0, deleted = 0;
    do {
      const page = await this.env.REPOSITORY_OBJECTS.list(cursor ? { prefix, cursor } : { prefix });
      for (const item of page.objects) {
        const split = item.key.lastIndexOf("/");
        const oid = `${item.key.slice(split - 2, split)}${item.key.slice(split + 1)}`;
        if (marked.has(oid)) kept++;
        else { await this.env.REPOSITORY_OBJECTS.delete(item.key); deleted++; }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return { kept, deleted };
  }

  /** Journal Git-to-workspace publication before effects. Replay never overwrites a new writer. */
  private async publishWorkspaceState(scope: RepositoryScope, state: RepoState, branch: string, before: Entries): Promise<void> {
    if (!this.env.WORKSPACE_R2) { await this.save(state); return; }
    const after = state.worktrees[branch] ?? {};
    const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(path => before[path]?.hash !== after[path]?.hash)
      .map(path => ({ path, expected: before[path]?.hash ?? null, next: after[path] ?? null }));
    const root = `repositories/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/publications/`;
    const key = root + crypto.randomUUID() + ".json";
    await this.env.REPOSITORY_OBJECTS.put(key, JSON.stringify({ scope, state, branch, changes }));
    await this.ctx.storage.put("workspace_publication", { key, scope });
    await this.recoverWorkspacePublication(scope);
  }

  private async recoverWorkspacePublication(scope: RepositoryScope): Promise<void> {
    try {
      await this.replayWorkspacePublication(scope);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Storage operation failed";
      throw new Error(message.startsWith("workspace_publication_") ? message : `workspace_publication_interrupted:${message}`);
    }
  }

  private async replayWorkspacePublication(scope: RepositoryScope): Promise<void> {
    const pending = await this.ctx.storage.get<{ key: string; scope: RepositoryScope }>("workspace_publication");
    if (!pending) return;
    if (JSON.stringify(pending.scope) !== JSON.stringify(scope) || !this.env.WORKSPACE_R2) throw new Error("workspace_publication_scope_conflict");
    const saved = await this.env.REPOSITORY_OBJECTS.get(pending.key);
    if (!saved) throw new Error("workspace_publication_journal_missing");
    const journal = JSON.parse(new TextDecoder().decode(await saved.arrayBuffer())) as {
      scope: RepositoryScope; state: RepoState; branch: string;
      changes: Array<{ path: string; expected: string | null; next: TreeEntry | null }>;
    };
    const root = `spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`;
    const prefix = journal.branch === "main" ? root : `${root}branches/${journal.branch}/`;
    for (const change of journal.changes) {
      const key = prefix + normalizePath(change.path);
      const head = await this.env.WORKSPACE_R2.head(key);
      const live = head && head.customMetadata?.deleted !== "true";
      const currentHash = live ? head.customMetadata?.sha256 ?? await sha256(new Uint8Array(await (await this.env.WORKSPACE_R2.get(key))!.arrayBuffer())) : null;
      const desiredHash = change.next?.hash ?? null;
      // A previous attempt already published this file. A fresh competing write is a conflict.
      if (currentHash === desiredHash) continue;
      if (currentHash !== change.expected) throw new Error(`workspace_publication_conflict:${change.path}`);
      const bytes = change.next ? (await this.readVerifiedObject(scope, change.next.oid)).body : new Uint8Array();
      if (change.next && (bytes.byteLength !== change.next.size || await sha256(bytes) !== change.next.hash)) throw new Error("workspace_publication_blob_corrupt");
      const result = await this.env.WORKSPACE_R2.put(key, bytes, {
        onlyIf: head ? { etagMatches: head.etag } : { etagDoesNotMatch: "*" },
        customMetadata: { ...(change.next ? { sha256: change.next.hash } : {}), deleted: change.next ? "false" : "true" },
      });
      if (!result) throw new Error(`workspace_publication_conflict:${change.path}`);
    }
    await this.save(journal.state);
    await this.ctx.storage.delete("workspace_publication");
    await this.env.REPOSITORY_OBJECTS.delete(pending.key);
  }

  private resolve(
    state: RepoState,
    value: string | null | undefined
  ): string | null {
    if (!value) return null;
    const ref = value.replace(/^refs\/heads\//, "");
    return state.refs[ref] !== undefined
      ? state.refs[ref]!
      : state.commits[value]
        ? value
        : null;
  }

  private ancestors(
    state: RepoState,
    start: string | null
  ): Map<string, number> {
    const out = new Map<string, number>();
    const queue: Array<[string, number]> = start ? [[start, 0]] : [];
    while (queue.length) {
      const [oid, distance] = queue.shift()!;
      if (out.has(oid)) continue;
      out.set(oid, distance);
      const commit = state.commits[oid];
      for (const parent of commit?.parents ??
        (commit?.parent ? [commit.parent] : []))
        queue.push([parent, distance + 1]);
    }
    return out;
  }

  private async blobText(
    scope: RepositoryScope,
    entry: TreeEntry | undefined
  ): Promise<string> {
    if (!entry) return "";
    const object = await this.readVerifiedObject(scope, entry.oid);
    if (object.type !== "blob" || object.body.byteLength !== entry.size || await sha256(object.body) !== entry.hash) {
      throw new Error(`Blob integrity check failed: ${entry.oid}`);
    }
    return new TextDecoder().decode(object.body);
  }

  /** Viewport hint only: every kind is persisted as the original raw blob bytes. */
  private deliverableKind(path: string): "spreadsheet" | "document" | "code" | "generic" {
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (extension === ".csv" || extension === ".xlsx" || extension === ".xls") return "spreadsheet";
    if (extension === ".docx" || extension === ".doc" || extension === ".md" || extension === ".txt") return "document";
    if (/^(?:src\/|.*\.(?:[cm]?[jt]sx?|py|rs|go|java|css|html|json|ya?ml)$)/i.test(path)) return "code";
    return "generic";
  }

  /** RFC-4180-compatible row parser used for human-readable CSV cell deltas. */
  private csvRows(value: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [], field = "", quoted = false;
    for (let index = 0; index < value.length; index++) {
      const character = value[index]!;
      if (quoted && character === '"' && value[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') quoted = !quoted;
      else if (!quoted && character === ",") { row.push(field); field = ""; }
      else if (!quoted && (character === "\n" || character === "\r")) {
        if (character === "\r" && value[index + 1] === "\n") index++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += character;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  private spreadsheetCellDeltas(before: string, after: string) {
    const a = this.csvRows(before), b = this.csvRows(after);
    const changes: Array<{ cell: string; before: string | null; after: string | null }> = [];
    const columnName = (column: number) => {
      let name = "";
      for (let value = column + 1; value; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
      return name;
    };
    for (let row = 0; row < Math.max(a.length, b.length); row++) {
      for (let column = 0; column < Math.max(a[row]?.length ?? 0, b[row]?.length ?? 0); column++) {
        const oldValue = a[row]?.[column] ?? null, newValue = b[row]?.[column] ?? null;
        if (oldValue !== newValue) changes.push({ cell: `${columnName(column)}${row + 1}`, before: oldValue, after: newValue });
      }
    }
    return changes;
  }

  private async changedFiles(scope: RepositoryScope, a: Entries, b: Entries) {
    const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return Promise.all(
      paths
        .filter((path) => a[path]?.oid !== b[path]?.oid)
        .map(async (path) => {
          const before = await this.blobText(scope, a[path]);
          const after = await this.blobText(scope, b[path]);
          const beforeLines = before ? before.split("\n") : [];
          const afterLines = after ? after.split("\n") : [];
          const additions = afterLines.filter(
            (line) => !beforeLines.includes(line)
          ).length;
          const deletions = beforeLines.filter(
            (line) => !afterLines.includes(line)
          ).length;
          const patch = [
            `--- a/${path}`,
            `+++ b/${path}`,
            `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
            ...beforeLines.map((line) => `-${line}`),
            ...afterLines.map((line) => `+${line}`),
          ].join("\n");
          const kind = this.deliverableKind(path);
          const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
          const presentation = kind === "spreadsheet"
            ? {
                kind,
                // CSV is intrinsically cell-addressable. XLS/XLSX remains losslessly
                // versioned and is deliberately identified as a workbook so the shell can
                // render its binary workbook delta with its SheetJS viewport.
                cellDeltas: extension === ".csv" ? this.spreadsheetCellDeltas(before, after) : [],
                binaryWorkbook: extension !== ".csv",
              }
            : kind === "document"
              ? { kind, redline: patch, binaryDocument: extension === ".doc" || extension === ".docx" }
              : { kind, patch };
          return {
            path,
            status: !a[path] ? "added" : !b[path] ? "deleted" : "modified",
            additions,
            deletions,
            patch,
            presentation,
            before: a[path]?.oid,
            after: b[path]?.oid,
          };
        })
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      try {
        request = new Request(request, { body: await readBoundedRequestBytes(request, 16 * 1024 * 1024) });
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError)
          return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
        return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
      }
    }
    // Keep the state read, expected-hash comparison, immutable object write and ref/state update
    // inside one Durable Object input gate. This is the SQLite equivalent of an atomic CAS.
    return typeof this.ctx.blockConcurrencyWhile === "function"
      ? this.ctx.blockConcurrencyWhile(() => this.handle(request))
      : this.handle(request);
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const scope = this.scope(request);
      await this.recoverWorkspacePublication(scope);
      const url = new URL(request.url);
      let op = url.pathname.replace(/^\/+/, "");
      // Stable binding names used by SDK callers; the compact HTTP names remain backwards compatible.
      op =
        (
          {
            createRepo: "init",
            getRepo: "head",
            getCommit: "commit-object",
            getTree: "tree",
            compare: "compare",
            forkForPrivateScratchpad: "branch",
            createTaskBranch: "branch",
            createRaceBranch: "branch",
            fastForwardRace: "merge",
            "git.reset_hard": "rollback",
            rollbackToTurn: "rollback",
            getBlame: "blame",
            generatePullRequestDiff: "pull-request-diff",
            submitPullRequest: "submit-pull-request",
            mergePullRequest: "merge-pull-request",
            getDivergenceStatus: "divergence",
            reconcileUpstream: "reconcile-upstream",
          } as Record<string, string>
        )[op] ?? op;
      const state = await this.state();
      let body =
        request.method === "GET"
          ? {}
          : await request.json<Record<string, unknown>>().catch(() => ({}));
      if (op === "init" && request.method === "POST") {
        if (!state.initialized) {
          state.initialized = true;
          state.refs.main = null;
          state.worktrees.main = {};
          await this.save(state);
        }
        return Response.json({
          initialized: true,
          branch: state.head,
          commit_id: state.refs[state.head],
        });
      }
      if (!state.initialized)
        return jsonError("Repository not initialized", 409);
      if (op === "accumulate-workspace" && request.method === "POST") {
        const name = String(body.branch ?? "").replace(/^refs\/heads\//, "");
        if (!/^task\/[A-Za-z0-9._-]+\/accumulator$/.test(name)) return jsonError("Invalid accumulator branch");
        if (!(name in state.refs)) {
          const from = this.resolve(state, String(body.from ?? state.head));
          state.refs[name] = from;
          state.worktrees[name] = from ? structuredClone(state.commits[from]!.entries) : {};
        }
        body = { ...body, branch: name, changes: Array.isArray(body.files) ? body.files : [], message: String(body.message ?? `Accumulate ${body.chunk_id ?? "workspace changes"}`) };
        op = "commit";
      }
      const branch = String(
        body.branch ?? url.searchParams.get("branch") ?? state.head
      );
      if (!(branch in state.refs)) return jsonError("Branch not found", 404);

      if (op === "reconcile" && request.method === "POST") {
        if (!this.env.WORKSPACE_R2) return jsonError("Workspace reconciliation storage is not bound", 503);
        const workspaceRoot = `spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`;
        const prefix = branch === "main" ? workspaceRoot : `${workspaceRoot}branches/${branch.replaceAll("\\", "/")}/`;
        const live = new Map<string, { bytes: Uint8Array; hash: string; etag: string }>();
        let cursor: string | undefined;
        do {
          const page = await this.env.WORKSPACE_R2.list(cursor ? { prefix, cursor } : { prefix });
          for (const item of page.objects) {
            if (item.key.slice(prefix.length).startsWith("branches/")) continue;
            if (item.customMetadata?.deleted === "true" || item.key.endsWith("/.keep")) continue;
            const path = normalizePath(item.key.slice(prefix.length));
            const object = await this.env.WORKSPACE_R2.get(item.key);
            if (!object) continue;
            const bytes = new Uint8Array(await object.arrayBuffer());
            const head = await this.env.WORKSPACE_R2.head(item.key);
            if (!head) continue;
            live.set(path, { bytes, hash: await sha256(bytes), etag: head.etag });
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        const changes: Array<Record<string, unknown>> = [];
        for (const [path, prior] of Object.entries(state.worktrees[branch]!)) {
          if (!live.has(path)) changes.push({ path, deleted: true, expected_hash: prior.hash });
        }
        for (const [path, current] of live) {
          const prior = state.worktrees[branch]![path];
          if (prior?.hash === current.hash) continue;
          let binary = "";
          for (let offset = 0; offset < current.bytes.length; offset += 0x8000)
            binary += String.fromCharCode(...current.bytes.subarray(offset, Math.min(offset + 0x8000, current.bytes.length)));
          changes.push({ path, content_base64: btoa(binary), expected_hash: prior?.hash ?? null });
        }
        if (!changes.length) return Response.json({ reconciled: true, changed: 0, commit_id: state.refs[branch] ?? null });
        // Refuse a snapshot that changed while it was being read. The caller can retry and the
        // next pass will replay the latest canonical R2 state into the Git projection.
        for (const [path, current] of live) {
          const head = await this.env.WORKSPACE_R2.head(`${prefix}${path}`);
          if (head?.etag !== current.etag) return jsonError("Workspace changed during reconciliation; retry", 409);
        }
        const commitRequest = new Request("http://repository/commit", {
          method: "POST",
          headers: { "content-type": "application/json", "x-repository-scope": JSON.stringify(scope) },
          body: JSON.stringify({
            branch,
            expected_head: state.refs[branch] ?? null,
            changes,
            message: "Reconcile workspace projection",
            metadata: body.metadata,
          }),
        });
        const committed = await this.handle(commitRequest);
        if (!committed.ok) return committed;
        const result = await committed.json<{ commit_id: string }>();
        return Response.json({ reconciled: true, changed: changes.length, commit_id: result.commit_id }, { status: 200 });
      }

      if (op === "tree" && request.method === "GET") {
        const at = url.searchParams.get("at");
        const entries = at
          ? state.commits[at]?.entries
          : state.worktrees[branch];
        if (!entries) return jsonError("Commit not found", 404);
        const prefix = (url.searchParams.get("path") ?? "").replace(
          /^\/+|\/+$/g,
          ""
        );
        const data = Object.values(entries).filter(
          (entry) =>
            !prefix ||
            entry.path === prefix ||
            entry.path.startsWith(`${prefix}/`)
        );
        return Response.json({ data, commit_id: at ?? state.refs[branch] });
      }
      if (op === "file" && request.method === "GET") {
        const path = normalizePath(url.searchParams.get("path") ?? "");
        const at = url.searchParams.get("at");
        const entry = (
          at ? state.commits[at]?.entries : state.worktrees[branch]
        )?.[path];
        if (!entry) return jsonError("File not found", 404);
        const object = await this.readVerifiedObject(scope, entry.oid);
        if (object.type !== "blob" || object.body.byteLength !== entry.size || await sha256(object.body) !== entry.hash) return jsonError("Blob integrity check failed", 500);
        return new Response(object.body, {
          headers: {
            "content-type": "application/octet-stream",
            "x-git-oid": entry.oid,
          },
        });
      }
      if (op.startsWith("object/") && request.method === "GET") {
        const oid = op.slice("object/".length);
        if (!/^[a-f0-9]{40}$/.test(oid)) return jsonError("Invalid object id");
        const at = url.searchParams.get("at");
        const entries = at
          ? state.commits[at]?.entries
          : state.worktrees[branch];
        if (!entries) return jsonError("Commit not found", 404);
        if (!Object.values(entries).some((entry) => entry.oid === oid))
          return jsonError("Object not found", 404);
        const object = await this.readVerifiedObject(scope, oid);
        const entry = Object.values(entries).find((candidate) => candidate.oid === oid);
        if (object.type !== "blob" || !entry || object.body.byteLength !== entry.size || await sha256(object.body) !== entry.hash) return jsonError("Blob integrity check failed", 500);
        return new Response(object.body, {
          headers: {
            "content-type": "application/octet-stream",
            "x-git-oid": oid,
          },
        });
      }
      if (op === "write" && request.method === "PUT") {
        const path = normalizePath(String(body.path ?? ""));
        if (!Object.prototype.hasOwnProperty.call(body, "expected_hash") || (body.expected_hash !== null && typeof body.expected_hash !== "string"))
          return jsonError("expected_hash is required (string or null for create)");
        const bytes =
          typeof body.content_base64 === "string"
            ? Uint8Array.from(atob(body.content_base64), (char) =>
                char.charCodeAt(0)
              )
            : new TextEncoder().encode(String(body.content ?? ""));
        const current = state.worktrees[branch]![path];
        if ((current?.hash ?? null) !== body.expected_hash) {
          return jsonError(`✖ Conflict Error: '${path}' was modified concurrently. Re-read before applying patch.`, 409);
        }
        const blob = await encodeGitObject("blob", bytes);
        const hash = await sha256(bytes);
        await this.putObject(scope, blob.oid, blob.bytes);
        state.worktrees[branch]![path] = {
          path,
          oid: blob.oid,
          size: bytes.byteLength,
          hash,
        };
        await this.save(state);
        return Response.json({ path, oid: blob.oid, hash, size: bytes.byteLength });
      }
      if (op === "file" && request.method === "DELETE") {
        const path = normalizePath(String(body.path ?? ""));
        if (!Object.prototype.hasOwnProperty.call(body, "expected_hash") || (body.expected_hash !== null && typeof body.expected_hash !== "string"))
          return jsonError("expected_hash is required (string or null)");
        const current = state.worktrees[branch]![path];
        if ((current?.hash ?? null) !== body.expected_hash) return jsonError(`✖ Conflict Error: '${path}' was modified concurrently. Re-read before deleting.`, 409);
        if (!current) return jsonError("File not found", 404);
        delete state.worktrees[branch]![path];
        await this.save(state);
        return Response.json({ deleted: true, path });
      }
      if (op === "commit" && request.method === "POST") {
        if (body.oid !== undefined) {
          const record = state.commits[String(body.oid)];
          return record
            ? Response.json(record)
            : jsonError("Commit not found", 404);
        }
        if (!Object.prototype.hasOwnProperty.call(body, "expected_head") || (body.expected_head !== null && typeof body.expected_head !== "string"))
          return jsonError("expected_head is required (commit ID or null)");
        const expected = body.expected_head;
        if (expected !== (state.refs[branch] ?? null))
          return jsonError("Head changed", 409);
        const metadata = validateMetadata(body.metadata);
        const changes = Array.isArray(body.changes)
          ? (body.changes as Array<Record<string, unknown>>)
          : [];
        // Validate the whole change set before publishing any file mutation. The DO input gate
        // serializes this head/hash precondition with the eventual ref save.
        for (const change of changes) {
          const path = normalizePath(String(change.path ?? ""));
          if (!Object.prototype.hasOwnProperty.call(change, "expected_hash") || (change.expected_hash !== null && typeof change.expected_hash !== "string"))
            return jsonError(`expected_hash is required for ${path}`);
          const current = state.worktrees[branch]![path];
          if ((current?.hash ?? null) !== change.expected_hash)
            return jsonError(`✖ Conflict Error: '${path}' was modified concurrently. Re-read before applying patch.`, 409);
        }
        for (const change of changes) {
          const path = normalizePath(String(change.path ?? ""));
          if (path.split("/").includes("node_modules"))
            return jsonError("node_modules cannot be synchronized");
          if (change.deleted === true) {
            delete state.worktrees[branch]![path];
            continue;
          }
          if (typeof change.content_base64 !== "string")
            return jsonError(`content_base64 is required for ${path}`);
          const bytes = Uint8Array.from(
            atob(change.content_base64),
            (character) => character.charCodeAt(0)
          );
          const contentSha256 = [
            ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          ]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          const current = state.worktrees[branch]![path];
          if (change.expected_hash !== undefined && (current?.hash ?? null) !== change.expected_hash)
            return jsonError(`✖ Conflict Error: '${path}' was modified concurrently. Re-read before applying patch.`, 409);
          if (change.oid !== undefined && change.oid !== contentSha256)
            return jsonError(`Content SHA-256 mismatch for ${path}`, 409);
          const blob = await encodeGitObject("blob", bytes);
          await this.putObject(scope, blob.oid, blob.bytes);
          state.worktrees[branch]![path] = {
            path,
            oid: blob.oid,
            size: bytes.byteLength,
            hash: contentSha256,
          };
        }
        // Defense in depth for worktrees created before namespace validation was introduced.
        // Agent machinery can never be serialized into a user-visible Git tree.
        for (const path of Object.keys(state.worktrees[branch]!)) {
          if (path === ".avos" || path.startsWith(".avos/"))
            delete state.worktrees[branch]![path];
        }
        const hierarchy = await encodeTreeHierarchy(state.worktrees[branch]!);
        const tree = hierarchy.root;
        await Promise.all(
          hierarchy.objects.map((object) =>
            this.putObject(scope, object.oid, object.bytes)
          )
        );
        const timestamp = new Date().toISOString();
        const message = String(body.message ?? metadata.rationale).slice(
          0,
          10_000
        );
        const parent = state.refs[branch] ?? undefined;
        const encoded = await encodeGitObject(
          "commit",
          commitBody(tree.oid, parent, message, metadata, timestamp)
        );
        await this.putObject(scope, encoded.oid, encoded.bytes);
        state.commits[encoded.oid] = {
          oid: encoded.oid,
          tree: tree.oid,
          ...(parent ? { parent } : {}),
          ...(parent ? { parents: [parent] } : {}),
          message,
          metadata,
          createdAt: timestamp,
          entries: structuredClone(state.worktrees[branch]!),
        };
        state.refs[branch] = encoded.oid;
        await this.save(state);
        return Response.json(
          { commit_id: encoded.oid, tree_id: tree.oid, parent, metadata },
          { status: 201 }
        );
      }
      if (op === "commit-object" && request.method === "GET") {
        const oid = this.resolve(
          state,
          url.searchParams.get("oid") ?? url.searchParams.get("at")
        );
        return oid && state.commits[oid]
          ? Response.json(state.commits[oid])
          : jsonError("Commit not found", 404);
      }
      if (op === "tag" && request.method === "POST") {
        const name = String(body.name ?? "");
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
          return jsonError("Invalid tag name");
        const target = this.resolve(
          state,
          String(body.target ?? state.refs[branch] ?? "")
        );
        if (!target) return jsonError("Commit not found", 404);
        state.tags ??= {};
        if (state.tags[name]) return jsonError("Tag exists", 409);
        const tag = await encodeGitObject(
          "tag",
          new TextEncoder().encode(
            `object ${target}\ntype commit\ntag ${name}\ntagger Naelao Agent <agent@naelao.ai> ${Math.floor(Date.now() / 1000)} +0000\n\n${String(body.message ?? name)}\n`
          )
        );
        await this.putObject(scope, tag.oid, tag.bytes);
        state.tags[name] = { oid: tag.oid, target };
        await this.save(state);
        return Response.json(
          { ref: `refs/tags/${name}`, oid: tag.oid, target },
          { status: 201 }
        );
      }
      if (op === "branch" && request.method === "POST") {
        const name = String(body.name ?? "");
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(name) ||
          name.includes("..")
        )
          return jsonError("Invalid branch name");
        if (name in state.refs) return jsonError("Branch exists", 409);
        const from =
          this.resolve(state, String(body.from ?? state.refs[branch] ?? "")) ??
          "";
        if (from && !state.commits[from])
          return jsonError("Commit not found", 404);
        state.refs[name] = from || null;
        state.worktrees[name] = from
          ? structuredClone(state.commits[from]!.entries)
          : {};
        if (body.temporary === true) state.temporary.push(name);
        await this.publishWorkspaceState(scope, state, name, {});
        return Response.json(
          { branch: name, commit_id: state.refs[name], copy_on_write: true },
          { status: 201 }
        );
      }
      if (op === "pull-request-diff" && request.method === "GET") {
        const baseName = (url.searchParams.get("baseBranch") ?? "main").replace(/^refs\/heads\//, "");
        const forkName = (url.searchParams.get("forkBranch") ?? "").replace(/^refs\/heads\//, "");
        const base = state.refs[baseName];
        const head = state.refs[forkName];
        if (!base || !head) return jsonError("Reference not found", 404);
        const files = await this.changedFiles(scope, state.commits[base]!.entries, state.commits[head]!.entries);
        return Response.json({
          baseBranch: baseName, forkBranch: forkName, baseCommit: base, headCommit: head,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0), files,
        });
      }
      if (op === "submit-pull-request" && request.method === "POST") {
        const baseName = String(body.baseBranch ?? "main").replace(/^refs\/heads\//, "");
        const forkName = String(body.forkBranch ?? branch).replace(/^refs\/heads\//, "");
        const base = state.refs[baseName], head = state.refs[forkName];
        if (!base || !head) return jsonError("Reference not found", 404);
        const files = await this.changedFiles(scope, state.commits[base]!.entries, state.commits[head]!.entries);
        const card = {
          type: "inline_pull_request", id: typeof body.card_id === "string" ? body.card_id : crypto.randomUUID(), title: String(body.title ?? `Merge ${forkName} into ${baseName}`),
          author: String(body.author ?? "agent"), reasoning: String(body.reasoning ?? ""), baseBranch: baseName,
          forkBranch: forkName, baseCommit: base, headCommit: head, files,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
          actions: ["accept_and_merge", "request_revisions", "reject"], createdAt: new Date().toISOString(),
        };
        return Response.json({ card, event: { type: "workspace.pull_request", tier: "tier_1_team", payload: card } }, { status: 201 });
      }
      if (op === "divergence" && request.method === "GET") {
        const baseName = url.searchParams.get("baseRef") ?? "main";
        const currentName = url.searchParams.get("currentRef") ?? branch;
        const upstreamHead = this.resolve(state, baseName), current = this.resolve(state, currentName);
        if (!upstreamHead || !current) return jsonError("Reference not found", 404);
        const currentAncestors = this.ancestors(state, current);
        const commitsBehind = [...this.ancestors(state, upstreamHead).keys()].filter((oid) => !currentAncestors.has(oid)).length;
        const common = [...this.ancestors(state, upstreamHead).keys()].find((oid) => currentAncestors.has(oid)) ?? current;
        return Response.json({ commitsBehind, baseCommit: common, upstreamHead });
      }
      if (op === "reconcile-upstream" && request.method === "POST") {
        const targetName = String(body.targetBranch ?? branch).replace(/^refs\/heads\//, "");
        const upstreamName = String(body.upstreamBranch ?? "main").replace(/^refs\/heads\//, "");
        const target = state.refs[targetName], upstream = state.refs[upstreamName];
        if (!target || !upstream) return jsonError("Reference not found", 404);
        const targetAncestors = this.ancestors(state, target);
        const commitsBehind = [...this.ancestors(state, upstream).keys()].filter((oid) => !targetAncestors.has(oid)).length;
        if (!commitsBehind) return Response.json({ status: "UP_TO_DATE", commitsBehind: 0, baseCommit: upstream, upstreamHead: upstream, overlappingFiles: [] });
        const common = [...this.ancestors(state, upstream).keys()].find((oid) => targetAncestors.has(oid));
        if (!common) return jsonError("No merge base", 409);
        const baseEntries = state.commits[common]!.entries;
        const upstreamEntries = state.commits[upstream]!.entries;
        const targetEntries = state.commits[target]!.entries;
        const upstreamFiles = (await this.changedFiles(scope, baseEntries, upstreamEntries)).map((f) => f.path);
        const localFiles = (await this.changedFiles(scope, baseEntries, targetEntries)).map((f) => f.path);
        const overlappingFiles = localFiles.filter((path) => upstreamFiles.includes(path));
        if (overlappingFiles.length) {
          const threeWayDiff = await this.changedFiles(scope, upstreamEntries, targetEntries);
          return Response.json({ status: "REVIEW_REQUIRED", commitsBehind, baseCommit: common, upstreamHead: upstream, overlappingFiles, upstreamFiles, threeWayDiff });
        }
        const rebased: Entries = structuredClone(upstreamEntries);
        for (const path of localFiles) targetEntries[path] ? rebased[path] = targetEntries[path]! : delete rebased[path];
        const hierarchy = await encodeTreeHierarchy(rebased);
        await Promise.all(hierarchy.objects.map((object) => this.putObject(scope, object.oid, object.bytes)));
        const createdAt = new Date().toISOString();
        const metadata = validateMetadata(body.metadata ?? {
          agent_role: "system", user_goal: "Reconcile upstream", task_id: "auto-rebase",
          rationale: `Rebase ${targetName} onto ${upstreamName}`, thread_id: "system", tool_turn_id: crypto.randomUUID(),
        });
        const encoded = await encodeGitObject("commit", commitBody(hierarchy.root.oid, upstream, `Rebase ${targetName} onto ${upstreamName}`, metadata, createdAt));
        await this.putObject(scope, encoded.oid, encoded.bytes);
        state.commits[encoded.oid] = { oid: encoded.oid, tree: hierarchy.root.oid, parent: upstream, parents: [upstream], message: `Rebase ${targetName} onto ${upstreamName}`, metadata, createdAt, entries: structuredClone(rebased) };
        state.refs[targetName] = encoded.oid; state.worktrees[targetName] = rebased;
        await this.publishWorkspaceState(scope, state, targetName, targetEntries);
        return Response.json({ status: "AUTO_REBASED", commitsBehind, baseCommit: common, upstreamHead: upstream, commit_id: encoded.oid, overlappingFiles: [] });
      }
      if (op === "merge-pull-request" && request.method === "POST") {
        const rank = String(body.reviewerRank ?? body.reviewer_rank ?? "");
        if (rank !== "admin" && rank !== "owner") return jsonError("Only an admin or owner may merge a pull request", 403);
        op = "merge";
        body.target = body.baseBranch ?? "main";
        body.source = body.forkBranch ?? branch;
      }
      if (op === "compare" && request.method === "GET") {
        const base = this.resolve(
          state,
          url.searchParams.get("base") ?? url.searchParams.get("baseRef")
        );
        const head = this.resolve(
          state,
          url.searchParams.get("head") ?? url.searchParams.get("headRef")
        );
        if (!base || !head) return jsonError("Reference not found", 404);
        const baseAncestors = this.ancestors(state, base);
        const headAncestors = this.ancestors(state, head);
        const ahead = [...headAncestors.keys()].filter(
          (oid) => !baseAncestors.has(oid)
        ).length;
        const behind = [...baseAncestors.keys()].filter(
          (oid) => !headAncestors.has(oid)
        ).length;
        return Response.json({
          base,
          head,
          ahead,
          behind,
          files: await this.changedFiles(
            scope,
            state.commits[base]!.entries,
            state.commits[head]!.entries
          ),
        });
      }
      if (op === "checkout" && request.method === "POST") {
        state.head = branch;
        await this.save(state);
        return Response.json({ branch, commit_id: state.refs[branch] });
      }
      if (op === "diff" && request.method === "GET") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const a = from ? state.commits[from]?.entries : {};
        const b = to ? state.commits[to]?.entries : state.worktrees[branch];
        if (!a || !b) return jsonError("Commit not found", 404);
        const paths = [
          ...new Set([...Object.keys(a), ...Object.keys(b)]),
        ].sort();
        return Response.json({
          data: paths
            .filter((p) => a[p]?.oid !== b[p]?.oid)
            .map((path) => ({
              path,
              status: !a[path] ? "added" : !b[path] ? "deleted" : "modified",
              before: a[path]?.oid,
              after: b[path]?.oid,
            })),
        });
      }
      if (op === "merge" && request.method === "POST") {
        const targetName = String(body.target ?? "main").replace(
          /^refs\/heads\//,
          ""
        );
        const sourceName = String(body.source ?? branch).replace(
          /^refs\/heads\//,
          ""
        );
        const target = state.refs[targetName];
        const source = state.refs[sourceName];
        if (!source || target === undefined)
          return jsonError("Reference not found", 404);
        if (body.expected_head !== undefined && body.expected_head !== target)
          return jsonError("Head changed", 409);
        if (!target || this.ancestors(state, source).has(target)) {
          state.refs[targetName] = source;
          state.worktrees[targetName] = structuredClone(
            state.commits[source]!.entries
          );
          await this.publishWorkspaceState(scope, state, targetName, target ? state.commits[target]!.entries : {});
          return Response.json({
            commit_id: source,
            fast_forward: true,
            branch: targetName,
            event: { type: "workspace.merged", branch: targetName, source: sourceName, reviewerId: body.reviewerId ?? null },
          });
        }
        const common = [...this.ancestors(state, target).keys()].find((oid) =>
          this.ancestors(state, source).has(oid)
        );
        if (!common) return jsonError("No merge base", 409);
        const baseEntries = state.commits[common]!.entries;
        const ours = state.commits[target]!.entries;
        const theirs = state.commits[source]!.entries;
        const merged: Entries = structuredClone(ours);
        const conflicts: string[] = [];
        for (const path of new Set([
          ...Object.keys(baseEntries),
          ...Object.keys(ours),
          ...Object.keys(theirs),
        ])) {
          const baseOid = baseEntries[path]?.oid,
            ourOid = ours[path]?.oid,
            theirOid = theirs[path]?.oid;
          if (ourOid === theirOid) continue;
          if (ourOid === baseOid) {
            if (theirs[path]) merged[path] = theirs[path]!;
            else delete merged[path];
          } else if (theirOid !== baseOid) conflicts.push(path);
        }
        if (conflicts.length)
          return Response.json(
            { error: "Merge conflict", conflicts },
            { status: 409 }
          );
        state.worktrees[targetName] = merged;
        const metadata = validateMetadata(body.metadata ?? {
          agent_role: "reviewer", user_goal: `Merge ${sourceName} into ${targetName}`,
          task_id: "pull-request-merge", rationale: `Approved by ${String(body.reviewerId ?? "reviewer")}`,
          thread_id: "team-room", tool_turn_id: crypto.randomUUID(),
        });
        const hierarchy = await encodeTreeHierarchy(merged);
        await Promise.all(
          hierarchy.objects.map((object) =>
            this.putObject(scope, object.oid, object.bytes)
          )
        );
        const createdAt = new Date().toISOString();
        const message = String(
          body.message ?? `Merge ${sourceName} into ${targetName}`
        ).slice(0, 10_000);
        const encoded = await encodeGitObject(
          "commit",
          commitBody(
            hierarchy.root.oid,
            [target, source],
            message,
            metadata,
            createdAt
          )
        );
        await this.putObject(scope, encoded.oid, encoded.bytes);
        state.commits[encoded.oid] = {
          oid: encoded.oid,
          tree: hierarchy.root.oid,
          parent: target,
          parents: [target, source],
          message,
          metadata,
          createdAt,
          entries: structuredClone(merged),
        };
        state.refs[targetName] = encoded.oid;
        await this.publishWorkspaceState(scope, state, targetName, ours);
        return Response.json(
          {
            commit_id: encoded.oid,
            fast_forward: false,
            merged: true,
            branch: targetName,
            parents: [target, source],
            event: { type: "workspace.merged", branch: targetName, source: sourceName, reviewerId: body.reviewerId ?? null },
          },
          { status: 201 }
        );
      }
      if (op === "rollback" && request.method === "POST") {
        const commit = state.commits[String(body.commit_id ?? "")];
        if (!commit) return jsonError("Commit not found", 404);
        const expected = body.expected_head;
        const currentHead = state.refs[branch];
        if (expected !== undefined && expected !== currentHead) return jsonError("Head changed", 409);
        const restored = structuredClone(commit.entries);
        const metadata = validateMetadata(body.metadata ?? {
          agent_role: "repository-restore", user_goal: `Restore ${commit.oid}`,
          task_id: String(body.task_id ?? "restore"), rationale: `Restored repository content from ${commit.oid}`,
          thread_id: String(body.thread_id ?? "repository"), tool_turn_id: String(body.tool_turn_id ?? crypto.randomUUID()),
        });
        const hierarchy = await encodeTreeHierarchy(restored);
        await Promise.all(hierarchy.objects.map((object) => this.putObject(scope, object.oid, object.bytes)));
        const createdAt = new Date().toISOString();
        const message = String(body.message ?? `Restore ${commit.oid}`).slice(0, 10_000);
        const encoded = await encodeGitObject("commit", commitBody(hierarchy.root.oid, currentHead ?? undefined, message, metadata, createdAt));
        await this.putObject(scope, encoded.oid, encoded.bytes);
        state.worktrees[branch] = restored;
        state.commits[encoded.oid] = {
          oid: encoded.oid, tree: hierarchy.root.oid, ...(currentHead ? { parent: currentHead, parents: [currentHead] } : {}),
          message, metadata, createdAt, entries: structuredClone(restored),
        };
        state.refs[branch] = encoded.oid;
        await this.save(state);
        return Response.json({ branch, commit_id: encoded.oid, restored_from: commit.oid, parent: currentHead ?? null }, { status: 201 });
      }
      if (op === "history" && request.method === "GET") {
        let currentOid =
          url.searchParams.get("at") ?? state.refs[branch] ?? undefined;
        const commits = [];
        while (currentOid && state.commits[currentOid]) {
          const rec = state.commits[currentOid]!;
          commits.push(rec);
          currentOid = rec.parent;
        }
        return Response.json({ data: commits, count: commits.length });
      }
      if (op === "blame" && request.method === "GET") {
        const path = normalizePath(url.searchParams.get("path") ?? "");
        let currentOid =
          url.searchParams.get("at") ?? state.refs[branch] ?? undefined;
        const history = [];
        while (currentOid && state.commits[currentOid]) {
          const rec = state.commits[currentOid]!;
          const parentOid = rec.parent
            ? state.commits[rec.parent]?.entries[path]?.oid
            : undefined;
          const currentFileOid = rec.entries[path]?.oid;
          if (currentFileOid && currentFileOid !== parentOid) {
            history.push({
              oid: rec.oid,
              message: rec.message,
              metadata: rec.metadata,
              createdAt: rec.createdAt,
            });
          }
          currentOid = rec.parent;
        }
        if (history.length === 0)
          return jsonError("File not found in history", 404);
        const tip = this.resolve(state, url.searchParams.get("at") ?? branch);
        const tipEntry = tip ? state.commits[tip]?.entries[path] : undefined;
        const lines = (await this.blobText(scope, tipEntry)).split("\n");
        const blame = [];
        for (let index = 0; index < lines.length; index++) {
          let oid = tip!;
          let owner = state.commits[oid]!;
          while (owner.parent) {
            const parent = state.commits[owner.parent]!;
            const currentLines = (
              await this.blobText(scope, owner.entries[path])
            ).split("\n");
            const parentLines = (
              await this.blobText(scope, parent.entries[path])
            ).split("\n");
            if (currentLines[index] !== parentLines[index]) break;
            owner = parent;
            oid = parent.oid;
          }
          blame.push({
            line: index + 1,
            content: lines[index],
            commit_oid: oid,
            author: owner.metadata.agent_role,
            metadata: owner.metadata,
            createdAt: owner.createdAt,
          });
        }
        return Response.json({
          path,
          latest: history[0],
          history,
          lines: blame,
        });
      }
      if (op === "head" && request.method === "GET") {
        return Response.json({
          branch: state.head,
          commit_id: state.refs[state.head],
        });
      }
      if (op === "cleanup" && request.method === "POST") {
        const names = body.branch
          ? [String(body.branch)]
          : [...state.temporary];
        for (const name of names) {
          if (state.temporary.includes(name) && name !== state.head) {
            delete state.refs[name];
            delete state.worktrees[name];
            state.temporary = state.temporary.filter((v) => v !== name);
          }
        }
        await this.save(state);
        return Response.json({
          deleted: names.filter((n) => !(n in state.refs)),
        });
      }
      if (op === "gc" && request.method === "POST") {
        return Response.json(await this.collectUnreachableObjects(scope, state));
      }
      return jsonError("Route not found", 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid request";
      const status = message.startsWith("workspace_publication_conflict:") ? 409
        : message.startsWith("workspace_publication_interrupted:") ? 503
        : /workspace_publication_|integrity check failed|object missing|malformed tree|reachable commit metadata missing/i.test(message) ? 500 : 400;
      return jsonError(message, status);
    }
  }
}
