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
});
