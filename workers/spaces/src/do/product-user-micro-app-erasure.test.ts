import { describe, expect, it } from "vitest";
import { validateExtensionManifest } from "@naelao/agent-sdk";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

const secret = "product-user-micro-app-erasure-test-secret";
const tenantId = "tenant-erasure", spaceId = "space-erasure", userId = "user-erasure";
const manifest = validateExtensionManifest({ id: "ext_user_erase", type: "extension", declaredPermissions: [],
  capabilityRequirements: ["extension.project_canvas"], gadgets: [], daemons: [], commands: [], bundle: {
    schemaVersion: "1.0", kind: "extension_bundle", id: "ext_user_erase", version: "1.0.0", primitives: [
      { schemaVersion: "1.0", kind: "canvas", id: "erase_canvas", version: "1.0.0", permissions: [], capabilityRequirements: [],
        lifecycle: {}, component: "./erase.html", layout: "CanvasMount", dynamicPage: false },
      { schemaVersion: "1.0", kind: "gadget", id: "personal_notes", version: "1.0.0", scope: "SPACE_USER", permissions: [],
        capabilityRequirements: [], lifecycle: {}, schemaSql: "CREATE TABLE notes(id TEXT PRIMARY KEY)" },
    ],
  },
}, { gatekeeperCapabilities: ["extension.project_canvas"] });

function harness() {
  const storage = createDOStorage();
  const erasedActors: string[] = [];
  const actorNamespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({ fetch: async (request: Request) => {
      erasedActors.push(id);
      const body = await request.json() as Record<string, unknown>;
      return body.userId === userId && new URL(request.url).pathname === "/internal/erase-user"
        ? Response.json({ erased: true }) : Response.json({ error_code: "actor_identity_mismatch" }, { status: 409 });
    } }),
  };
  const space = new SpaceDO({ storage } as never,
    { PLATFORM_SECRET: secret, MICRO_APP_DO: actorNamespace } as never);
  return { storage, space, erasedActors };
}

async function headers(extra: Record<string, string> = {}) {
  return { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
    "x-naelao-internal-token": await mintInternalToken(secret, tenantId), ...extra };
}

describe("product-user MicroApp erasure", () => {
  it("registers exact user actors, removes installs, and resumes bounded erasure batches", async () => {
    const h = harness();
    const statusUrl = `http://space/product-user-micro-app-erasure?tenant_id=${tenantId}&space_id=${spaceId}`;
    expect(await (await h.space.fetch(new Request(statusUrl, { headers: await headers({ "x-naelao-user-id": userId }) }))).json())
      .toMatchObject({ status: "none" });

    h.storage.sql.exec(`INSERT INTO installed_extensions(extension_id,manifest_json,installed_by,installed_at,updated_at)
      VALUES(?,?,?,?,?)`, manifest.id, JSON.stringify(manifest), "owner", "2026-11-15", "2026-11-15");
    const install = (instanceId: string, scope: "SPACE_SHARED" | "SPACE_USER", ownerUserId: string | null, status: "active" | "staging") =>
      h.storage.sql.exec(`INSERT INTO extension_instances(instance_id,extension_id,tenant_id,space_id,project_id,user_id,scope,instance_key,
        owner_key,installed_by,status,installed_at,removed_at,release_version)
        VALUES(?,?,?,?,NULL,?,?,?,'owner-key','owner',?,datetime('now'),NULL,NULL)`,
      instanceId, manifest.id, tenantId, spaceId, ownerUserId, scope, "default", status);
    install("owner-install", "SPACE_SHARED", null, "active");
    install("user-install", "SPACE_USER", userId, "active");

    const register = await h.space.fetch(new Request("http://space/product-user-micro-app-actors/register", { method: "POST", headers: await headers(),
      body: JSON.stringify({ spaceId, userId, ownerInstallationId: "owner-install", userInstallationId: "user-install",
        extensionId: manifest.id, appId: "personal_notes", gadgetScope: "SPACE_USER" }) }));
    expect(register.status, await register.clone().text()).toBe(200);
    expect(await register.json()).toMatchObject({ registered: true });

    const userHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      JSON.stringify(["product-user-micro-app-user-v1", tenantId, spaceId, userId]))))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    for (let index = 0; index < 32; index++) h.storage.sql.exec(`INSERT INTO product_user_micro_app_actor_registry
      (tenant_id,space_id,user_key_sha256,project_id,app_id,gadget_scope,extension_id,owner_installation_id,user_installation_id,status,created_at)
      VALUES(?,?,?,'',?,'SPACE_USER',?,'owner-install','user-install','active',?)`, tenantId, spaceId, userHash,
      `actor_extra_${index.toString().padStart(2, "0")}`, manifest.id, index);

    const erase = async () => h.space.fetch(new Request("http://space/product-user-micro-app-erasure", { method: "POST", headers: await headers(),
      body: JSON.stringify({ spaceId, userId }) }));
    const first = await erase();
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ erased: false, status: "pending", erased_now: 32, pending_actors: 1 });
    expect(h.erasedActors).toHaveLength(32);
    expect(h.storage.sql.exec<{ status: string; user_id: string | null }>(
      "SELECT status,user_id FROM extension_instances WHERE instance_id='user-install'").toArray()[0])
      .toEqual({ status: "removed", user_id: null });
    const statusPending = await h.space.fetch(new Request(statusUrl, { headers: await headers({ "x-naelao-user-id": userId }) }));
    expect(await statusPending.json()).toMatchObject({ status: "pending", pending_actors: 1 });

    const second = await erase();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ erased: true, status: "complete", replayed: false });
    expect(h.erasedActors).toHaveLength(33);
    expect(await (await erase()).json()).toMatchObject({ erased: true, status: "complete", replayed: true });
    expect(h.erasedActors).toHaveLength(33);
    const rejectedRegistration = await h.space.fetch(new Request("http://space/product-user-micro-app-actors/register", { method: "POST",
      headers: await headers(), body: JSON.stringify({ spaceId, userId, ownerInstallationId: "owner-install", userInstallationId: "user-install",
        extensionId: manifest.id, appId: "personal_notes", gadgetScope: "SPACE_USER" }) }));
    expect(rejectedRegistration.status).toBe(410);
    const archives = await h.space.fetch(new Request(`http://space/product-user-micro-app-archives?tenant_id=${tenantId}&space_id=${spaceId}`,
      { headers: await headers({ "x-naelao-user-id": userId }) }));
    expect(archives.status).toBe(410);
  });
});
