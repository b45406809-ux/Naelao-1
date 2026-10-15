import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { ProductUserDO } from "./ProductUserDO.js";

describe("ProductUserDO inference-credit reservations", () => {
  it("holds available credits, blocks competing debits, and settles idempotently at actual usage", async () => {
    const storage = createDOStorage();
    const user = new ProductUserDO({ storage } as never, {} as never);
    const post = (body: Record<string, unknown>) => user.fetch(new Request("https://user/credits/reservations", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    await user.fetch(new Request("https://user/credits/grant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credits: 100 }) }));

    expect((await post({ action: "reserve", reservation_id: "run-a:1", run_id: "run-a", credits: 70 })).status).toBe(200);
    expect((await post({ action: "reserve", reservation_id: "run-b:1", run_id: "run-b", credits: 40 })).status).toBe(402);
    const competingDebit = await user.fetch(new Request("https://user/credits/deduct", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credits: 40 }) }));
    expect(competingDebit.status).toBe(402);
    const settled = await post({ action: "settle_run", run_id: "run-a", credits: 55 });
    expect(settled.status).toBe(200);
    expect(await settled.json()).toMatchObject({ actual_credits: 55, balance_credits: 45 });
    expect(await (await post({ action: "settle_run", run_id: "run-a", credits: 99 })).json()).toMatchObject({ deduplicated: true, actual_credits: 55 });
    expect(await (await user.fetch(new Request("https://user/credits/balance"))).json()).toMatchObject({ balance_credits: 45 });
    const restarted = new ProductUserDO({ storage } as never, {} as never);
    expect(await (await restarted.fetch(new Request("https://user/credits/balance"))).json()).toMatchObject({ balance_credits: 45 });
  });
});
