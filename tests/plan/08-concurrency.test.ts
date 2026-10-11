import { describe, expect, it, vi } from "vitest";
import { deleteBytesCas, putBytesCas, readBytesWithHash } from "../../workers/agents/src/script-engine/r2-cas.js";
import { r2Workspace } from "../../workers/agents/src/script-engine/prebuilt/r2-workspace.js";
import { workspace } from "../../workers/agents/src/script-engine/prebuilt/workspace.js";
import { ConcurrencyDO } from "../../workers/agents/src/do/ConcurrencyDO.js";
import { RepositoryDO } from "../../workers/artifact/src/RepositoryDO.js";
import { Hono } from "hono";
import { registerProjectMcpRoutes } from "../../workers/spaces/src/routes/mcp.js";

type Stored = { bytes: Uint8Array; etag: string; customMetadata: Record<string, string> };

function casBucket() {
  const objects = new Map<string, Stored>();
  const writes: string[] = [];
  let serial = 0;
  const bucket = {
    async head(key: string) {
      const item = objects.get(key);
      return item ? { key, etag: item.etag, size: item.bytes.byteLength, customMetadata: item.customMetadata } : null;
    },
    async get(key: string) {
      const item = objects.get(key);
      return item ? {
        key, etag: item.etag, size: item.bytes.byteLength, customMetadata: item.customMetadata,
        arrayBuffer: async () => item.bytes.slice().buffer as ArrayBuffer,
        text: async () => new TextDecoder().decode(item.bytes),
      } : null;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView, options: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }; customMetadata?: Record<string, string> } = {}) {
      const previous = objects.get(key);
      if (options.onlyIf?.etagMatches && previous?.etag !== options.onlyIf.etagMatches) return null;
      if (options.onlyIf?.etagDoesNotMatch === "*" && previous) return null;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const etag = `rev-${++serial}`;
      writes.push(key);
      objects.set(key, { bytes: bytes.slice(), etag, customMetadata: options.customMetadata ?? {} });
      return { etag };
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      const selected = [...objects].filter(([key]) => key.startsWith(prefix));
      return { objects: selected.map(([key, value]) => ({ key, size: value.bytes.byteLength, customMetadata: value.customMetadata })), truncated: false };
    },
  } as unknown as R2Bucket;
  return { bucket, objects, writes };
}

function concurrencyFixture(bucket: R2Bucket) {
  const locks = new Map<string, { holder_id: string; expires_at: number; fencing_token: number; acquired_at: number }>();
  const fences = new Map<string, number>();
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
      let rowsWritten = 0;
      if (normalized.startsWith("insert into lock_fences")) fences.set(String(args[0]), Number(args[1]));
      else if (normalized.startsWith("insert into locks")) {
        locks.set(String(args[0]), { holder_id: String(args[1]), acquired_at: Number(args[2]), expires_at: Number(args[3]), fencing_token: Number(args[4]) });
        rowsWritten = 1;
      } else if (normalized.startsWith("update locks set expires_at")) {
        const row = locks.get(String(args[1]));
        if (row?.holder_id === args[2] && row.fencing_token === Number(args[3]) && row.expires_at > Number(args[4])) {
          row.expires_at = Number(args[0]); rowsWritten = 1;
        }
      } else if (normalized.startsWith("delete from locks where key = ? and holder_id = ? and fencing_token = ?")) {
        const row = locks.get(String(args[0]));
        if (row?.holder_id === args[1] && row.fencing_token === Number(args[2])) locks.delete(String(args[0]));
      }
      const toArray = () => {
        if (normalized.includes("from locks where key")) {
          const row = locks.get(String(args[0])); return row ? [{ holder_id: row.holder_id, expires_at: row.expires_at, fencing_token: row.fencing_token }] : [];
        }
        if (normalized.includes("from lock_fences where key")) {
          const fencing_token = fences.get(String(args[0])); return fencing_token === undefined ? [] : [{ fencing_token }];
        }
        return [];
      };
      return { rowsWritten, toArray };
    },
  };
  let alarm: number | null = null;
  const storage = {
    sql,
    getAlarm: async () => alarm,
    setAlarm: async (value: number) => { alarm = value; },
    deleteAlarm: async () => { alarm = null; },
  };
  const ctx = { storage, blockConcurrencyWhile: (fn: () => Promise<Response>) => fn() };
  return new ConcurrencyDO(ctx as never, { SCRIPTS_R2: bucket } as never);
}

