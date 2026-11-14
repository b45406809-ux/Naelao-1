import { describe, expect, it, vi } from "vitest";
import { captureSpaceArchiveObjectChunked, decodeSpaceArchive, decodeSpaceArchiveChunkedObjectSnapshot, encodeSpaceArchive, readSpaceArchiveObject, rewrapSpaceArchiveObjectChunks, spaceArchiveKeyringFromBindings, topologicalRestoreOrder, verifySpaceArchiveObjectSnapshots, type SpaceArchivePayload } from "./space-backup.js";

const payload: SpaceArchivePayload = {
  format: "naelao-space-archive", formatVersion: 1,
  tenantId: "tenant-a", spaceId: "space-a", archiveId: "archive-a", createdAt: "2026-10-15T00:00:00.000Z",
  migrationVersion: 73,
  tableRows: { messages: [{ id: "m-1", content: "hello", token_count: null }] },
  rowCounts: { messages: 1 }, objectReferences: [{ key: "spaces/space-a/projects/p1/workspace/a.txt", etag: "etag-a", size: 5 }],
};
const secret = "stable-test-platform-secret-with-at-least-32-characters";

describe("encrypted Space archive envelope", () => {
  it("checks R2 size metadata before materializing an archive and validates fetched bytes", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    await expect(readSpaceArchiveObject({ size: 16 * 1024 * 1024 + 1, arrayBuffer } as never)).rejects.toThrow("archive_size_limit_exceeded");
    expect(arrayBuffer).not.toHaveBeenCalled();
    await expect(readSpaceArchiveObject({ size: 2, arrayBuffer } as never)).rejects.toThrow("archive_size_mismatch");
  });
  it("round-trips authenticated data and records checksum", async () => {
    const encoded = await encodeSpaceArchive(payload, secret);
    expect(new TextDecoder().decode(encoded.bytes)).not.toContain("hello");
    expect(encoded.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(await decodeSpaceArchive(encoded.bytes, secret, { tenantId: "tenant-a", spaceId: "space-a", archiveId: "archive-a" })).toEqual(payload);
  });

  it("writes authenticated v2 object chunks and retains v1 manifest decoding", async () => {
    const scope = { tenantId: "tenant-a", spaceId: "space-a", archiveId: "archive-v2" };
    const key = "spaces/space-a/projects/project-a/workspace/large.bin";
    const original = new Uint8Array(1024 * 1024 + 13);
    for (let index = 0; index < original.length; index++) original[index] = index % 251;
    const stored = new Map<string, Uint8Array>();
    const bucket = {
      async put(chunkKey: string, bytes: Uint8Array) { stored.set(chunkKey, new Uint8Array(bytes)); },
      async get(chunkKey: string) {
        const bytes = stored.get(chunkKey);
        return bytes && { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
      },
    };
    const captured = await captureSpaceArchiveObjectChunked({ etag: "etag-large", size: original.byteLength, arrayBuffer: async () => original.slice().buffer },
      { key, etag: "etag-large", size: original.byteLength }, 0, scope, secret);
    expect(captured.snapshot.chunks).toHaveLength(3);
    for (const chunk of captured.chunks) await bucket.put(chunk.key, chunk.bytes);
    const payloadV2: SpaceArchivePayload = { ...payload, formatVersion: 2, archiveId: scope.archiveId,
      objectReferences: [{ key, etag: "etag-large", size: original.byteLength }], objectSnapshots: [captured.snapshot] };
    const encodedV2 = await encodeSpaceArchive(payloadV2, secret);
    const decodedV2 = await decodeSpaceArchive(encodedV2.bytes, secret, scope);
    await expect(verifySpaceArchiveObjectSnapshots(decodedV2, bucket as never, secret)).resolves.toBeUndefined();
    await expect(decodeSpaceArchiveChunkedObjectSnapshot(captured.snapshot, payloadV2.objectReferences[0]!, scope, bucket as never, secret)).resolves.toEqual(original);
    const newKey = "new-space-archive-key-material-long-enough-2026";
    const rotation = spaceArchiveKeyringFromBindings({ platformSecret: "retired-platform-secret-material-long-enough", activeKey: newKey, activeVersion: "archive-2026-11", previousKey: secret, previousVersion: "archive-2026-10" });
    const rotatedV2 = await rewrapSpaceArchiveObjectChunks(decodedV2, bucket as never, rotation);
    const rotatedBytes = await encodeSpaceArchive(rotatedV2, rotation);
    const rotatedKeyring = spaceArchiveKeyringFromBindings({ platformSecret: "retired-platform-secret-material-long-enough", activeKey: newKey, activeVersion: "archive-2026-11" });
    const rotatedPayload = await decodeSpaceArchive(rotatedBytes.bytes, rotatedKeyring, scope);
    await expect(verifySpaceArchiveObjectSnapshots(rotatedPayload, bucket as never, rotatedKeyring)).resolves.toBeUndefined();
    const activeChunkKey = [...stored.keys()].find(chunkKey => chunkKey.includes(".chunks/archive-2026-11/0/0.enc"))!;
    const tampered = stored.get(activeChunkKey)!.slice(); tampered[tampered.length - 3] ^= 1; stored.set(activeChunkKey, tampered);
    await expect(decodeSpaceArchiveChunkedObjectSnapshot(captured.snapshot, payloadV2.objectReferences[0]!, scope, bucket as never, rotatedKeyring)).rejects.toThrow();

    const encodedV1 = await encodeSpaceArchive(payload, secret);
    await expect(decodeSpaceArchive(encodedV1.bytes, secret, { tenantId: "tenant-a", spaceId: "space-a", archiveId: "archive-a" })).resolves.toEqual(payload);
  }, 30_000);

  it("rejects cross-Space/tenant restore, tampering, and secret rotation without the old key", async () => {
    const encoded = await encodeSpaceArchive(payload, secret);
    await expect(decodeSpaceArchive(encoded.bytes, secret, { tenantId: "tenant-b", spaceId: "space-a", archiveId: "archive-a" })).rejects.toThrow("scope_or_version");
    await expect(decodeSpaceArchive(encoded.bytes, secret, { tenantId: "tenant-a", spaceId: "space-b", archiveId: "archive-a" })).rejects.toThrow("scope_or_version");
    const tampered = encoded.bytes.slice(); tampered[tampered.length - 3] ^= 1;
    await expect(decodeSpaceArchive(tampered, secret, { tenantId: "tenant-a", spaceId: "space-a", archiveId: "archive-a" })).rejects.toThrow();
    await expect(decodeSpaceArchive(encoded.bytes, `${secret}-rotated`, { tenantId: "tenant-a", spaceId: "space-a", archiveId: "archive-a" })).rejects.toThrow();
  });

  it("decrypts both legacy key sources and versioned archives during a rotation window", async () => {
    const oldKey = secret, platformKey = "different-legacy-platform-secret-material-123456", newKey = `${secret}-new`;
    const legacyDedicated = await encodeSpaceArchive(payload, oldKey);
    const legacyPlatform = await encodeSpaceArchive(payload, platformKey);
    const rotation = spaceArchiveKeyringFromBindings({ platformSecret: platformKey, activeKey: newKey, activeVersion: "archive-2026-10", previousKey: oldKey, previousVersion: "archive-2026-04" });
    const current = await encodeSpaceArchive(payload, rotation);
    for (const archive of [legacyDedicated, legacyPlatform, current]) {
      await expect(decodeSpaceArchive(archive.bytes, rotation, { tenantId: "tenant-a", spaceId: "space-a", archiveId: "archive-a" })).resolves.toEqual(payload);
    }
    const retired = spaceArchiveKeyringFromBindings({ platformSecret: platformKey, activeKey: newKey, activeVersion: "archive-2026-10" });
    await expect(decodeSpaceArchive(legacyDedicated.bytes, retired, { tenantId: "tenant-a", spaceId: "space-a", archiveId: "archive-a" })).rejects.toThrow("archive_authentication_failed");
  });

  it("orders foreign-key parents first and identifies cycles for deferred transaction handling", () => {
    expect(topologicalRestoreOrder(["messages", "sessions"], { messages: ["sessions"], sessions: [] })).toEqual(["sessions", "messages"]);
    expect(topologicalRestoreOrder(["a", "b"], { a: ["b"], b: ["a"] })).toBeNull();
  });
});
