import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { app } from "../index.js";

const secret = "private-state-route-test-secret-material";

async function fixture(role: "owner" | "admin" | "member" = "owner", runtimeEnabled = false) {
  const db = createFakeD1([
    `CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL);
     CREATE TABLE org_members(org_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL);`,
    readFileSync(new URL("../../../../infra/migrations/0255_project_main_private_state_recovery.sql", import.meta.url), "utf8"),
  ]);
  await db.prepare("INSERT INTO spaces(id,tenant_id) VALUES('space-a','tenant-a')").run();
  await db.prepare("INSERT INTO org_members(org_id,user_id,role) VALUES('tenant-a','user-a',?)").bind(role).run();
  const forwarded: Request[] = [];
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: db,
    SPACES_WORKER: { fetch: async () => Response.json({ project_id: "project-a" }) },
    DYNAMIC_CONTAINERS_ENABLED: runtimeEnabled ? "true" : "false",
    DYNAMIC_SANDBOX: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
      forwarded.push(request.clone()); return Response.json({ backup: { backupId: "pmsb_test", fileCount: 1 }, encrypted: true });
    } }) },
  } as never;
  const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a",
    "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
  return { db, env, headers, forwarded };
}

describe("project main private-state settings routes", () => {
  it("defaults to no selected files and exposes only the unavailable, default-off backup gate", async () => {
    const f = await fixture();
    const response = await app.request("/spaces/space-a/projects/project-a/main-runtime-private-state", { headers: f.headers }, f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paths: [], version: 0, backupAvailability: { enabled: false,
      reason: "project_main_private_state_backup_disabled" }, runtimeEnabled: false,
      privatePath: ".naelao/private/", providerSnapshotPurgeSupported: false });
  });

  it("saves owner-selected paths with optimistic versioning and denies member access", async () => {
    const owner = await fixture("owner");
    const path = "/spaces/space-a/projects/project-a/main-runtime-private-state";
    const saved = await app.request(path, { method: "PUT", headers: owner.headers,
      body: JSON.stringify({ paths: ["settings/preferences.json"], expected_version: 0 }) }, owner.env);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ paths: ["settings/preferences.json"], version: 1, changed: true });
    const stale = await app.request(path, { method: "PUT", headers: owner.headers,
      body: JSON.stringify({ paths: [], expected_version: 0 }) }, owner.env);
    expect(stale.status).toBe(409);
    expect(await owner.db.prepare("SELECT path_count,actor_id FROM project_main_private_state_manifest_audit").first())
      .toEqual({ path_count: 1, actor_id: "user-a" });

    const member = await fixture("member");
    expect((await app.request(path, { headers: member.headers }, member.env)).status).toBe(403);
    expect((await app.request(path, { method: "PUT", headers: member.headers,
      body: JSON.stringify({ paths: ["settings/other.json"], expected_version: 0 }) }, member.env)).status).toBe(403);
  });

  it("forwards owner capture requests to the stable project main DO with tenant and jurisdiction scope", async () => {
    const f = await fixture("admin", true);
    const response = await app.request("/spaces/space-a/projects/project-a/main-runtime-private-state/backups", {
      method: "POST", headers: f.headers, body: JSON.stringify({ request_id: "request-1", expected_version: 2 }),
    }, f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ encrypted: true });
    expect(f.forwarded).toHaveLength(1);
    expect(new URL(f.forwarded[0]!.url).pathname).toBe("/_internal/private-state");
    expect(await f.forwarded[0]!.json()).toMatchObject({ tenantId: "tenant-a", action: "capture", requestId: "request-1",
      expectedManifestVersion: 2, scope: { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" } });
  });
});
