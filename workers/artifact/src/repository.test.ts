import { describe, expect, it, vi } from "vitest";
import { RepositoryDO } from "./RepositoryDO.js";
import {
  commitBody,
  encodeGitObject,
  objectKey,
  normalizePath,
  repositoryName,
  validateMetadata,
  parseCommitMetadata,
} from "./repository.js";

const metadata = {
  agent_role: "builder",
  user_goal: "ship it",
  task_id: "task-1",
  rationale: "implemented feature",
  thread_id: "thread-1",
  tool_turn_id: "turn-1",
};
async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("repository scoping", () => {
  it("isolates tenant, space and project namespaces", () => {
    const a = { tenantId: "tenant-a", spaceId: "space", projectId: "project" };
    const b = { tenantId: "tenant-b", spaceId: "space", projectId: "project" };
    expect(repositoryName(a)).not.toBe(repositoryName(b));
    expect(objectKey(a, "a".repeat(40))).not.toBe(objectKey(b, "a".repeat(40)));
  });

  it("rejects path-like scope components", () => {
    expect(() =>
      repositoryName({ tenantId: "../other", spaceId: "s", projectId: "p" })
    ).toThrow();
  });

  it("rejects agent machinery and traversal as deliverables", () => {
    expect(() => normalizePath(".avos/bin/private.ts")).toThrow(
      "Invalid repository path"
    );
    expect(() => normalizePath("workspace/../../.avos/key")).toThrow(
      "Invalid repository path"
    );
  });
});

