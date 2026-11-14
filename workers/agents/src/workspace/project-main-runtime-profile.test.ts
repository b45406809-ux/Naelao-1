import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { readProjectMainRuntimeProfile, readProjectMainRuntimeStatus, saveProjectMainRuntimeProfile } from "./project-main-runtime-profile.js";

const db = () => createFakeD1([
  readFileSync(new URL("../../../../infra/migrations/0081_workflow_budget_reservations.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../../../../infra/migrations/0189_project_main_runtime_registry.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../../../../infra/migrations/0197_project_main_runtime_allocation_tokens.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../../../../infra/migrations/0198_project_main_runtime_profiles.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../../../../infra/migrations/0249_project_main_runtime_budget_reservations.sql", import.meta.url), "utf8"),
]);
const scope = { tenantId: "tenant", spaceId: "space", projectId: "project" };

describe("project main runtime profile preference", () => {
  it("stores audited versioned preferences and exposes only plan-allowed Cloudflare sizes", async () => {
    const fixture = db();
    expect(await readProjectMainRuntimeProfile(fixture, scope, "free", undefined)).toMatchObject({
      profile: "standard-1", source: "deployment_default", version: 0,
      allowedProfiles: ["lite", "standard-1"],
    });
    await expect(saveProjectMainRuntimeProfile(fixture, scope, "free", {
      profile: "standard-2", expectedVersion: 0, actorId: "owner",
    })).rejects.toThrow("project_main_runtime_profile_plan_limit");
    await expect(saveProjectMainRuntimeProfile(fixture, scope, "free", {
      profile: "lite", expectedVersion: 0, actorId: "owner",
    }, new Date("2026-11-11T12:00:00.000Z"))).resolves.toEqual({ profile: "lite", version: 1, changed: true });
    expect(await fixture.prepare("SELECT previous_profile,new_profile,version,actor_id FROM project_main_runtime_profile_audit").first())
      .toEqual({ previous_profile: null, new_profile: "lite", version: 1, actor_id: "owner" });
    await expect(saveProjectMainRuntimeProfile(fixture, scope, "free", {
      profile: "standard-1", expectedVersion: 0, actorId: "owner",
    })).rejects.toThrow("project_main_runtime_profile_version_conflict");
    await expect(saveProjectMainRuntimeProfile(fixture, scope, "free", {
      profile: "standard-1", expectedVersion: 1, actorId: "owner",
    })).resolves.toMatchObject({ profile: "standard-1", version: 2, changed: true });
    expect(await readProjectMainRuntimeProfile(fixture, scope, "free", "standard-2")).toMatchObject({
      profile: "standard-1", source: "project", version: 2,
      allowedProfiles: ["lite", "standard-1"],
    });
    expect(await fixture.prepare("SELECT COUNT(*) AS count FROM project_main_runtime_profile_audit").first())
      .toEqual({ count: 2 });
  });

  it("does not create audit noise when the requested profile already matches", async () => {
    const fixture = db();
    await expect(saveProjectMainRuntimeProfile(fixture, scope, "free", {
      profile: "standard-1", expectedVersion: 0, actorId: "owner",
    })).resolves.toEqual({ profile: "standard-1", version: 1, changed: true });
    await expect(saveProjectMainRuntimeProfile(fixture, scope, "free", {
      profile: "standard-1", expectedVersion: 1, actorId: "owner",
    })).resolves.toEqual({ profile: "standard-1", version: 1, changed: false });
    expect(await fixture.prepare("SELECT COUNT(*) AS count FROM project_main_runtime_profile_audit").first())
      .toEqual({ count: 1 });
  });

  it("returns only the scoped persisted runtime state and labels it as non-live health evidence", async () => {
    const fixture = db();
    expect(await readProjectMainRuntimeStatus(fixture, scope)).toBeNull();
    await fixture.prepare(`INSERT INTO project_main_runtime_registry
      (tenant_id,space_id,project_id,runtime_kind,runtime_object_name,allocation_generation,fencing_token,active_branch,state,last_seen_at,budget_reservation_id)
      VALUES(?, ?, ?, 'dynamic_sandbox', ?, ?, ?, ?, ?, ?, ?)`)
      .bind("tenant", "space", "project", "sandbox:space:project", 4, 2, "main", "recovery_required", "2026-11-12T12:00:00.000Z", "container:reservation-a").run();
    await fixture.prepare(`INSERT INTO workflow_budget_reservations
      (id,org_id,space_id,workflow_id,budget_key,credits,status,expires_at) VALUES(?,?,?,?,?,?,?,?)`)
      .bind("container:reservation-a", "tenant", "space", "container:reservation-a", "container:space:project", 20, "held", "2026-11-12T12:10:00.000Z").run();

    await expect(readProjectMainRuntimeStatus(fixture, scope)).resolves.toEqual({
      state: "recovery_required", allocationGeneration: 4, lastSeenAt: "2026-11-12T12:00:00.000Z",
      source: "control_plane_registry", liveHealthVerified: false,
      budgetReservation: { status: "expired", expiresAt: "2026-11-12T12:10:00.000Z" },
    });
    await fixture.prepare("UPDATE workflow_budget_reservations SET expires_at='2099-01-01T00:00:00.000Z' WHERE id=?")
      .bind("container:reservation-a").run();
    await expect(readProjectMainRuntimeStatus(fixture, scope)).resolves.toMatchObject({
      budgetReservation: { status: "held", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    await expect(readProjectMainRuntimeStatus(fixture, { ...scope, projectId: "other-project" })).resolves.toBeNull();
  });
});
