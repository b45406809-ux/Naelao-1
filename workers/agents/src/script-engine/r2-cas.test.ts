import { describe, expect, it } from "vitest";
import { putTextCas, readTextWithHash, R2CasConflictError, sha256Text } from "./r2-cas.js";

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
});
