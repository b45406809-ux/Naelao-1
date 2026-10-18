import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { FeatureFlagDO } from "./FeatureFlagDO.js";

function harness() {
  const storage = createDOStorage();
  return new FeatureFlagDO({ storage } as never, {} as never);
}

describe("FeatureFlagDO input bounds", () => {
  it("rejects invalid states and rollout percentages instead of persisting unsafe policy", async () => {
    const flags = harness();
    const put = (body: unknown) => flags.fetch(new Request("http://flags/flags", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await put({ flag_id: "rollout", state: "rollout", enabled_pct: 101 })).status).toBe(400);
    expect((await put({ flag_id: "invalid", state: "enabled" })).status).toBe(400);
    expect((await put({ flag_id: "bounded", state: "rollout", enabled_pct: 100 })).status).toBe(201);
    const response = await flags.fetch(new Request("http://flags/evaluate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ flag_id: "bounded", context: { account_id: "tenant-a" } }),
    }));
    expect(await response.json()).toMatchObject({ enabled: true, reason: "rollout_pct_100" });
  });

  it("limits targeting to the documented context fields and validates rule shape", async () => {
    const flags = harness();
    const invalidRule = await flags.fetch(new Request("http://flags/flags", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ flag_id: "unsafe", state: "rollout", targeting_rules: [{ attribute: "is_admin", operator: "eq", value: "true" }] }),
    }));
    expect(invalidRule.status).toBe(400);

    const configured = await flags.fetch(new Request("http://flags/flags", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ flag_id: "staff-only", state: "rollout", targeting_rules: [{ attribute: "account_id", operator: "eq", value: "staff" }] }),
    }));
    expect(configured.status).toBe(201);
    const evaluate = (context: unknown) => flags.fetch(new Request("http://flags/evaluate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ flag_id: "staff-only", context }),
    }));
    expect((await evaluate({ is_admin: "true" })).status).toBe(200);
    expect(await (await evaluate({ is_admin: "true" })).json()).toMatchObject({ enabled: false });
    expect((await evaluate({ account_id: { id: "staff" } })).status).toBe(400);
  });
});
