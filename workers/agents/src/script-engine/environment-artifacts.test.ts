import { describe, expect, it } from "vitest";
import { publishEnvironmentArtifact, publishEnvironmentArtifactBytes, readEnvironmentArtifact, restoreEnvironmentArtifact } from "./environment-artifacts.js";
import { workspacePrefix, type ScriptEngineEnv } from "./types.js";
function fixture() {
  const entries = new Map<string, { bytes: Uint8Array; etag: string; customMetadata: Record<string, string> }>();
  let sequence = 0;
  const bucket = {
    head: async (key: string) => { const e = entries.get(key); return e ? { ...e, size: e.bytes.length } : null; },
    get: async (key: string) => { const e = entries.get(key); return e ? { ...e, size: e.bytes.length, arrayBuffer: async () => e.bytes.buffer } : null; },
    put: async (key: string, bytes: Uint8Array, options: { onlyIf?: { etagDoesNotMatch?: string; etagMatches?: string }; customMetadata?: Record<string, string> }) => {
      const current = entries.get(key);
      if (options.onlyIf?.etagDoesNotMatch === "*" && current || options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
      const etag = String(++sequence); entries.set(key, { bytes, etag, customMetadata: options.customMetadata ?? {} }); return { etag };
    },
  } as unknown as R2Bucket;
  const env = { tenantId: "tenant", spaceId: "space", projectId: "project", agentId: "worker", scriptsBucket: bucket } as ScriptEngineEnv;
  const prefix = workspacePrefix(env);
  entries.set(prefix + "source.txt", { bytes: new TextEncoder().encode("input"), etag: "original", customMetadata: {} });
  return { env, entries, prefix };
}
describe("immutable environment handoffs", () => {
  it("publishes idempotently and restores only at the observed destination revision", async () => {
    const f = fixture();
    const artifact = await publishEnvironmentArtifact(f.env, "source.txt");
    expect(await publishEnvironmentArtifact(f.env, "source.txt")).toEqual(artifact);
    expect(await restoreEnvironmentArtifact(f.env, artifact.digest, "result.txt", null)).toMatchObject({ restored: true });
    await expect(restoreEnvironmentArtifact(f.env, artifact.digest, "result.txt", null)).rejects.toThrow("changed concurrently");
    expect(await restoreEnvironmentArtifact(f.env, artifact.digest, "result.txt", artifact.digest)).toMatchObject({ restored: true });
  });
  it("rejects tampered artifacts and cross-project references", async () => {
    const f = fixture(), artifact = await publishEnvironmentArtifact(f.env, "source.txt");
    await expect(restoreEnvironmentArtifact({ ...f.env, projectId: "other" }, artifact.digest, "result.txt", null)).rejects.toThrow("integrity");
    const key = f.prefix + ".environment-artifacts/" + artifact.digest;
    f.entries.get(key)!.bytes = new TextEncoder().encode("tampered");
    await expect(restoreEnvironmentArtifact(f.env, artifact.digest, "result.txt", null)).rejects.toThrow("integrity");
  });
  it("preserves delegated file boundaries and rejects oversized payloads", async () => {
    const f = fixture();
    await expect(publishEnvironmentArtifact({ ...f.env, workspaceFileScope: ["different.txt"] }, "source.txt")).rejects.toThrow("scope_denied");
    f.entries.get(f.prefix + "source.txt")!.bytes = new Uint8Array(16 * 1024 * 1024 + 1);
    await expect(publishEnvironmentArtifact(f.env, "source.txt")).rejects.toThrow("too_large");
    await expect(publishEnvironmentArtifact(f.env, "../secret")).rejects.toThrow();
  });
  it("stores bounded machine bytes immutably and verifies them on read", async () => {
    const f = fixture(), bytes = new Uint8Array([0, 255, 1, 128]);
    const artifact = await publishEnvironmentArtifactBytes(f.env, bytes, "machine:pc:/home/user/data.bin");
    expect(artifact).toMatchObject({ bytes: 4, immutable: true });
    expect((await readEnvironmentArtifact(f.env, artifact.digest)).bytes).toEqual(bytes);
    const large = new Uint8Array(2 * 1024 * 1024 + 9);
    const largeArtifact = await publishEnvironmentArtifactBytes(f.env, large, "machine:pc:/home/user/large.bin");
    expect((await readEnvironmentArtifact(f.env, largeArtifact.digest)).bytes.byteLength).toBe(large.byteLength);
    await expect(publishEnvironmentArtifactBytes(f.env, new Uint8Array(16 * 1024 * 1024 + 1), "oversized")).rejects.toThrow("too_large");
    await expect(readEnvironmentArtifact({ ...f.env, projectId: "other" }, artifact.digest)).rejects.toThrow("integrity");
  });
});
