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
      const testSet = { id: "support", version: "support-v4", cases: Array.from({ length: 20 }, (_, i) => ({ input: `Question ${i}`, expected: `Answer ${i}` })) };
      const save = await testSets(model, "POST", { action: "save", testSet });
      expect(save.status, JSON.stringify(await save.clone().json())).toBe(200);
    };
    const evaluate = (model: string, score = 0.92) => send(model, {
      action: "record_evaluation",
      evaluation: { baseModel, testSetVersion: "support-v4", sampleCount: 20, score, threshold: 0.85, baselineScore: 0.88 },
    });
    const testSets = async (model: string, method: "GET" | "POST", body?: Record<string, unknown>, query = "") => space.fetch(new Request(
      `http://space/custom-models/${encodeURIComponent(model)}/test-sets?space_id=space-1${query}`,
      { method, headers: await headers(method === "POST"), ...(body ? { body: JSON.stringify({ actorId: "owner-1", ...body }) } : {}) },
    ));

    await importModel("custom/one", "adapter/one");
    const stored = storage.sql.exec<{ ciphertext: string }>("SELECT ciphertext FROM custom_model_test_sets WHERE space_id='space-1' AND model_id='custom/one'").toArray()[0];
    expect(stored?.ciphertext).not.toContain("Question 0");
    await expect((await testSets("custom/one", "GET", undefined, "&test_set_id=support")).json()).resolves.toMatchObject({ testSet: { id: "support", version: "support-v4", cases: expect.arrayContaining([{ input: "Question 0", expected: "Answer 0" }]) } });
    await expect((await testSets("custom/one", "GET")).json()).resolves.toMatchObject({ testSets: [{ id: "support", version: "support-v4", case_count: 20 }] });
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
    expect(storage.sql.exec("SELECT test_set_id FROM custom_model_test_sets WHERE model_id='custom/two'").toArray()).toHaveLength(0);
  });
});
