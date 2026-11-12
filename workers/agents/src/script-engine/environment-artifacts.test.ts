import { describe, expect, it } from "vitest";
import { publishEnvironmentArtifact, publishEnvironmentArtifactBytes, readEnvironmentArtifact, restoreEnvironmentArtifact } from "./environment-artifacts.js";
import { sha256Bytes } from "./r2-cas.js";
import { workspacePrefix, type ScriptEngineEnv } from "./types.js";
function fixture() {
  const entries = new Map<string, { bytes: Uint8Array; etag: string; customMetadata: Record<string, string>; httpMetadata?: { contentType?: string } }>();
  let sequence = 0;
  const bucket = {
    head: async (key: string) => { const e = entries.get(key); return e ? { ...e, size: e.bytes.length } : null; },
    get: async (key: string) => { const e = entries.get(key); return e ? { ...e, size: e.bytes.length, arrayBuffer: async () => e.bytes.buffer } : null; },
    put: async (key: string, bytes: Uint8Array, options: { onlyIf?: { etagDoesNotMatch?: string; etagMatches?: string }; customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }) => {
      const current = entries.get(key);
      if (options.onlyIf?.etagDoesNotMatch === "*" && current || options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
      const etag = String(++sequence); entries.set(key, { bytes, etag, customMetadata: options.customMetadata ?? {}, ...(options.httpMetadata ? { httpMetadata: options.httpMetadata } : {}) }); return { etag };
    },
  } as unknown as R2Bucket;
  const env = { tenantId: "tenant", spaceId: "space", projectId: "project", agentId: "worker", scriptsBucket: bucket,
    withProjectWorkspaceMutation: async <T>(operation: () => Promise<T>) => operation() } as ScriptEngineEnv;
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
    const key = `workspace-artifacts/tenant/space/project/environment/${artifact.digest}`;
    f.entries.get(key)!.bytes = new TextEncoder().encode("tampered");
    await expect(restoreEnvironmentArtifact(f.env, artifact.digest, "result.txt", null)).rejects.toThrow("integrity");
  });
  it("preserves delegated file boundaries and rejects oversized payloads", async () => {
    const f = fixture();
    await expect(publishEnvironmentArtifact({ ...f.env, workspaceFileScope: ["different.txt"] }, "source.txt")).rejects.toThrow("scope_denied");
    f.entries.get(f.prefix + "source.txt")!.bytes = new Uint8Array(16 * 1024 * 1024 + 1);
    await expect(publishEnvironmentArtifact(f.env, "source.txt")).resolves.toMatchObject({ bytes: 16 * 1024 * 1024 + 1 });
    f.entries.get(f.prefix + "source.txt")!.bytes = new Uint8Array(20 * 1024 * 1024 + 1);
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
    await expect(publishEnvironmentArtifactBytes(f.env, new Uint8Array(20 * 1024 * 1024 + 1), "oversized")).rejects.toThrow("too_large");
    await expect(readEnvironmentArtifact({ ...f.env, projectId: "other" }, artifact.digest)).rejects.toThrow("integrity");
  });

  it("reads a legacy workspace-prefixed immutable artifact through the raw bucket fallback", async () => {
    const f = fixture();
    const bytes = new TextEncoder().encode("legacy artifact");
    const digest = await sha256Bytes(bytes);
    f.entries.set(f.prefix + ".environment-artifacts/" + digest, { bytes, etag: "legacy", customMetadata: { sha256: digest } });
    f.env.immutableArtifactBucket = f.env.scriptsBucket;
    await expect(readEnvironmentArtifact(f.env, digest)).resolves.toMatchObject({ hash: digest, bytes });
  });

  it("restores immutable handoffs through checked publication when a branch adapter is present", async () => {
    const f = fixture();
    const artifact = await publishEnvironmentArtifactBytes(f.env, new Uint8Array([0, 1, 255]), "machine:local:file");
    let publication: unknown;
    f.env.publishWorkspaceChecked = async input => {
      publication = input;
      return { hash: artifact.digest, revision: 12, deleted: false };
    };
    await expect(restoreEnvironmentArtifact(f.env, artifact.digest, "restored.bin", null)).resolves.toMatchObject({
      restored: true, path: "restored.bin", digest: artifact.digest, bytes: 3,
    });
    expect(publication).toMatchObject({ key: f.prefix + "restored.bin", expectedHash: null, bytes: new Uint8Array([0, 1, 255]) });
    expect(f.entries.has(f.prefix + "restored.bin")).toBe(false);
  });

  it("preserves canonical MIME through workspace export, immutable artifact read, and checked restore", async () => {
    const f = fixture();
    f.entries.get(f.prefix + "source.txt")!.httpMetadata = { contentType: "application/pdf" };
    const artifact = await publishEnvironmentArtifact(f.env, "source.txt");
    const immutableKey = `workspace-artifacts/tenant/space/project/environment/${artifact.digest}`;
    expect(f.entries.get(immutableKey)?.httpMetadata).toEqual({ contentType: "application/pdf" });
    await expect(readEnvironmentArtifact(f.env, artifact.digest)).resolves.toMatchObject({ contentType: "application/pdf" });

    let checkedPublication: unknown;
    f.env.publishWorkspaceChecked = async (input) => {
      checkedPublication = input;
      return { hash: artifact.digest, revision: 13, deleted: false };
    };
    await restoreEnvironmentArtifact(f.env, artifact.digest, "restored.pdf", null);
    expect(checkedPublication).toMatchObject({ expectedHash: null, contentType: "application/pdf", bytes: new TextEncoder().encode("input") });
  });

  it("exports the committed coordinator manifest object instead of a stale legacy R2 projection", async () => {
    const f = fixture();
    const canonicalBytes = new TextEncoder().encode("committed coordinator revision");
    const canonicalDigest = await sha256Bytes(canonicalBytes);
    const canonicalKey = `workspace-v1/tenant/space/project/global/content/${canonicalDigest}`;
    f.entries.set(canonicalKey, { bytes: canonicalBytes, etag: "canonical", customMetadata: { sha256: canonicalDigest } });
    f.entries.set(f.prefix + "source.txt", { bytes: new TextEncoder().encode("stale legacy file"), etag: "legacy", customMetadata: {} });
    f.env.workspaceManifestRead = async () => ({ head: { branch: "main", revision: 9, updatedAt: "2026-11-11T00:00:00.000Z" },
      entries: [{ path: "source.txt", sha256: canonicalDigest, size: canonicalBytes.byteLength, executable: false, objectKey: canonicalKey, contentType: "application/pdf" }] });

    const artifact = await publishEnvironmentArtifact(f.env, "source.txt");
    await expect(readEnvironmentArtifact(f.env, artifact.digest)).resolves.toMatchObject({ bytes: canonicalBytes, hash: canonicalDigest, contentType: "application/pdf" });
  });
});
