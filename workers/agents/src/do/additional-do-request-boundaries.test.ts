import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { ConcurrencyDO } from "./ConcurrencyDO.js";
import { RiskGuardDO } from "./RiskGuardDO.js";

function request(bytes: number): Request {
  return new Request("http://do/check", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
}

describe("ConcurrencyDO and RiskGuardDO ingress limits", () => {
  it("rejects oversized ConcurrencyDO input before migration", async () => {
    const storage = createDOStorage();
    const object = new ConcurrencyDO({ storage } as never);
    const response = await object.fetch(request(1024 * 1024 + 1));
    expect(response.status).toBe(413);
    expect(
      storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table'")
        .toArray()
    ).toHaveLength(0);
  });

  it("rejects oversized RiskGuardDO input before state initialization", async () => {
    const storage = createDOStorage();
    const object = new RiskGuardDO({ storage } as never, {} as never);
    const response = await object.fetch(request(64 * 1024 + 1));
    expect(response.status).toBe(413);
    expect(
      storage.sql.exec("SELECT id FROM guarded_orders").toArray()
    ).toHaveLength(0);
  });

  it("returns bounded client errors for malformed limits and order JSON", async () => {
    const storage = createDOStorage();
    const object = new RiskGuardDO({ storage } as never, {} as never);
    const limits = await object.fetch(new Request("http://do/limits", {
      method: "PUT", headers: { "content-type": "application/json" }, body: "null",
    }));
    const order = await object.fetch(new Request("http://do/orders/evaluate", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }));
    expect(limits.status).toBe(400);
    expect(order.status).toBe(400);
  });

  it("rejects orders whose JSON values exceed safe integer bounds", async () => {
    const storage = createDOStorage();
    const object = new RiskGuardDO({ storage } as never, {} as never);
    const limits = await object.fetch(new Request("http://do/limits", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stopLossBps: 500, maxDrawdownBps: 1000, peakEquityMinor: 100_000 }),
    }));
    expect(limits.status).toBe(200);
    const order = await object.fetch(new Request("http://do/orders/evaluate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: '{"id":"x","side":"buy","quantity":1,"priceMinor":1,"currentEquityMinor":9007199254740992,"projectedLossMinor":0}',
    }));
    expect(order.status).toBe(400);
    expect(storage.sql.exec("SELECT id FROM guarded_orders").toArray()).toHaveLength(0);
  });
});
