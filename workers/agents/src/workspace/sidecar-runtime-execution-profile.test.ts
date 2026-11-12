import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { readSidecarRuntimeExecutionProfile, saveSidecarRuntimeExecutionProfile } from "./sidecar-runtime-execution-profile.js";

const db = () => createFakeD1([readFileSync(new URL("../../../../infra/migrations/0199_sidecar_runtime_execution_profiles.sql", import.meta.url), "utf8")]);
const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", installationId: "install", containerId: "container" };

describe("sidecar execution profile", () => {
  it("stores an audited versioned timeout that cannot exceed the approved image limit", async () => {
    const fixture = db();
    expect(await readSidecarRuntimeExecutionProfile(fixture, scope, 40)).toMatchObject({ maxExecutionSeconds: 40, maximumSeconds: 40, version: 0 });
    await expect(saveSidecarRuntimeExecutionProfile(fixture, scope, {
      maxExecutionSeconds: 41, maximumSeconds: 40, expectedVersion: 0, actorId: "owner",
    })).rejects.toThrow("sidecar_runtime_profile_invalid");
    await expect(saveSidecarRuntimeExecutionProfile(fixture, scope, {
      maxExecutionSeconds: 15, maximumSeconds: 40, expectedVersion: 0, actorId: "owner",
    }, new Date("2026-11-11T12:00:00.000Z"))).resolves.toEqual({
      maxExecutionSeconds: 15, maximumSeconds: 40, version: 1, changed: true,
    });
    expect(await fixture.prepare("SELECT previous_max_execution_seconds,new_max_execution_seconds,version,actor_id FROM sidecar_runtime_execution_profile_audit").first())
      .toEqual({ previous_max_execution_seconds: null, new_max_execution_seconds: 15, version: 1, actor_id: "owner" });
    await expect(saveSidecarRuntimeExecutionProfile(fixture, scope, {
      maxExecutionSeconds: 10, maximumSeconds: 40, expectedVersion: 0, actorId: "owner",
    })).rejects.toThrow("sidecar_runtime_profile_version_conflict");
    expect(await readSidecarRuntimeExecutionProfile(fixture, scope, 20)).toMatchObject({ maxExecutionSeconds: 15, maximumSeconds: 20, version: 1 });
  });

  it("does not add audit rows for an unchanged setting", async () => {
    const fixture = db();
    await saveSidecarRuntimeExecutionProfile(fixture, scope, { maxExecutionSeconds: 10, maximumSeconds: 40, expectedVersion: 0, actorId: "owner" });
    await expect(saveSidecarRuntimeExecutionProfile(fixture, scope, { maxExecutionSeconds: 10, maximumSeconds: 40, expectedVersion: 1, actorId: "owner" }))
      .resolves.toEqual({ maxExecutionSeconds: 10, maximumSeconds: 40, version: 1, changed: false });
    expect(await fixture.prepare("SELECT COUNT(*) AS count FROM sidecar_runtime_execution_profile_audit").first()).toEqual({ count: 1 });
  });
});