describe("Git object and metadata encoding", () => {
  it("matches Git's known empty blob id", async () => {
    expect((await encodeGitObject("blob", new Uint8Array())).oid).toBe(
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
    );
  });

  it("round-trips structured agent metadata in a commit body", () => {
    const valid = validateMetadata(metadata);
    const text = new TextDecoder().decode(
      commitBody(
        "a".repeat(40),
        undefined,
        "message",
        valid,
        "2026-01-01T00:00:00.000Z"
      )
    );
    expect(text).toContain('--AVOS-METADATA--\nauthor: "builder"');
    expect(parseCommitMetadata(text)).toEqual(metadata);
  });

  it("requires every rollback audit field", () => {
    expect(() => validateMetadata({ ...metadata, tool_turn_id: "" })).toThrow(
      "metadata.tool_turn_id"
    );
  });

  it("supports turn-by-turn commits, zero-copy micro-forking, and reasoning blame", async () => {
    const storage = new Map<string, unknown>();
    const objects = new Map<string, Uint8Array>();
    const mockCtx = {
      storage: {
        get: async (k: string) => storage.get(k),
        put: async (k: string, v: unknown) => {
          storage.set(k, v);
        },
      },
    };
    const mockEnv = {
      REPOSITORY_OBJECTS: {
        head: async (k: string) => objects.has(k),
        put: async (k: string, v: Uint8Array) => {
          objects.set(k, v);
        },
        get: async (k: string) => ({
          arrayBuffer: async () => objects.get(k)!.buffer,
        }),
      },
    };

    const repo = new RepositoryDO(mockCtx as never, mockEnv as never);
    const scopeHeaders = {
      "x-repository-scope": JSON.stringify({
        tenantId: "t1",
        spaceId: "s1",
        projectId: "p1",
      }),
    };

    await repo.fetch(
      new Request("https://repo/init", {
        method: "POST",
        headers: scopeHeaders,
      })
    );
    await repo.fetch(
      new Request("https://repo/write", {
        method: "PUT",
        headers: scopeHeaders,
        body: JSON.stringify({ path: "README.md", content: "v1", expected_hash: null }),
      })
    );
    await repo.fetch(new Request("https://repo/write", {
      method: "PUT", headers: scopeHeaders,
      body: JSON.stringify({ path: "forecast.csv", content: "month,revenue\nJan,100", expected_hash: null }),
    }));
    await repo.fetch(new Request("https://repo/write", {
      method: "PUT", headers: scopeHeaders,
      body: JSON.stringify({ path: "contract.docx", content_base64: btoa("docx-v1"), expected_hash: null }),
    }));
    const c1Res = await repo.fetch(
      new Request("https://repo/commit", {
        method: "POST",
        headers: scopeHeaders,
        body: JSON.stringify({ metadata, expected_head: null }),
      })
    );
    const c1 = (await c1Res.json()) as { commit_id: string };

    // Zero-copy fork
    const forkRes = await repo.fetch(
      new Request("https://repo/branch", {
        method: "POST",
        headers: scopeHeaders,
        body: JSON.stringify({ name: "scratchpad-1", from: c1.commit_id }),
      })
    );
    expect(forkRes.status).toBe(201);

    await repo.fetch(
      new Request("https://repo/write", {
        method: "PUT",
        headers: scopeHeaders,
        body: JSON.stringify({
          branch: "scratchpad-1",
          path: "README.md",
          content: "v2\nnew line",
          expected_hash: await sha256Text("v1"),
        }),
      })
    );
    await repo.fetch(new Request("https://repo/write", {
      method: "PUT", headers: scopeHeaders,
      body: JSON.stringify({ branch: "scratchpad-1", path: "forecast.csv", content: "month,revenue\nJan,125", expected_hash: await sha256Text("month,revenue\nJan,100") }),
    }));
    await repo.fetch(new Request("https://repo/write", {
      method: "PUT", headers: scopeHeaders,
      body: JSON.stringify({ branch: "scratchpad-1", path: "contract.docx", content_base64: btoa("docx-v2"), expected_hash: await sha256Text("docx-v1") }),
    }));
    const forkCommitRes = await repo.fetch(
      new Request("https://repo/commit", {
        method: "POST",
        headers: scopeHeaders,
        body: JSON.stringify({
          branch: "scratchpad-1",
          expected_head: c1.commit_id,
          message: "experiment",
          metadata: { ...metadata, tool_turn_id: "turn-2" },
        }),
      })
    );
    const forkCommit = (await forkCommitRes.json()) as { commit_id: string };
    const headRes = await repo.fetch(
      new Request("https://repo/head", { headers: scopeHeaders })
    );
    expect(((await headRes.json()) as { commit_id: string }).commit_id).toBe(
      c1.commit_id
    );
    const compareRes = await repo.fetch(
      new Request("https://repo/compare?baseRef=main&headRef=scratchpad-1", {
        headers: scopeHeaders,
      })
    );
    const comparison = (await compareRes.json()) as {
      ahead: number;
      behind: number;
      files: Array<{ path: string; additions: number; patch: string; presentation: Record<string, unknown> }>;
    };
    expect(comparison.ahead).toBe(1);
    expect(comparison.behind).toBe(0);
    expect(comparison.files.find((file) => file.path === "README.md")?.patch).toContain("+new line");
    expect(comparison.files.find((file) => file.path === "forecast.csv")?.presentation).toMatchObject({
      kind: "spreadsheet", binaryWorkbook: false,
      cellDeltas: [{ cell: "B2", before: "100", after: "125" }],
    });
    expect(comparison.files.find((file) => file.path === "contract.docx")?.presentation).toMatchObject({
      kind: "document", binaryDocument: true,
    });

    // A fresh instance (as after DO eviction) reads refs/commits from durable storage.
    const restarted = new RepositoryDO(mockCtx as never, mockEnv as never);
    const persisted = await restarted.fetch(
      new Request(`https://repo/getCommit?oid=${forkCommit.commit_id}`, {
        headers: scopeHeaders,
      })
    );
    expect(persisted.status).toBe(200);

    // Blame
    const blameRes = await repo.fetch(
      new Request("https://repo/blame?path=README.md", {
        method: "GET",
        headers: scopeHeaders,
      })
    );
    const blame = (await blameRes.json()) as {
      latest: { metadata: typeof metadata };
    };
    expect(blame.latest.metadata.rationale).toBe("implemented feature");

    // Rollback
    await repo.fetch(
      new Request("https://repo/write", {
        method: "PUT",
        headers: scopeHeaders,
        body: JSON.stringify({ path: "README.md", content: "v2", expected_hash: await sha256Text("v1") }),
      })
    );
    const rollbackResponse = await repo.fetch(
      new Request("https://repo/rollback", {
        method: "POST",
        headers: scopeHeaders,
        body: JSON.stringify({ commit_id: c1.commit_id }),
      })
    );
    const rollback = await rollbackResponse.json() as { commit_id: string; restored_from: string };
    expect(rollback).toMatchObject({ restored_from: c1.commit_id });
    const treeRes = await repo.fetch(
      new Request("https://repo/tree", { method: "GET", headers: scopeHeaders })
    );
    expect(
      ((await treeRes.json()) as { data: Array<{ path: string }> }).data[0]
        ?.path
    ).toBe("README.md");
    const treePayload = (await (
      await repo.fetch(
        new Request(`https://repo/tree?at=${c1.commit_id}`, {
          headers: scopeHeaders,
        })
      )
    ).json()) as { data: Array<Record<string, unknown>> };
    expect(treePayload.data[0]).toEqual(
      expect.objectContaining({ path: "README.md", size: 2, hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    );
    expect(treePayload.data[0]).not.toHaveProperty("content");
    const oid = String(treePayload.data[0]?.oid);
    const objectRes = await repo.fetch(
      new Request(`https://repo/object/${oid}?at=${c1.commit_id}`, {
        headers: scopeHeaders,
      })
    );
    expect(objectRes.headers.get("x-git-oid")).toBe(oid);
    expect(await objectRes.text()).toBe("v1");
    expect(
      (
        await repo.fetch(
          new Request(
            `https://repo/object/${"a".repeat(40)}?at=${c1.commit_id}`,
            { headers: scopeHeaders }
          )
        )
      ).status
    ).toBe(404);

    const changed = new TextEncoder().encode("from-container");
    const sha256 = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", changed)),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const writeback = await repo.fetch(
      new Request("https://repo/commit", {
        method: "POST",
        headers: scopeHeaders,
        body: JSON.stringify({
          expected_head: rollback.commit_id,
          message: "container writeback",
          metadata: { ...metadata, tool_turn_id: "turn-writeback" },
          changes: [
            {
              path: "result.txt",
              oid: sha256,
              content_base64: btoa("from-container"),
              expected_hash: null,
            },
          ],
        }),
      })
    );
    expect(writeback.status, await writeback.clone().text()).toBe(201);
    const writebackTree = await repo.fetch(
      new Request("https://repo/tree", { headers: scopeHeaders })
    );
    expect(
      (
        (await writebackTree.json()) as { data: Array<{ path: string }> }
      ).data.map((entry) => entry.path)
    ).toContain("result.txt");
    const stale = await repo.fetch(
      new Request("https://repo/commit", {
        method: "POST",
        headers: scopeHeaders,
        body: JSON.stringify({
          expected_head: c1.commit_id,
          metadata,
          changes: [],
        }),
      })
    );
    expect(stale.status).toBe(409);

    const staleWrite = await repo.fetch(new Request("https://repo/write", {
      method: "PUT", headers: scopeHeaders,
      body: JSON.stringify({ path: "README.md", content: "clobber", expected_hash: "0".repeat(64) }),
    }));
    expect(staleWrite.status).toBe(409);
    expect(await staleWrite.text()).toContain("Re-read before applying patch");

    const prDiff = await repo.fetch(new Request(
      "https://repo/generatePullRequestDiff?baseBranch=main&forkBranch=scratchpad-1",
      { headers: scopeHeaders },
    ));
    const pr = await prDiff.json() as { additions: number; deletions: number; files: Array<{ patch: string }> };
    expect(pr.additions).toBeGreaterThan(0);
    expect(pr.deletions).toBeGreaterThan(0);
    expect(pr.files[0]?.patch).toContain("+++ b/");

    const divergence = await repo.fetch(new Request(
      "https://repo/getDivergenceStatus?baseRef=main&currentRef=scratchpad-1",
      { headers: scopeHeaders },
    ));
    expect((await divergence.json() as { commitsBehind: number }).commitsBehind).toBeGreaterThan(0);

    const rebase = await repo.fetch(new Request("https://repo/reconcileUpstream", {
      method: "POST", headers: scopeHeaders,
      body: JSON.stringify({ targetBranch: "scratchpad-1" }),
    }));
    expect(await rebase.json()).toEqual(expect.objectContaining({ status: "AUTO_REBASED", overlappingFiles: [] }));

    const forbiddenMerge = await repo.fetch(new Request("https://repo/mergePullRequest", {
      method: "POST", headers: scopeHeaders,
      body: JSON.stringify({ baseBranch: "main", forkBranch: "scratchpad-1", reviewerId: "viewer", reviewerRank: "member" }),
    }));
    expect(forbiddenMerge.status).toBe(403);
    const merged = await repo.fetch(new Request("https://repo/mergePullRequest", {
      method: "POST", headers: scopeHeaders,
      body: JSON.stringify({ baseBranch: "main", forkBranch: "scratchpad-1", reviewerId: "owner", reviewerRank: "owner" }),
    }));
    expect(await merged.json()).toEqual(expect.objectContaining({ fast_forward: true, event: expect.objectContaining({ type: "workspace.merged" }) }));
  });
});

describe("unified workspace transition guards", () => {
  it("fails closed when the coordinator binding is missing in unified mode", async () => {
    const storage = new Map<string, unknown>();
    const repositoryObjects = new Map<string, Uint8Array>();
    const workspacePut = vi.fn(async () => ({ etag: "workspace-etag" }));
    const repo = new RepositoryDO({ storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => { storage.set(key, value); },
    } } as never, {
      UNIFIED_WORKSPACE_ENABLED: "true",
      REPOSITORY_OBJECTS: {
        head: async (key: string) => repositoryObjects.has(key),
        put: async (key: string, value: Uint8Array | string) => { repositoryObjects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value); },
        get: async (key: string) => { const bytes = repositoryObjects.get(key); return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null; },
        list: async () => ({ objects: [], truncated: false }),
        delete: async () => {},
      } as unknown as R2Bucket,
      WORKSPACE_R2: { put: workspacePut, head: async () => null, get: async () => null, list: async () => ({ objects: [], truncated: false }) } as unknown as R2Bucket,
    } as never);
    const headers = { "content-type": "application/json", "x-repository-scope": JSON.stringify({ tenantId: "tenant", spaceId: "space", projectId: "project" }) };
    expect((await repo.fetch(new Request("http://repo/init", { method: "POST", headers }))).status).toBe(200);
    const reconcile = await repo.fetch(new Request("http://repo/reconcile", { method: "POST", headers, body: JSON.stringify({ branch: "main" }) }));
    expect(reconcile.status).toBe(503);
    const commit = await repo.fetch(new Request("http://repo/commit", { method: "POST", headers, body: JSON.stringify({
      branch: "main", expected_head: null, metadata, message: "disabled legacy publication",
      changes: [{ path: "README.md", content_base64: btoa("hello"), expected_hash: null }],
    }) }));
    expect(commit.status).toBe(503);
    expect(await commit.json()).toMatchObject({ error: "workspace_publication_requires_coordinator_binding" });
    expect(workspacePut).not.toHaveBeenCalled();
  });

  it("publishes a Git commit as one checked coordinator revision", async () => {
    const storage = new Map<string, unknown>();
    const repositoryObjects = new Map<string, Uint8Array>();
    const published: unknown[] = [];
    const repo = new RepositoryDO({ storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => { storage.set(key, value); },
    } } as never, {
      UNIFIED_WORKSPACE_ENABLED: "true", PLATFORM_SECRET: "platform-secret",
      WORKSPACE_COORDINATOR: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          if (path === "/v1/receipt") return Response.json({ error_code: "publication_not_found" }, { status: 404 });
          if (path === "/v1/head") return Response.json({ head: { revision: 1 } });
          if (path === "/v1/branch") return Response.json({ branch: { branch: "workers/child", revision: 1 }, created: true });
          if (path === "/v1/open") return Response.json({ session: { id: "ws_123e4567-e89b-12d3-a456-426614174000", fence: 4, allocationGeneration: 1 }, head: { revision: 1 } });
          if (path === "/v1/stage") { published.push(await request.clone().json()); return Response.json({ stageId: "staged" }); }
          if (path === "/v1/checkpoint") return Response.json({ publication: { status: "published", revision: 2 } });
          if (path === "/v1/close") return Response.json({ closed: true });
          return Response.json({ error_code: "not_found" }, { status: 404 });
        } }),
      },
      REPOSITORY_OBJECTS: {
        head: async (key: string) => repositoryObjects.has(key),
        put: async (key: string, value: Uint8Array | string) => { repositoryObjects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value); },
        get: async (key: string) => { const bytes = repositoryObjects.get(key); return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null; },
        list: async () => ({ objects: [], truncated: false }), delete: async () => {},
      } as unknown as R2Bucket,
      WORKSPACE_R2: {} as R2Bucket,
    } as never);
    const headers = { "content-type": "application/json", "x-repository-scope": JSON.stringify({ tenantId: "tenant", spaceId: "space", projectId: "project" }) };
    await repo.fetch(new Request("http://repo/init", { method: "POST", headers }));
    const commit = await repo.fetch(new Request("http://repo/commit", { method: "POST", headers, body: JSON.stringify({
      branch: "main", expected_head: null, metadata, message: "checked Git publication",
      changes: [{ path: "README.md", content_base64: btoa("hello"), expected_hash: null }],
    }) }));
    expect(commit.status).toBe(201);
    const canonicalCommit = await commit.json() as { commit_id: string; workspace_branch: string; workspace_revision: number };
    expect(canonicalCommit).toMatchObject({ workspace_branch: "main", workspace_revision: 2 });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ changes: [{ path: "README.md", expectedHash: null, contentBase64: btoa("hello") }] });
    const branch = await repo.fetch(new Request("http://repo/branch", { method: "POST", headers, body: JSON.stringify({ name: "workers/child", from: "main", temporary: true }) }));
    expect(branch.status).toBe(201);
    const seeded = await branch.json() as { branch: string; commit_id: string; workspace_revision: number };
    expect(seeded).toMatchObject({ branch: "workers/child", workspace_branch: "workers/child", workspace_revision: 1 });
    const workerCommit = await repo.fetch(new Request("http://repo/commit", { method: "POST", headers, body: JSON.stringify({
      branch: "workers/child", expected_head: seeded.commit_id, metadata, message: "worker result",
      changes: [{ path: "worker.txt", content_base64: btoa("subagent result"), expected_hash: null }],
    }) }));
    expect(workerCommit.status).toBe(201);
    const merged = await repo.fetch(new Request("http://repo/merge", { method: "POST", headers, body: JSON.stringify({
      target: "main", source: "workers/child", expected_head: canonicalCommit.commit_id, metadata,
    }) }));
    expect(merged.status).toBe(200);
    const mergeResult = await merged.json() as { commit_id: string };
    expect(mergeResult).toMatchObject({ fast_forward: true, workspace_branch: "main", workspace_revision: 2 });
    expect(published.at(-1)).toMatchObject({ changes: [{ path: "worker.txt", expectedHash: null }] });

    const rollback = await repo.fetch(new Request("http://repo/rollback", { method: "POST", headers, body: JSON.stringify({
      commit_id: canonicalCommit.commit_id, expected_head: mergeResult.commit_id, metadata,
    }) }));
    expect(rollback.status).toBe(201);
    expect(await rollback.json()).toMatchObject({ restored_from: canonicalCommit.commit_id, workspace_branch: "main", workspace_revision: 2 });
    expect(published.at(-1)).toMatchObject({ changes: [{ path: "worker.txt", expectedHash: await sha256Text("subagent result"), contentBase64: null }] });
  });

  it("reconciles Git from one verified coordinator snapshot without republishing canonical files", async () => {
    const storage = new Map<string, unknown>();
    const repositoryObjects = new Map<string, Uint8Array>();
    const file = new TextEncoder().encode("from manifest");
    const hash = await sha256Text("from manifest");
    const calls: string[] = [];
    const workspaceList = vi.fn(async () => ({ objects: [], truncated: false }));
    const repo = new RepositoryDO({ storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => { storage.set(key, value); },
    } } as never, {
      UNIFIED_WORKSPACE_ENABLED: "true", PLATFORM_SECRET: "platform-secret",
      WORKSPACE_DUAL_READ_ENABLED: "true",
      WORKSPACE_R2: {
        get: async (key: string) => key.endsWith(`/content/${hash}`) ? { size: file.byteLength, arrayBuffer: async () => file.slice().buffer } : null,
        list: workspaceList,
      } as unknown as R2Bucket,
      WORKSPACE_COORDINATOR: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          calls.push(path);
          if (path === "/v1/read") return Response.json({ head: { branch: "main", revision: 7 }, entries: [{ path: "notes/status.md", sha256: hash, size: file.byteLength, objectKey: `workspace-v1/tenant/space/project/global/content/${hash}` }] });
          if (path === "/v1/head") return Response.json({ head: { revision: 7 } });
          return Response.json({ error_code: "unexpected_coordinator_write" }, { status: 500 });
        } }),
      },
      REPOSITORY_OBJECTS: {
        head: async (key: string) => repositoryObjects.has(key),
        put: async (key: string, value: Uint8Array | string) => { repositoryObjects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value); },
        get: async (key: string) => { const bytes = repositoryObjects.get(key); return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null; },
        list: async () => ({ objects: [], truncated: false }), delete: async () => {},
      } as unknown as R2Bucket,
    } as never);
    const headers = { "content-type": "application/json", "x-repository-scope": JSON.stringify({ tenantId: "tenant", spaceId: "space", projectId: "project" }) };
    await repo.fetch(new Request("http://repo/init", { method: "POST", headers }));
    const reconciled = await repo.fetch(new Request("http://repo/reconcile", { method: "POST", headers, body: JSON.stringify({ branch: "main", metadata }) }));
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({ reconciled: true, changed: 1, workspace_branch: "main", workspace_revision: 7 });
    expect(calls).toEqual(["/v1/read", "/v1/head"]);
    expect(workspaceList).not.toHaveBeenCalled();

    const saved = storage.get("repository") as { worktrees: Record<string, Record<string, { hash: string; size: number; path: string; oid: string }>> };
    saved.worktrees.main!["notes/status.md"]!.hash = "f".repeat(64);
    storage.set("repository", saved);
    const drift = await repo.fetch(new Request("http://repo/verify-workspace?branch=main", { headers }));
    expect(await drift.json()).toMatchObject({ verified: false, workspace_dual_read: { mismatchCount: 1, mismatchClasses: ["hash_mismatch"] } });
    const repaired = await repo.fetch(new Request("http://repo/reconcile", { method: "POST", headers, body: JSON.stringify({ branch: "main", metadata }) }));
    expect(repaired.status).toBe(200);
    const clean = await repo.fetch(new Request("http://repo/verify-workspace?branch=main", { headers }));
    expect(await clean.json()).toMatchObject({ verified: true, workspace_dual_read: { mismatchCount: 0, truncated: false } });
  });
});

