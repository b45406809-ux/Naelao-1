import { describe, expect, it, vi } from "vitest";
import { mintInternalToken, verifyInternalToken } from "@naelao/http";
import spacesWorker from "./index.js";

const secret = "phone-extension-settings-route-secret";

function harness(activePublisher = true, settingsDeclared = true) {
  const forwarded: Request[] = [];
  const spaceStub = { fetch: vi.fn(async (request: Request) => {
    forwarded.push(request);
    if (new URL(request.url).pathname === "/workflow-installation") return Response.json({
      instance: { instance_id: "install-a", tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a", status: "active" },
      manifest: { id: "ext_phone", bundle: { id: "ext_phone", version: "1.0.0" },
        declaredPermissions: settingsDeclared ? ["extension.settings.read"] : [],
        capabilityRequirements: settingsDeclared ? ["extension.settings.read"] : [],
        ...(settingsDeclared ? { settingsSchema: { schemaVersion: 2, fields: [] } } : {}) },
      release: { version: "1.0.0", artifactSha256: "b".repeat(64), signatureValid: true, publisher: { keyId: "a".repeat(64) } },
    });
    return Response.json({ schema_version: 2, revision: 4, settings: { greeting: "Welcome" } });
  }) };
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => activePublisher ? { active: 1 } : null }) }) },
    SPACE_DO: { idFromName: () => "space-do-id", get: () => spaceStub },
  } as never;
  return { env, forwarded, spaceStub };
}

describe("internal phone extension settings handoff", () => {
  it("attaches settings only after active installation and publisher-key checks", async () => {
    const h = harness();
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/workflow-installations/install-a?include_phone_settings=1", {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
    }), h.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phone_settings: { schema_version: 2, revision: 4, settings: { greeting: "Welcome" } } });
    expect(h.forwarded).toHaveLength(2);
    expect(new URL(h.forwarded[1]!.url).pathname).toBe("/phone-extension-settings");
    expect([...new URL(h.forwarded[1]!.url).searchParams]).toEqual([
      ["tenant_id", "tenant-a"], ["space_id", "space-a"], ["instance_id", "install-a"], ["expected_version", "1.0.0"],
      ["expected_artifact_sha256", "b".repeat(64)], ["project_id", "project-a"],
    ]);
    expect(await verifyInternalToken(h.forwarded[1]!.headers.get("x-naelao-internal-token") ?? undefined, "tenant-a", secret)).toBe(true);
  });

  it("never loads settings for an inactive or untrusted installation", async () => {
    const h = harness(false);
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/workflow-installations/install-a?include_phone_settings=1", {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
    }), h.env);
    expect(response.status).toBe(409);
    expect(h.forwarded).toHaveLength(1);
  });

  it("keeps phone handlers without a settings grant on their existing runtime path", async () => {
    const h = harness(true, false);
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/workflow-installations/install-a?include_phone_settings=1", {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
    }), h.env);
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("phone_settings");
    expect(h.forwarded).toHaveLength(1);
  });
});
