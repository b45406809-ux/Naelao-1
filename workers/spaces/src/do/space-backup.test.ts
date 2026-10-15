import { describe, expect, it } from "vitest";
import { decodeSpaceArchive, encodeSpaceArchive, topologicalRestoreOrder, type SpaceArchivePayload } from "./space-backup.js";

const payload: SpaceArchivePayload = {
  format: "naelao-space-archive", formatVersion: 1,
  tenantId: "tenant-a", spaceId: "space-a", archiveId: "archive-a", createdAt: "2026-10-15T00:00:00.000Z",
  migrationVersion: 73,
  tableRows: { messages: [{ id: "m-1", content: "hello", token_count: null }] },
  rowCounts: { messages: 1 }, objectReferences: [{ key: "spaces/space-a/projects/p1/workspace/a.txt", etag: "etag-a", size: 5 }],
};
const secret = "stable-test-platform-secret-with-at-least-32-characters";

describe("encrypted Space archive envelope", () => {
  it("round-trips authenticated data and records checksum", async () => {
    const encoded = await encodeSpaceArchive(payload, secret);
    expect(new TextDecoder().decode(encoded.bytes)).not.toContain("hello");
    expect(encoded.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(await decodeSpaceArchive(encoded.bytes, secret, { tenantId: "tenant-a", spaceId: "space-a", archiveId: "archive-a" })).toEqual(payload);
  });

  it("rejects cross-Space/tenant restore, tampering, and secret rotation without the old key", async () => {
    const encoded = await encodeSpaceArchive(payload, secret);
    await expect(decodeSpaceArchive(encoded.bytes, secret, { tenantId: "tenant-b", spaceId: "space-a", archiveId: "archive-a" })).rejects.toThrow("scope_or_version");
    await expect(decodeSpaceArchive(encoded.bytes, secret, { tenantId: "tenant-a", spaceId: "space-b", archiveId: "archive-a" })).rejects.toThrow("scope_or_version");
    const tampered = encoded.bytes.slice(); tampered[tampered.length - 3] ^= 1;
    await expect(decodeSpaceArchive(tampered, secret, { tenantId: "tenant-a", spaceId: "space-a", archiveId: "archive-a" })).rejects.toThrow();
    await expect(decodeSpaceArchive(encoded.bytes, `${secret}-rotated`, { tenantId: "tenant-a", spaceId: "space-a", archiveId: "archive-a" })).rejects.toThrow();
  });

  it("orders foreign-key parents first and identifies cycles for deferred transaction handling", () => {
    expect(topologicalRestoreOrder(["messages", "sessions"], { messages: ["sessions"], sessions: [] })).toEqual(["sessions", "messages"]);
    expect(topologicalRestoreOrder(["a", "b"], { a: ["b"], b: ["a"] })).toBeNull();
  });
});