describe("Step 08 versioned workspace publication", () => {
  it("allows exactly one writer at an observed revision; the other receives a conflict", async () => {
    const { bucket } = casBucket();
    await putBytesCas(bucket, "workspace/doc.md", new TextEncoder().encode("base"), null);
    const revision = await readBytesWithHash(bucket, "workspace/doc.md");
    const writers = await Promise.allSettled([
      putBytesCas(bucket, "workspace/doc.md", new TextEncoder().encode("human"), revision!.hash),
      putBytesCas(bucket, "workspace/doc.md", new TextEncoder().encode("worker"), revision!.hash),
    ]);
    expect(writers.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(writers.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await readBytesWithHash(bucket, "workspace/doc.md")).not.toBeNull();
  });

  it("does not expose a tombstoned delete when a materialized view is replayed", async () => {
    const { bucket } = casBucket();
    const key = "spaces/s/projects/p/workspace/obsolete.txt";
    const initial = await putBytesCas(bucket, key, new TextEncoder().encode("obsolete"), null);
    expect(await deleteBytesCas(bucket, key, initial.hash)).toMatchObject({ deleted: true });
    expect(await readBytesWithHash(bucket, key)).toBeNull();
    const listing = await bucket.list({ prefix: "spaces/s/projects/p/workspace/" });
    expect(listing.objects.filter((item) => item.customMetadata?.deleted !== "true")).toEqual([]);
  });

  it("routes the specialized workspace writer through the same expected-hash boundary", async () => {
    const { bucket } = casBucket();
    const ctx = { env: { scriptsBucket: bucket, spaceId: "s", projectId: "p", agentId: "a", tenantId: "t" } };
    const write = r2Workspace.operations.write_file!;
    await expect(write({ path: "same.txt", content: "without revision" }, ctx as never)).rejects.toThrow("expectedHash");
    await expect(write({ path: "same.txt", content: "stale", expectedHash: "0".repeat(64) }, ctx as never)).rejects.toThrow("Conflict Error");
    const created = await write({ path: "same.txt", content: "current", expectedHash: null }, ctx as never) as { hash: string };
    await expect(write({ path: "same.txt", content: "overwrite", expectedHash: created.hash }, ctx as never)).resolves.toMatchObject({ ok: true });
  });

  it("keeps concurrent specialized MCP patches from replacing the same observed revision", async () => {
    const { bucket } = casBucket();
    const key = "spaces/s/projects/p/workspace/readme.md";
    await putBytesCas(bucket, key, new TextEncoder().encode("before"), null);
    const app = new Hono<{ Bindings: { SCRIPTS_R2: R2Bucket } }>();
    registerProjectMcpRoutes(app, async () => null);
    const invoke = () => app.request("/spaces/s/projects/p/mcp", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "patch", method: "tools/call", params: { name: "runAstPatch", arguments: { path: "readme.md", oldText: "before", newText: "after" } } }),
    }, { SCRIPTS_R2: bucket });
    const responses = await Promise.all([invoke(), invoke()]);
    const outcomes = await Promise.all(responses.map((response) => response.json() as Promise<{ result?: { content?: Array<{ text: string }> } }>));
    expect(outcomes.filter((outcome) => outcome.result?.content?.[0]?.text.includes('"patched":true'))).toHaveLength(1);
    expect(await (await readBytesWithHash(bucket, key))?.bytes).toEqual(new TextEncoder().encode("after"));
  });

  it("rejects a crashed lease holder after expiry and a newer fencing token wins", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    try {
      const { bucket } = casBucket();
      const durableObject = concurrencyFixture(bucket);
      const lockKey = "workspace-file:spaces/s/projects/p/workspace/a.txt";
      const post = (path: string, body: unknown) => durableObject.fetch(new Request(`https://do${path}`, { method: "POST", body: JSON.stringify(body) }));
      const first = await (await post("/locks/acquire", { key: lockKey, holderId: "human" })).json<{ fencingToken: number }>();
      vi.advanceTimersByTime(30_001);
      const next = await (await post("/locks/acquire", { key: lockKey, holderId: "worker" })).json<{ fencingToken: number }>();
      expect(next.fencingToken).toBeGreaterThan(first.fencingToken);
      const payload = { key: lockKey, path: "spaces/s/projects/p/workspace/a.txt", operation: "write", expectedHash: null, contentBase64: btoa("stale") };
      const stale = await post("/workspace/publish", { ...payload, holderId: "human", fencingToken: first.fencingToken });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error_code: "lease_lost" });
      const current = await post("/workspace/publish", { ...payload, holderId: "worker", fencingToken: next.fencingToken, contentBase64: btoa("current") });
      expect(current.status).toBe(200);
      expect((await readBytesWithHash(bucket, "spaces/s/projects/p/workspace/a.txt"))?.bytes).toEqual(new TextEncoder().encode("current"));
    } finally { vi.useRealTimers(); }
  });

  it("syncs multiple files in a deterministic order so concurrent syncs cannot deadlock", async () => {
    const { bucket, writes } = casBucket();
    const ctx = { env: {
      scriptsBucket: bucket, spaceId: "s", projectId: "p", agentId: "a", tenantId: "t",
      containerWorkspace: { read: async () => ({ files: { "z.txt": "z", "a.txt": "a", "m.txt": "m" } }) },
    } };
    await workspace.operations["workspace.sync_from_container"]!({}, ctx as never);
    expect(writes.map((key) => key.split("/").at(-1))).toEqual(["a.txt", "m.txt", "z.txt"]);
  });

  it("replays canonical workspace revisions into the Git projection after a DO restart", async () => {
    const workspaceStore = casBucket();
    const repositoryObjects = casBucket();
    const storage = new Map<string, unknown>();
    const ctx = {
      storage: { get: async (key: string) => storage.get(key), put: async (key: string, value: unknown) => { storage.set(key, value); } },
      blockConcurrencyWhile: (fn: () => Promise<Response>) => fn(),
    };
    const env = { REPOSITORY_OBJECTS: repositoryObjects.bucket, WORKSPACE_R2: workspaceStore.bucket };
    const scope = { tenantId: "tenant", spaceId: "s", projectId: "p" };
    const headers = { "x-repository-scope": JSON.stringify(scope) };
    const repo = new RepositoryDO(ctx as never, env as never);
    const request = (op: string, method = "GET", body?: unknown) => repo.fetch(new Request(`https://repo/${op}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    await request("init", "POST");
    const path = "spaces/s/projects/p/workspace/replay.txt";
    await putBytesCas(workspaceStore.bucket, path, new TextEncoder().encode("first revision"), null);
    const metadata = { agent_role: "workspace", user_goal: "reconcile crash state", task_id: "task-replay", rationale: "reconcile", thread_id: "thread-replay", tool_turn_id: "turn-replay-1" };
    const first = await request("reconcile", "POST", { metadata });
    expect(first.status).toBe(200);
    expect(await (await first.json()).changed).toBe(1);
    await deleteBytesCas(workspaceStore.bucket, path, (await readBytesWithHash(workspaceStore.bucket, path))!.hash);
    const second = await request("reconcile", "POST", { metadata: { ...metadata, tool_turn_id: "turn-replay-2" } });
    expect(second.status).toBe(200);
    const restarted = new RepositoryDO(ctx as never, env as never);
    const replayed = await restarted.fetch(new Request("https://repo/tree", { headers }));
    expect((await replayed.json() as { data: Array<{ path: string }> }).data.map((entry) => entry.path)).not.toContain("replay.txt");
  });
});
