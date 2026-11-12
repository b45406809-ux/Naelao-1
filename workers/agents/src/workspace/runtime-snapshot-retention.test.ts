import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { readLatestRuntimeSnapshotRetention, recordRuntimeSnapshotRetention, sweepRuntimeSnapshotRetention, updateRuntimeSnapshotRetention } from "./runtime-snapshot-retention.js";

const migration = readFileSync(new URL("../../../../infra/migrations/0206_workspace_runtime_snapshot_retention.sql", import.meta.url), "utf8");
const fixture = () => createFakeD1([migration]);
const record = (overrides: Partial<Parameters<typeof recordRuntimeSnapshotRetention>[1]> = {}) => ({
  tenantId: "tenant", spaceId: "space", projectId: "project", runtimeObjectSha256: "a".repeat(64),
  snapshotHandleSha256: "b".repeat(64), imageSha256: "c".repeat(64), allocationGeneration: 4,
  sizeBytes: 1024, createdAt: Date.parse("2026-11-12T00:00:00.000Z"), expiresAt: Date.parse("2026-12-11T00:00:00.000Z"),
  ...overrides,
});

describe("project runtime snapshot retention inventory", () => {
  it("stores only hashed provider identity and treats exact retries idempotently", async () => {
    const db = fixture();
    await recordRuntimeSnapshotRetention(db, record());
    await recordRuntimeSnapshotRetention(db, record());
    expect(await db.prepare("SELECT count(*) AS count FROM workspace_runtime_snapshot_retention").first())
      .toEqual({ count: 1 });
    const row = await db.prepare("SELECT snapshot_handle_sha256,image_sha256,allocation_generation,size_bytes,state,provider_purge_supported FROM workspace_runtime_snapshot_retention").first();
    expect(row).toEqual({ snapshot_handle_sha256: "b".repeat(64), image_sha256: "c".repeat(64), allocation_generation: 4,
      size_bytes: 1024, state: "retained", provider_purge_supported: 0 });
    await expect(recordRuntimeSnapshotRetention(db, record({ sizeBytes: 2048 })))
      .rejects.toThrow("runtime_snapshot_retention_identity_conflict");
  });

  it("retains an erasure notification until the provider TTL and does not claim physical deletion", async () => {
    const db = fixture();
    await recordRuntimeSnapshotRetention(db, record());
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", runtimeObjectSha256: "a".repeat(64) };
    expect(await updateRuntimeSnapshotRetention(db, scope, "erasure_notified", new Date("2026-11-15T00:00:00.000Z"))).toBe(1);
    expect(await db.prepare("SELECT state,erasure_notified_at,provider_purge_supported FROM workspace_runtime_snapshot_retention").first())
      .toEqual({ state: "erasure_notified", erasure_notified_at: "2026-11-15T00:00:00.000Z", provider_purge_supported: 0 });
    expect(await sweepRuntimeSnapshotRetention(db, new Date("2026-12-12T00:00:00.000Z"))).toBe(1);
    expect(await db.prepare("SELECT state,erasure_notified_at,provider_purge_supported FROM workspace_runtime_snapshot_retention").first())
      .toEqual({ state: "ttl_elapsed_unverified", erasure_notified_at: "2026-11-15T00:00:00.000Z", provider_purge_supported: 0 });
    expect(await sweepRuntimeSnapshotRetention(db, new Date("2026-12-13T00:00:00.000Z"))).toBe(0);
  });

  it("marks a dropped restore pointer without converting it to a provider deletion", async () => {
    const db = fixture();
    await recordRuntimeSnapshotRetention(db, record());
    expect(await updateRuntimeSnapshotRetention(db,
      { tenantId: "tenant", spaceId: "space", projectId: "project", runtimeObjectSha256: "a".repeat(64) },
      "reference_dropped", new Date("2026-11-16T00:00:00.000Z"))).toBe(1);
    expect(await db.prepare("SELECT state,provider_purge_supported FROM workspace_runtime_snapshot_retention").first())
      .toEqual({ state: "reference_dropped", provider_purge_supported: 0 });
  });

  it("exposes the latest owner-scoped retention receipt without a provider handle", async () => {
    const db = fixture();
    expect(await readLatestRuntimeSnapshotRetention(db,{tenantId:"tenant",spaceId:"space",projectId:"project"})).toBeNull();
    await recordRuntimeSnapshotRetention(db, record());
    await updateRuntimeSnapshotRetention(db,
      {tenantId:"tenant",spaceId:"space",projectId:"project",runtimeObjectSha256:"a".repeat(64)},
      "erasure_notified",new Date("2026-11-15T00:00:00.000Z"));
    expect(await readLatestRuntimeSnapshotRetention(db,{tenantId:"tenant",spaceId:"space",projectId:"project"})).toEqual({
      state:"erasure_notified",createdAt:"2026-11-12T00:00:00.000Z",expiresAt:"2026-12-11T00:00:00.000Z",
      erasureNotifiedAt:"2026-11-15T00:00:00.000Z",providerPurgeSupported:false,
    });
  });
});
