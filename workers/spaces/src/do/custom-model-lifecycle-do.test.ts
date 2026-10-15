import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SpaceDO } from "./SpaceDO.js";

const baseModel = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const consent = {
  provenance: "Space owner reviewed licensed data source v1",
  purpose: "Space-only terminology adaptation for support answers",
  lawfulBasis: "consent",
  affirmativeConsent: true,
  crossSpaceData: false,
  secretsExcluded: true,
  protectedContentExcluded: true,
  deletionPlanConfirmed: true,
};

describe("SpaceDO custom model lifecycle", () => {
  it("requires consent, a matching passing evaluation, owner approval, and supports rollback/revocation/deletion", async () => {
    const storage = createDOStorage();
    const secret = "test-platform-secret-for-custom-model-lifecycle";
    const tenantId = "tenant-1";
    const headers = async (contentType = false) => ({
      "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(secret, tenantId),
      ...(contentType ? { "content-type": "application/json" } : {}),
    });
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret } as never);
    const send = async (model: string, body: Record<string, unknown>) => space.fetch(new Request(
      `http://space/custom-models/${encodeURIComponent(model)}/lifecycle?space_id=space-1`,
      { method: "POST", headers: await headers(true), body: JSON.stringify({ actorId: "owner-1", ...body }) },
    ));
    const adapter = async (model: string) => space.fetch(new Request(`http://space/custom-models/${encodeURIComponent(model)}?space_id=space-1`, { headers: await headers() }));
    expect((await space.fetch(new Request("http://space/custom-models/custom%2Fone/lifecycle?space_id=space-1", { method: "POST", body: "{}" }))).status).toBe(403);
    const importModel = async (model: string, adapterId: string) => {
      expect((await send(model, { action: "attest_consent", consent })).status).toBe(200);
      expect((await send(model, { action: "import_adapter", baseModel, loraAdapterId: adapterId, providerEvidence: "Owner attests provider-issued adapter reference" })).status).toBe(200);
    };
    const evaluate = (model: string, score = 0.92) => send(model, {
      action: "record_evaluation",
      evaluation: { baseModel, testSetVersion: "support-v4", sampleCount: 40, score, threshold: 0.85, baselineScore: 0.88 },
    });

    await importModel("custom/one", "adapter/one");
    await expect((await evaluate("custom/one", 0.80)).json()).resolves.toMatchObject({ status: "evaluation_failed", evaluation_passed: false });
    expect((await send("custom/one", { action: "approve_activation" })).status).toBe(409);
    expect((await adapter("custom/one")).status).toBe(404);
    expect((await evaluate("custom/one")).status).toBe(200);
    expect((await send("custom/one", { action: "approve_activation" })).status).toBe(200);
    expect(await (await adapter("custom/one")).json()).toMatchObject({ modelId: "custom/one", baseModel, loraAdapterId: "adapter/one" });

    await importModel("custom/two", "adapter/two");
    await evaluate("custom/two");
    expect((await send("custom/two", { action: "approve_activation" })).status).toBe(200);
    expect((await adapter("custom/one")).status).toBe(404);
    expect((await send("custom/two", { action: "rollback" })).status).toBe(200);
    expect((await adapter("custom/one")).status).toBe(200);
    expect((await adapter("custom/two")).status).toBe(404);

    expect((await send("custom/one", { action: "revoke" })).status).toBe(200);
    expect((await adapter("custom/one")).status).toBe(404);
    expect((await send("custom/two", { action: "delete" })).status).toBe(200);
    await expect((await space.fetch(new Request("http://space/custom-models/custom%2Ftwo/lifecycle?space_id=space-1", { headers: await headers() }))).json()).resolves.toMatchObject({ status: "deleted", provenance: "", evaluation_passed: 0 });
    expect((await send("custom/three", { action: "submit_training" })).status).toBe(501);
    expect((await adapter("custom/one")).status).toBe(404);
  });
});
