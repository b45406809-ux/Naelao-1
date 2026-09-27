import { describe, expect, it } from "vitest";
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
        body: JSON.stringify({ path: "README.md", content: "v1" }),
      })
    );
    const c1Res = await repo.fetch(
      new Request("https://repo/commit", {
        method: "POST",
        headers: scopeHeaders,
        body: JSON.stringify({ metadata }),
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
        }),
      })
    );
    const forkCommitRes = await repo.fetch(
      new Request("https://repo/commit", {
        method: "POST",
        headers: scopeHeaders,
        body: JSON.stringify({
          branch: "scratchpad-1",
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
      files: Array<{ additions: number; patch: string }>;
    };
    expect(comparison.ahead).toBe(1);
    expect(comparison.behind).toBe(0);
    expect(comparison.files[0]?.patch).toContain("+new line");

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
        body: JSON.stringify({ path: "README.md", content: "v2" }),
      })
    );
    await repo.fetch(
      new Request("https://repo/rollback", {
        method: "POST",
        headers: scopeHeaders,
        body: JSON.stringify({ commit_id: c1.commit_id }),
      })
    );
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
      expect.objectContaining({ path: "README.md", size: 2 })
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
          expected_head: c1.commit_id,
          message: "container writeback",
          metadata: { ...metadata, tool_turn_id: "turn-writeback" },
          changes: [
            {
              path: "result.txt",
              oid: sha256,
              content_base64: btoa("from-container"),
            },
          ],
        }),
      })
    );
    expect(writeback.status).toBe(201);
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
  });
});
