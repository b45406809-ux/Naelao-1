import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { app } from "../index.js";

const secret = "project-main-runtime-profile-route-test-secret";
const image = `registry.cloudflare.com/${"1".repeat(32)}/media-documents@sha256:${"a".repeat(64)}`;
const undiscoveredImage = `registry.cloudflare.com/${"2".repeat(32)}/not-deployed@sha256:${"b".repeat(64)}`;
const registry = JSON.stringify([
  { image, binding: "TOOL_SANDBOX", schedulingPolicy: "durable_object", networkPolicy: "none", cpuCores: .25, memoryMb: 1024,
    projectRuntime: { id: "media-documents", capabilities: ["media.audio_extract", "media.frame_extract", "document.pdf_render"] } },
  { image: undiscoveredImage, binding: "TOOL_SANDBOX", schedulingPolicy: "durable_object", networkPolicy: "none", cpuCores: .25, memoryMb: 1024,
    projectRuntime: { id: "not-deployed", capabilities: ["media.audio_extract"] } },
]);

async function fixture(role: "owner" | "admin" | "member" = "owner") {
  const db = createFakeD1([
    `CREATE TABLE orgs(id TEXT PRIMARY KEY,plan_tier TEXT NOT NULL);
     CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL);
     CREATE TABLE org_members(org_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL);`,
    readFileSync(new URL("../../../../infra/migrations/0081_workflow_budget_reservations.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../../../../infra/migrations/0189_project_main_runtime_registry.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../../../../infra/migrations/0197_project_main_runtime_allocation_tokens.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../../../../infra/migrations/0198_project_main_runtime_profiles.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../../../../infra/migrations/0206_workspace_runtime_snapshot_retention.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../../../../infra/migrations/0249_project_main_runtime_budget_reservations.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../../../../infra/migrations/0290_project_main_runtime_image_profiles.sql", import.meta.url), "utf8"),
  ]);
  await db.prepare("INSERT INTO orgs(id,plan_tier) VALUES('tenant-a','free')").run();
  await db.prepare("INSERT INTO spaces(id,tenant_id) VALUES('space-a','tenant-a')").run();
  await db.prepare("INSERT INTO org_members(org_id,user_id,role) VALUES('tenant-a','user-a',?)").bind(role).run();
  const env = {
    PLATFORM_SECRET: secret, PLATFORM_DB: db, DYNAMIC_CONTAINERS_ENABLED: "true", DYNAMIC_CONTAINER_BASE_PROFILE: "standard-1",
    CONTAINER_IMAGE_REGISTRY: registry,
    DYNAMIC_SANDBOX: { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ enabled: true, images: [image] }) }) },
    SPACES_WORKER: { fetch: async () => Response.json({ project_id: "project-a" }) },
  } as never;
  const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a",
    "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
  return { db, env, headers };
}

describe("Project main runtime profile routes", () => {
  it("lists deployed image profiles and saves a plan- and size-eligible owner choice", async () => {
    const f = await fixture("owner");
    const path = "/spaces/space-a/projects/project-a/main-runtime-profile";
    const read = await app.request(path, { headers: f.headers }, f.env);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ imageProfileId: "base", profile: "standard-1", eligibleImageProfiles: [
      { id: "base", minimumProfile: "lite", capabilities: [] },
      { id: "media-documents", minimumProfile: "standard-1", capabilities: ["media.audio_extract", "media.frame_extract", "document.pdf_render"] },
    ] });

    const saved = await app.request(path, { method: "PUT", headers: f.headers,
      body: JSON.stringify({ profile: "standard-1", image_profile_id: "media-documents", expected_version: 0 }) }, f.env);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ profile: "standard-1", imageProfileId: "media-documents", version: 1, changed: true });
    expect(await f.db.prepare("SELECT image_profile_id FROM project_main_runtime_profiles").first())
      .toEqual({ image_profile_id: "media-documents" });

    const undersized = await app.request(path, { method: "PUT", headers: f.headers,
      body: JSON.stringify({ profile: "lite", image_profile_id: "media-documents", expected_version: 1 }) }, f.env);
    expect(undersized.status).toBe(409);
    expect(await undersized.json()).toEqual({ error_code: "project_main_runtime_profile_image_size_limit" });
    const notDeployed = await app.request(path, { method: "PUT", headers: f.headers,
      body: JSON.stringify({ profile: "standard-1", image_profile_id: "not-deployed", expected_version: 1 }) }, f.env);
    expect(notDeployed.status).toBe(409);
    expect(await notDeployed.json()).toEqual({ error_code: "project_main_runtime_profile_image_unavailable" });
    const overPlan = await app.request(path, { method: "PUT", headers: f.headers,
      body: JSON.stringify({ profile: "standard-2", image_profile_id: "base", expected_version: 1 }) }, f.env);
    expect(overPlan.status).toBe(403);
    expect(await overPlan.json()).toEqual({ error_code: "project_main_runtime_profile_plan_limit" });
  });

  it("requires owner/admin authority for profile changes", async () => {
    const f = await fixture("member");
    const path = "/spaces/space-a/projects/project-a/main-runtime-profile";
    const denied = await app.request(path, { method: "PUT", headers: f.headers,
      body: JSON.stringify({ profile: "standard-1", image_profile_id: "base", expected_version: 0 }) }, f.env);
    expect(denied.status).toBe(403);
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM project_main_runtime_profiles").first()).toEqual({ count: 0 });
  });
});
