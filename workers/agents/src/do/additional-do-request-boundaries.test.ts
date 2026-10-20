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
});
