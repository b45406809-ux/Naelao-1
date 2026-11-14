import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { app } from "../index.js";

const secret = "restart-recipes-route-test-secret";

async function fixture(role: "owner" | "admin" | "member" = "owner") {
  const db = createFakeD1([
    `CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL);
     CREATE TABLE org_members(org_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL);`,
    readFileSync(new URL("../../../../infra/migrations/0250_project_main_restart_recipes.sql", import.meta.url), "utf8"),
  ]);
  await db.prepare("INSERT INTO spaces(id,tenant_id) VALUES('space-a','tenant-a')").run();
  await db.prepare("INSERT INTO org_members(org_id,user_id,role) VALUES('tenant-a','user-a',?)").bind(role).run();
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: db,
    SPACES_WORKER: { fetch: async () => Response.json({ project_id: "project-a" }) },
    DYNAMIC_CONTAINERS_ENABLED: "false",
  } as never;
  const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a",
    "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
  return { db, env, headers };
}

describe("project main restart recipe routes", () => {
  it("allows owner/admin configuration, records the actor and reports the execution gate", async () => {
    const f = await fixture("owner");
    const path = "/spaces/space-a/projects/project-a/main-runtime-restart-recipes";
    const read = await app.request(path, { headers: f.headers }, f.env);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ recipes: [], version: 0, executionSupported: false, runtimeEnabled: false });
    const recipes = [{ id: "web", label: "Web", workingDirectory: "apps/web", argv: ["npm", "run", "start"],
      manualVerification: "Check the service health page manually." }];
    const saved = await app.request(path, { method: "PUT", headers: f.headers,
      body: JSON.stringify({ recipes, expected_version: 0 }) }, f.env);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ recipes, version: 1, updatedBy: "user-a", executionSupported: false, runtimeEnabled: false });
    expect(await f.db.prepare("SELECT actor_id FROM project_main_restart_recipe_audit").first())
      .toEqual({ actor_id: "user-a" });
  });

  it("denies member reads and writes before project or recipe data is reached", async () => {
    const f = await fixture("member");
    const path = "/spaces/space-a/projects/project-a/main-runtime-restart-recipes";
    expect((await app.request(path, { headers: f.headers }, f.env)).status).toBe(403);
    expect((await app.request(path, { method: "PUT", headers: f.headers, body: JSON.stringify({ recipes: [], expected_version: 0 }) }, f.env)).status)
      .toBe(403);
    expect(await f.db.prepare("SELECT count(*) AS count FROM project_main_restart_recipe_audit").first()).toEqual({ count: 0 });
  });

  it("rejects malformed input and stale revisions", async () => {
    const f = await fixture("admin");
    const path = "/spaces/space-a/projects/project-a/main-runtime-restart-recipes";
    const malformed = await app.request(path, { method: "PUT", headers: f.headers,
      body: JSON.stringify({ recipes: [{ id: "web", label: "Web", workingDirectory: "../outside", argv: ["npm"], manualVerification: "Check it." }], expected_version: 0 }) }, f.env);
    expect(malformed.status).toBe(400);
    const stale = await app.request(path, { method: "PUT", headers: f.headers,
      body: JSON.stringify({ recipes: [], expected_version: 1 }) }, f.env);
    expect(stale.status).toBe(409);
  });
});
