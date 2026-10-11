import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryDO } from "../../workers/artifact/src/RepositoryDO.js";
import { encodeGitObject, objectKey, type RepositoryScope } from "../../workers/artifact/src/repository.js";

const scope: RepositoryScope = { tenantId: "tenant-git", spaceId: "space-git", projectId: "project-git" };
const headers = { "x-repository-scope": JSON.stringify(scope) };
const metadata = {
  agent_role: "project-worker", user_goal: "verify durable Git behavior", task_id: "task-git-1",
  rationale: "checkpointed implementation", thread_id: "thread-git-1", tool_turn_id: "turn-git-1",
};
const tempDirs: string[] = [];
afterEach(() => { for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

function durableFixture() {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  const rows = (name: string) => { let value = tables.get(name); if (!value) { value = []; tables.set(name, value); } return value; };
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const statement = query.toLowerCase().replace(/\s+/g, " ").trim();
      const select = (table: string) => ({ toArray: () => [...rows(table)] });
      const insert = (table: string, fields: string[]) => {
        rows(table).push(Object.fromEntries(fields.map((field, index) => [field, args[index]])));
        return { rowsWritten: 1, toArray: () => [] };
      };
      if (statement.startsWith("create table") || statement.startsWith("create index")) return { rowsWritten: 0, toArray: () => [] };
      if (statement.startsWith("delete from ")) { tables.set(statement.split(" ")[2]!, []); return { rowsWritten: 1, toArray: () => [] }; }
      if (statement.startsWith("select initialized, head from repository_meta")) return select("repository_meta");
      if (statement.startsWith("select json from repository_state")) return select("repository_state");
      if (statement.startsWith("select name, target_oid, temporary from repository_refs")) return select("repository_refs");
      if (statement.startsWith("select branch, path, oid, size, hash from repository_worktree_entries")) return select("repository_worktree_entries");
      if (statement.startsWith("select oid, tree_oid, parent_oids, message, metadata_json, created_at from repository_commits")) return select("repository_commits");
      if (statement.startsWith("select commit_oid, path, oid, size, hash from repository_commit_entries")) return select("repository_commit_entries");
      if (statement.startsWith("select name, oid, target from repository_tags")) return select("repository_tags");
      if (statement.startsWith("insert into repository_meta")) { rows("repository_meta").push({ id: 1, initialized: args[0], head: args[1] }); return { rowsWritten: 1, toArray: () => [] }; }
      if (statement.startsWith("insert into repository_refs")) return insert("repository_refs", ["name", "target_oid", "temporary"]);
      if (statement.startsWith("insert into repository_worktree_entries")) return insert("repository_worktree_entries", ["branch", "path", "oid", "size", "hash"]);
      if (statement.startsWith("insert into repository_commits")) return insert("repository_commits", ["oid", "tree_oid", "parent_oids", "message", "metadata_json", "created_at"]);
      if (statement.startsWith("insert into repository_commit_entries")) return insert("repository_commit_entries", ["commit_oid", "path", "oid", "size", "hash"]);
      if (statement.startsWith("insert into repository_tags")) return insert("repository_tags", ["name", "oid", "target"]);
      throw new Error(`Unhandled repository SQL fixture query: ${query}`);
    },
  };
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async head(key: string) { return objects.has(key) ? { key } : null; },
    async put(key: string, value: Uint8Array) { objects.set(key, new Uint8Array(value)); return { key }; },
    async get(key: string) {
      const data = objects.get(key);
      return data ? { arrayBuffer: async () => data.slice().buffer } : null;
    },
    async list(options: { prefix?: string; cursor?: string } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(options.prefix ?? ""));
      const start = options.cursor ? Number(options.cursor) : 0;
      const page = keys.slice(start, start + 1000);
      const truncated = start + page.length < keys.length;
      return { objects: page.map((key) => ({ key, size: objects.get(key)!.length })), truncated, cursor: truncated ? String(start + page.length) : undefined };
    },
    async delete(key: string) { objects.delete(key); },
  };
  const storage = {
    sql,
    transactionSync(fn: () => void) { fn(); },
    get: async () => undefined,
    put: async () => undefined,
  };
  const makeRepo = () => new RepositoryDO({ storage, blockConcurrencyWhile: (fn: () => Promise<Response>) => fn() } as never, { REPOSITORY_OBJECTS: bucket } as never);
  return { makeRepo, objects };
}

