import { DurableObject } from "cloudflare:workers";
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
      sql.exec(
        "CREATE TABLE IF NOT EXISTS repository_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)"
      );
      const row = sql
        .exec("SELECT json FROM repository_state WHERE id = 1")
        .one() as { json?: SqlStorageValue } | null;
      return typeof row?.json === "string"
        ? (JSON.parse(row.json) as RepoState)
        : structuredClone(EMPTY);
    }
    return (
      (await this.ctx.storage.get<RepoState>("repository")) ??
      structuredClone(EMPTY)
    );
  }
  private async save(state: RepoState): Promise<void> {
    const sql = (
      this.ctx.storage as DurableObjectStorage & { sql?: SqlStorage }
    ).sql;
    if (sql) {
      sql.exec(
        "INSERT INTO repository_state (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        JSON.stringify(state)
      );
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
    if (!(await this.env.REPOSITORY_OBJECTS.head(key)))
      await this.env.REPOSITORY_OBJECTS.put(key, bytes, {
        customMetadata: { oid },
      });
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
    const object = await this.env.REPOSITORY_OBJECTS.get(
      objectKey(scope, entry.oid)
    );
    if (!object) throw new Error(`Object missing: ${entry.oid}`);
    const envelope = new Uint8Array(await object.arrayBuffer());
    const separator = envelope.indexOf(0);
    return new TextDecoder().decode(envelope.slice(separator + 1));
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
          return {
            path,
            status: !a[path] ? "added" : !b[path] ? "deleted" : "modified",
            additions,
            deletions,
            patch,
            before: a[path]?.oid,
            after: b[path]?.oid,
          };
        })
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") return this.handle(request);
    // Keep the state read, expected-hash comparison, immutable object write and ref/state update
    // inside one Durable Object input gate. This is the SQLite equivalent of an atomic CAS.
    return typeof this.ctx.blockConcurrencyWhile === "function"
      ? this.ctx.blockConcurrencyWhile(() => this.handle(request))
      : this.handle(request);
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const scope = this.scope(request);
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
      const body =
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
      const branch = String(
        body.branch ?? url.searchParams.get("branch") ?? state.head
      );
      if (!(branch in state.refs)) return jsonError("Branch not found", 404);

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
        const object = await this.env.REPOSITORY_OBJECTS.get(
          objectKey(scope, entry.oid)
        );
        if (!object) return jsonError("Object missing", 500);
        const envelope = new Uint8Array(await object.arrayBuffer());
        const separator = envelope.indexOf(0);
        return new Response(envelope.slice(separator + 1), {
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
        const object = await this.env.REPOSITORY_OBJECTS.get(
          objectKey(scope, oid)
        );
        if (!object) return jsonError("Object missing", 500);
        const envelope = new Uint8Array(await object.arrayBuffer());
        const separator = envelope.indexOf(0);
        if (separator < 0) return jsonError("Invalid object envelope", 500);
        return new Response(envelope.slice(separator + 1), {
          headers: {
            "content-type": "application/octet-stream",
            "x-git-oid": oid,
          },
        });
      }
      if (op === "write" && request.method === "PUT") {
        const path = normalizePath(String(body.path ?? ""));
        const bytes =
          typeof body.content_base64 === "string"
            ? Uint8Array.from(atob(body.content_base64), (char) =>
                char.charCodeAt(0)
              )
            : new TextEncoder().encode(String(body.content ?? ""));
        const current = state.worktrees[branch]![path];
        if (body.expected_hash !== undefined && current?.hash !== body.expected_hash) {
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
        if (!state.worktrees[branch]![path])
          return jsonError("File not found", 404);
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
        const expected = body.expected_head;
        if (expected !== undefined && expected !== state.refs[branch])
          return jsonError("Head changed", 409);
        const metadata = validateMetadata(body.metadata);
        const changes = Array.isArray(body.changes)
          ? (body.changes as Array<Record<string, unknown>>)
          : [];
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
          if (change.expected_hash !== undefined && current?.hash !== change.expected_hash)
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
        await this.save(state);
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
          type: "inline_pull_request", id: crypto.randomUUID(), title: String(body.title ?? `Merge ${forkName} into ${baseName}`),
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
        state.refs[targetName] = encoded.oid; state.worktrees[targetName] = rebased; await this.save(state);
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
        if (!target || this.ancestors(state, source).has(target)) {
          if (body.expected_head !== undefined && body.expected_head !== target)
            return jsonError("Head changed", 409);
          state.refs[targetName] = source;
          state.worktrees[targetName] = structuredClone(
            state.commits[source]!.entries
          );
          await this.save(state);
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
        await this.save(state);
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
        state.worktrees[branch] = structuredClone(commit.entries);
        state.refs[branch] = commit.oid;
        await this.save(state);
        return Response.json({ branch, commit_id: commit.oid });
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
      return jsonError("Route not found", 404);
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Invalid request"
      );
    }
  }
}
