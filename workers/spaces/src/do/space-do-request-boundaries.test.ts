import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

describe("SpaceDO direct request body limit", () => {
  it("rejects a streamed body over 8 MiB before initializing DO storage", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, {} as never);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (cancelled) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await space.fetch(
      new Request("http://space/internal/domain-glossary", {
        method: "POST",
        body,
        // Intentionally omit Content-Length to exercise the streaming check.
        duplex: "half",
      } as RequestInit)
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error_code: "request_body_too_large",
    });
    expect(
      storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table'")
        .toArray()
    ).toHaveLength(0);
  });
});
