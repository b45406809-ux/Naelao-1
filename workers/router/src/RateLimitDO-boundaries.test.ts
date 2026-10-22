import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim.js";
import { RateLimitDO } from "./RateLimitDO.js";

describe("RateLimitDO request body limit", () => {
  it("rejects an oversized streamed request before migrations", async () => {
    const storage = createDOStorage();
    const object = new RateLimitDO({ storage } as never, {} as never);
    const response = await object.fetch(
      new Request("http://rate-limit/check", {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 + 1));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit)
    );
    expect(response.status).toBe(413);
    expect(
      storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table'")
        .toArray()
    ).toHaveLength(0);
  });

  it.each([
    ["malformed JSON", "{"],
    ["non-object JSON", "[]"],
    ["null JSON", "null"],
    ["string JSON", JSON.stringify("user")],
    ["empty bucket key", JSON.stringify({ key: "", limit: 10 })],
    ["oversized bucket key", JSON.stringify({ key: "x".repeat(513), limit: 10 })],
    ["zero limit", JSON.stringify({ key: "user", limit: 0 })],
    ["negative limit", JSON.stringify({ key: "user", limit: -1 })],
    ["non-finite limit", JSON.stringify({ key: "user", limit: "Infinity" })],
    ["excessive limit", JSON.stringify({ key: "user", limit: 10_001 })],
  ])("rejects %s without mutating the bucket table", async (_name, body) => {
    const storage = createDOStorage();
    const object = new RateLimitDO({ storage } as never, {} as never);
    const response = await object.fetch(new Request("http://rate-limit/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM buckets").toArray()[0]?.count).toBe(0);
  });

  it("rejects an invalid reset key instead of silently accepting it", async () => {
    const storage = createDOStorage();
    const object = new RateLimitDO({ storage } as never, {} as never);
    const response = await object.fetch(new Request("http://rate-limit/reset", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(400);
  });
});