async function request(repo: RepositoryDO, operation: string, method = "POST", body?: unknown, query = ""): Promise<Response> {
  return repo.fetch(new Request(`https://repo/${operation}${query}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

function nativeGitHash(gitDir: string, type: string, body: Uint8Array): string {
  const result = spawnSync("git", ["--git-dir", gitDir, "hash-object", "-w", "-t", type, "--stdin"], { input: body });
  if (result.status !== 0) throw new Error(result.stderr.toString("utf8"));
  return result.stdout.toString("utf8").trim();
}

function parseObject(bytes: Uint8Array): { type: string; body: Uint8Array } {
  const nul = bytes.indexOf(0);
  const header = new TextDecoder().decode(bytes.slice(0, nul));
  const separator = header.indexOf(" ");
  return { type: header.slice(0, separator), body: bytes.slice(nul + 1) };
}

describe("Step 07 durable Git mesh", () => {
  it("keeps canonical native-Git objects, branches, binary files and restore history across DO reconstruction", async () => {
    const { makeRepo, objects } = durableFixture();
    const repo = makeRepo();
    expect((await request(repo, "init")).status).toBe(200);
    const binary = Uint8Array.from([0, 255, 1, 2, 128, 13, 10]);
    const firstWrite = await request(repo, "write", "PUT", { path: "src/main.ts", content: "export const value = 1;\n" });
    expect(firstWrite.status, await firstWrite.clone().text()).toBe(200);
    const binaryWrite = await request(repo, "write", "PUT", { path: "assets/raw.bin", content_base64: btoa(String.fromCharCode(...binary)) });
    expect(binaryWrite.status, await binaryWrite.clone().text()).toBe(200);
    const firstResponse = await request(repo, "commit", "POST", { message: "initial", metadata });
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(201);
    const first = await firstResponse.json() as { commit_id: string; tree_id: string };
    const nativeDir = mkdtempSync(join(tmpdir(), "naelao-git-native-")); tempDirs.push(nativeDir);
    const init = spawnSync("git", ["init", "--bare", "--quiet", nativeDir]);
    expect(init.status).toBe(0);

    const nativeObjects = [...objects.entries()].filter(([key]) => key.includes("/objects/"));
    for (const [key, raw] of nativeObjects) {
      const oid = key.slice(key.lastIndexOf("/objects/") + 9).replace("/", "");
      const object = parseObject(raw);
      expect(nativeGitHash(nativeDir, object.type, object.body)).toBe(oid);
    }
    const gitHistory = spawnSync("git", ["--git-dir", nativeDir, "update-ref", "refs/heads/main", first.commit_id]);
    expect(gitHistory.status).toBe(0);
    const nativeLog = spawnSync("git", ["--git-dir", nativeDir, "rev-list", "--reverse", "main"]);
    expect(nativeLog.stdout.toString("utf8").trim().split(/\r?\n/)).toEqual([first.commit_id]);

    const branch = await request(repo, "branch", "POST", { name: "task/restore", from: first.commit_id, temporary: true });
    expect(branch.status).toBe(201);
    await request(repo, "write", "PUT", { branch: "task/restore", path: "src/main.ts", content: "export const value = 2;\n" });
    const secondResponse = await request(repo, "commit", "POST", { branch: "task/restore", message: "update", metadata: { ...metadata, tool_turn_id: "turn-git-2" } });
    const second = await secondResponse.json() as { commit_id: string };
    expect(secondResponse.status).toBe(201);

    const restarted = makeRepo();
    expect((await request(restarted, "commit-object", "GET", undefined, `?oid=${second.commit_id}`)).status).toBe(200);
    const rollback = await request(restarted, "rollback", "POST", { branch: "task/restore", commit_id: first.commit_id, metadata: { ...metadata, tool_turn_id: "turn-restore" } });
    const restored = await rollback.json() as { commit_id: string; restored_from: string; parent: string };
    expect(rollback.status).toBe(201);
    expect(restored).toMatchObject({ restored_from: first.commit_id, parent: second.commit_id });
    expect(await (await request(restarted, "file", "GET", undefined, "?branch=task%2Frestore&path=assets%2Fraw.bin")).arrayBuffer()).toEqual(binary.buffer);
    const history = await (await request(restarted, "history", "GET", undefined, "?branch=task%2Frestore")).json() as { data: Array<{ oid: string; parent?: string }> };
    expect(history.data.map((item) => item.oid)).toEqual([restored.commit_id, second.commit_id, first.commit_id]);
  });

  it("merges disjoint branches and rejects conflicting ref updates without moving the target", async () => {
    const { makeRepo } = durableFixture();
    const repo = makeRepo();
    await request(repo, "init");
    const baseWrite = await request(repo, "write", "PUT", { path: "base.txt", content: "base" }); expect(baseWrite.status, await baseWrite.clone().text()).toBe(200);
    const baseResponse = await request(repo, "commit", "POST", { metadata }); expect(baseResponse.status, await baseResponse.clone().text()).toBe(201); const base = await baseResponse.json() as { commit_id: string };
    const branchResponse = await request(repo, "branch", "POST", { name: "feature", from: base.commit_id }); expect(branchResponse.status, await branchResponse.clone().text()).toBe(201);
    const mainWrite = await request(repo, "write", "PUT", { path: "main.txt", content: "main" }); expect(mainWrite.status, await mainWrite.clone().text()).toBe(200);
    const mainResponse = await request(repo, "commit", "POST", { metadata: { ...metadata, tool_turn_id: "main-turn" } }); expect(mainResponse.status, await mainResponse.clone().text()).toBe(201); const mainCommit = await mainResponse.json() as { commit_id: string };
    const featureWrite = await request(repo, "write", "PUT", { branch: "feature", path: "feature.txt", content: "feature" }); expect(featureWrite.status, await featureWrite.clone().text()).toBe(200);
    const featureCommitResponse = await request(repo, "commit", "POST", { branch: "feature", metadata: { ...metadata, tool_turn_id: "feature-turn" } }); expect(featureCommitResponse.status, await featureCommitResponse.clone().text()).toBe(201);
    const mergedResponse = await request(repo, "merge", "POST", { target: "main", source: "feature", expected_head: mainCommit.commit_id, metadata: { ...metadata, tool_turn_id: "merge-turn" } });
    expect(mergedResponse.status, await mergedResponse.clone().text()).toBe(201);
    const merged = await mergedResponse.json() as { parents: string[] };
    expect(merged.parents).toEqual([mainCommit.commit_id, expect.any(String)]);

    const headBeforeConflict = await (await request(repo, "head", "GET")).json() as { commit_id: string };
    await request(repo, "branch", "POST", { name: "conflict", from: headBeforeConflict.commit_id });
    await request(repo, "write", "PUT", { branch: "conflict", path: "base.txt", content: "branch change" });
    await request(repo, "commit", "POST", { branch: "conflict", metadata: { ...metadata, tool_turn_id: "conflict-turn" } });
    await request(repo, "write", "PUT", { path: "base.txt", content: "main change" });
    const newMain = await (await request(repo, "commit", "POST", { metadata: { ...metadata, tool_turn_id: "main-conflict-turn" } })).json() as { commit_id: string };
    const conflict = await request(repo, "merge", "POST", { target: "main", source: "conflict", expected_head: newMain.commit_id });
    expect(conflict.status).toBe(409);
    expect((await (await request(repo, "head", "GET")).json() as { commit_id: string }).commit_id).toBe(newMain.commit_id);
  });

  it("detects a corrupted R2 object and collects only unreachable objects", async () => {
    const { makeRepo, objects } = durableFixture();
    const repo = makeRepo();
    await request(repo, "init");
    const keptWrite = await request(repo, "write", "PUT", { path: "kept.txt", content: "reachable" }); expect(keptWrite.status, await keptWrite.clone().text()).toBe(200);
    const commitResponse = await request(repo, "commit", "POST", { metadata });
    expect(commitResponse.status, await commitResponse.clone().text()).toBe(201);
    const commit = await commitResponse.json() as { commit_id: string };
    await request(repo, "branch", "POST", { name: "temp/gc", from: commit.commit_id, temporary: true });
    await request(repo, "write", "PUT", { branch: "temp/gc", path: "orphan.bin", content: "unreachable" });
    const orphan = await encodeGitObject("blob", new TextEncoder().encode("dangling"));
    const orphanKey = objectKey(scope, orphan.oid);
    objects.set(orphanKey, orphan.bytes);
    await request(repo, "cleanup", "POST", { branch: "temp/gc" });
    const collected = await request(repo, "gc", "POST", {});
    expect(collected.status).toBe(200);
    expect(await collected.json()).toEqual(expect.objectContaining({ deleted: expect.any(Number) }));
    expect(objects.has(orphanKey)).toBe(false);
    expect(objects.has(objectKey(scope, commit.commit_id))).toBe(true);

    const committedEntries = await (await request(repo, "tree", "GET", undefined, "?at=" + commit.commit_id)).json() as { data: Array<{ oid: string; path: string }> };
    const blobKey = objectKey(scope, committedEntries.data[0]!.oid);
    const original = objects.get(blobKey)!;
    objects.set(blobKey, new Uint8Array([...original.slice(0, -1), original.at(-1)! ^ 1]));
    const corruptRead = await request(repo, "file", "GET", undefined, "?path=kept.txt");
    expect(corruptRead.status).toBe(500);
    expect(await corruptRead.text()).toContain("integrity");
  });
});
