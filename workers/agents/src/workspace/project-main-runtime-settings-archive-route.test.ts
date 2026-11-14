import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { app } from "../index.js";
import { saveProjectMainRuntimeProfile } from "./project-main-runtime-profile.js";

const secret = "runtime-settings-archive-route-test-secret";
const scope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a" };

async function fixture() {
  const db = createFakeD1([
    readFileSync(new URL("../../../../infra/migrations/0189_project_main_runtime_registry.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../../../../infra/migrations/0197_project_main_runtime_allocation_tokens.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../../../../infra/migrations/0198_project_main_runtime_profiles.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../../../../infra/migrations/0249_project_main_runtime_budget_reservations.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../../../../infra/migrations/0250_project_main_restart_recipes.sql", import.meta.url), "utf8"),
  ]);
  const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db } as never;
  const headers = { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId,
    "x-naelao-internal-token": await mintInternalToken(secret, scope.tenantId) };
  return { db, env, headers };
}

describe("project main runtime settings archive bridge", () => {
  it("authenticates the internal bridge, enforces exact scope, and exposes preview before restore", async () => {
    const f = await fixture();
    const exportPath = "/internal/workspaces/archive/project-settings/export";
    const restorePath = "/internal/workspaces/archive/project-settings/restore";
    expect(await (await app.request(exportPath, { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId },
      body: JSON.stringify({ scope }) }, f.env)).json()).toEqual({ error_code: "forbidden" });
    const empty = await app.request(exportPath, { method: "POST", headers: f.headers, body: JSON.stringify({ scope }) }, f.env);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ present: false });
    expect((await app.request(exportPath, { method: "POST", headers: f.headers,
      body: JSON.stringify({ scope: { ...scope, jurisdiction: "global" } }) }, f.env)).status).toBe(400);

    const destination = await fixture();
    await saveProjectMainRuntimeProfile(f.db, scope, "pro", { profile: "standard-3", expectedVersion: 0, actorId: "owner-a" });
    const exported = await app.request(exportPath, { method: "POST", headers: f.headers, body: JSON.stringify({ scope }) }, f.env);
    expect(exported.status).toBe(200);
    const snapshot = (await exported.json() as { present: true; snapshot: unknown }).snapshot;
    const preview = await app.request(restorePath, { method: "POST", headers: destination.headers,
      body: JSON.stringify({ mode: "preview", scope, snapshot, actorId: "restore-owner" }) }, destination.env);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ preview: { mainRuntimeProfile: "will_restore", restartRecipes: "not_in_archive" } });

    const wrongScope = { ...scope, projectId: "project-b" };
    const rejected = await app.request(restorePath, { method: "POST", headers: destination.headers,
      body: JSON.stringify({ mode: "restore", scope: wrongScope, snapshot, actorId: "restore-owner" }) }, destination.env);
    expect(rejected.status).toBe(409);
    const restored = await app.request(restorePath, { method: "POST", headers: destination.headers,
      body: JSON.stringify({ mode: "restore", scope, snapshot, actorId: "restore-owner" }) }, destination.env);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ restored: { mainRuntimeProfile: "restored", restartRecipes: "not_in_archive" } });
    expect(await destination.db.prepare("SELECT updated_by,version FROM project_main_runtime_profiles").first())
      .toEqual({ updated_by: "restore-owner", version: 1 });
  });
});
