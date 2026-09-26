import { describe, expect, it } from "vitest";
import { RepositoryDO } from "./RepositoryDO.js";
import {
  commitBody,
  encodeGitObject,
  objectKey,
  repositoryName,
  validateMetadata,
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
    expect(JSON.parse(text.split("naelao-metadata ")[1]!.trim())).toEqual(
      metadata
    );
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
  });
});