describe("large binary object storage", () => {
  it("round-trips a multi-megabyte deliverable through R2 without storing its body in DO state", async () => {
    const storage = new Map<string, unknown>();
    const objects = new Map<string, Uint8Array>();
    const repo = new RepositoryDO({
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => { storage.set(key, value); },
      },
    } as never, {
      REPOSITORY_OBJECTS: {
        head: async (key: string) => objects.has(key),
        put: async (key: string, value: Uint8Array) => { objects.set(key, value); },
        get: async (key: string) => objects.has(key) ? {
          arrayBuffer: async () => objects.get(key)!.buffer,
        } : null,
      },
    } as never);
    const headers = { "x-repository-scope": JSON.stringify({ tenantId: "t", spaceId: "s", projectId: "p" }) };
    await repo.fetch(new Request("https://repo/init", { method: "POST", headers }));

    const bytes = "\u00a5".repeat(2 * 1024 * 1024);
    const write = await repo.fetch(new Request("https://repo/write", {
      method: "PUT",
      headers,
      body: JSON.stringify({ path: "workspace/evidence.bin", content_base64: btoa(bytes), expected_hash: null }),
    }));
    expect(write.status).toBe(200);
    await repo.fetch(new Request("https://repo/commit", {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata, expected_head: null }),
    }));

    const read = await repo.fetch(new Request("https://repo/file?path=workspace/evidence.bin", { headers }));
    expect(new Uint8Array(await read.arrayBuffer())).toHaveLength(bytes.length);
    expect([...objects.values()].some((value) => value.byteLength > 2 * 1024 * 1024)).toBe(true);
    expect(JSON.stringify([...storage.values()]).length).toBeLessThan(100_000);
  }, 15_000);
});
