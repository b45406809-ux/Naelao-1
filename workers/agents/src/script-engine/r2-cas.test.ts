import { describe, expect, it, vi } from "vitest";
import { deleteWorkspaceBytesCas, publishWorkspaceBytesCas, putTextCas, readBytesWithHash, readTextWithHash, R2CasConflictError, sha256Text } from "./r2-cas.js";

type Entry = { text: string; etag: string; customMetadata?: Record<string, string> };

function fakeBucket(initial: Record<string, Entry> = {}) {
  const entries = new Map(Object.entries(initial));
  let sequence = 0;
  return {
    entries,
    head: async (key: string) => {
      const entry = entries.get(key);
      return entry ? { etag: entry.etag, customMetadata: entry.customMetadata, size: entry.text.length } : null;
    },
    get: async (key: string) => {
      const entry = entries.get(key);
      return entry ? { text: async () => entry.text, arrayBuffer: async () => new TextEncoder().encode(entry.text).buffer } : null;
    },
    put: async (key: string, body: string | Uint8Array, options: Record<string, any>) => {
      const current = entries.get(key);
      if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
      if (options.onlyIf?.etagDoesNotMatch === "*" && current) return null;
      const etag = `e${++sequence}`;
      entries.set(key, { text: typeof body === "string" ? body : new TextDecoder().decode(body), etag, customMetadata: options.customMetadata });
      return { etag };
    },
  } as unknown as R2Bucket;
}

describe("shared R2 compare-and-swap", () => {
  it("requires the caller's observed hash and writes metadata atomically", async () => {
    const bucket = fakeBucket();
    await expect(putTextCas(bucket, "journal", "first", null)).resolves.toEqual({ hash: await sha256Text("first") });
    const read = await readTextWithHash(bucket, "journal");
    expect(read?.text).toBe("first");
    await expect(putTextCas(bucket, "journal", "second", "stale")).rejects.toBeInstanceOf(R2CasConflictError);
    await expect(putTextCas(bucket, "journal", "second", read!.hash)).resolves.toEqual({ hash: await sha256Text("second") });
  });

  it("hashes legacy objects without metadata before accepting an upgrade", async () => {
    const bucket = fakeBucket({ legacy: { text: "old", etag: "legacy-etag" } });
    const observed = await readTextWithHash(bucket, "legacy");
    expect(observed?.hash).toBe(await sha256Text("old"));
    await expect(putTextCas(bucket, "legacy", "new", observed!.hash)).resolves.toEqual({ hash: await sha256Text("new") });
    expect((await bucket.head("legacy"))?.customMetadata?.sha256).toBe(await sha256Text("new"));
  });

  it("rejects an oversized R2 object from head metadata before downloading its body", async () => {
    const get = vi.fn(async () => null);
    const bucket = { head: async () => ({ size: 100, etag: "large" }), get } as unknown as R2Bucket;
    await expect(readBytesWithHash(bucket, "large", 10)).rejects.toThrow("r2_object_too_large");
    expect(get).not.toHaveBeenCalled();
  });

  it("validates workspace bytes before taking a lease or writing R2", async () => {
    const bucket = fakeBucket();
    let leaseRequested = false;
    await expect(publishWorkspaceBytesCas({
      runId: "run-1",
      validateWorkspaceMutation: async ({ key, bytes }) => {
        expect(key).toBe("workspace.json");
        expect(new TextDecoder().decode(bytes)).toBe('{"invalid":true}');
        throw new Error("human_intervention_required");
      },
      lockGateway: { acquire: async () => { leaseRequested = true; throw new Error("must not lease invalid bytes"); }, publishWorkspace: async () => ({}), release: async () => {} },
    }, bucket, "workspace.json", new TextEncoder().encode('{"invalid":true}'), null)).rejects.toThrow("human_intervention_required");
    expect(leaseRequested).toBe(false);
    expect(await bucket.head("workspace.json")).toBeNull();
  });

  it("routes isolated branch writes and deletes through the checked publisher", async () => {
    const bucket = fakeBucket();
    const publishWorkspaceChecked = vi.fn(async ({ bytes }: { bytes: Uint8Array | null }) => ({
      hash: bytes ? await sha256Text(new TextDecoder().decode(bytes)) : null,
      revision: 4,
      deleted: bytes === null,
    }));
    const env = { spaceId: "s", projectId: "p", workspaceManifestRead: async () => ({}), publishWorkspaceChecked };
    const key = "spaces/s/projects/p/workspace/branches/workers/agent-1/report.txt";
    const written = await publishWorkspaceBytesCas(env, bucket, key, new TextEncoder().encode("checked"), null);
    expect(written).toEqual({ hash: await sha256Text("checked"), etag: "revision:4" });
    expect(publishWorkspaceChecked).toHaveBeenLastCalledWith({ key, bytes: new TextEncoder().encode("checked"), expectedHash: null });
    await expect(deleteWorkspaceBytesCas(env, bucket, key, written.hash)).resolves.toEqual({ deleted: true, etag: "revision:4" });
    expect(publishWorkspaceChecked).toHaveBeenLastCalledWith({ key, bytes: null, expectedHash: written.hash });
    expect(bucket.entries.size).toBe(0);
  });

  it("fails closed when a legacy project-workspace writer has no mutation barrier", async () => {
    const bucket = fakeBucket();
    const env = { spaceId: "s", projectId: "p" };
    const key = "spaces/s/projects/p/workspace/branches/workers/agent-1/report.txt";
    const bytes = new TextEncoder().encode("legacy");

    await expect(publishWorkspaceBytesCas(env, bucket, key, bytes, null))
      .rejects.toThrow("workspace_project_mutation_barrier_unavailable");
    await expect(deleteWorkspaceBytesCas(env, bucket, key, null))
      .rejects.toThrow("workspace_project_mutation_barrier_unavailable");
    expect(bucket.entries.size).toBe(0);
  });

  it("rejects a project workspace key outside the writer's authorized scope", async () => {
    const bucket = fakeBucket();
    const publishWorkspaceChecked = vi.fn(async () => ({ hash: "a".repeat(64), revision: 1, deleted: false }));
    const env = { spaceId: "s", projectId: "p", publishWorkspaceChecked };
    const key = "spaces/s/projects/other/workspace/file.txt";

    await expect(publishWorkspaceBytesCas(env, bucket, key, new TextEncoder().encode("cross-project"), null))
      .rejects.toThrow("workspace_project_scope_mismatch");
    expect(publishWorkspaceChecked).not.toHaveBeenCalled();
    expect(bucket.entries.size).toBe(0);
  });

  it("holds the project mutation barrier around a legacy workspace CAS", async () => {
    const bucket = fakeBucket();
    const calls: string[] = [];
    const env = {
      spaceId: "s", projectId: "p",
      withProjectWorkspaceMutation: async <T>(operation: () => Promise<T>) => {
        calls.push("acquire");
        try { return await operation(); }
        finally { calls.push("release"); }
      },
    };
    const key = "spaces/s/projects/p/workspace/branches/workers/agent-1/report.txt";

    await publishWorkspaceBytesCas(env, bucket, key, new TextEncoder().encode("legacy"), null);
    expect(calls).toEqual(["acquire", "release"]);
    expect(bucket.entries.has(key)).toBe(true);
  });
});
