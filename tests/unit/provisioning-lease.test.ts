import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import {
  claimProvisionLease,
  PROVISION_LEASE_TTL_SECONDS,
  releaseProvisionLease,
} from "../../workers/provisioner/src/provisioning-lease.js";

const MIGRATION = readFileSync(
  new URL("../../infra/migrations/0121_space_provisioning_leases.sql", import.meta.url),
  "utf8",
);

describe("provisioning per-Space lease", () => {
  it("admits only one concurrent claim for a tenant/Space", async () => {
    const db = createFakeD1([MIGRATION]);
    const claims = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      claimProvisionLease(db as unknown as D1Database, "space-a", "tenant-a", `lease-${index}`, 1_000_000)
    ));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("keeps a live lease exclusive and permits recovery after expiry", async () => {
    const db = createFakeD1([MIGRATION]);
    const database = db as unknown as D1Database;
    const start = 1_000_000;
    expect(await claimProvisionLease(database, "space-a", "tenant-a", "first", start)).toBe(true);
    expect(await claimProvisionLease(database, "space-a", "tenant-a", "second", start + 60_000)).toBe(false);
    expect(await claimProvisionLease(database, "space-a", "tenant-a", "recovered", start + PROVISION_LEASE_TTL_SECONDS * 1000)).toBe(true);
    expect(await claimProvisionLease(database, "space-a", "tenant-b", "other-tenant", start + PROVISION_LEASE_TTL_SECONDS * 1000)).toBe(false);
  });

  it("releases only the current owner's lease", async () => {
    const db = createFakeD1([MIGRATION]);
    const database = db as unknown as D1Database;
    expect(await claimProvisionLease(database, "space-a", "tenant-a", "owner", 1_000_000)).toBe(true);
    await releaseProvisionLease(database, "space-a", "tenant-a", "stale-owner");
    expect(await claimProvisionLease(database, "space-a", "tenant-a", "blocked", 1_010_000)).toBe(false);
    await releaseProvisionLease(database, "space-a", "tenant-a", "owner");
    expect(await claimProvisionLease(database, "space-a", "tenant-a", "next", 1_010_000)).toBe(true);
  });
});
