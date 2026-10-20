import { describe, expect, it, vi } from "vitest";
import { publishWorkspaceBytesCas, putTextCas, readBytesWithHash, readTextWithHash, R2CasConflictError, sha256Text } from "./r2-cas.js";

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
});
