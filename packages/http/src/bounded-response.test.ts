import { describe, expect, it } from "vitest";
import {
  readBoundedResponseJson,
  readBoundedResponseText,
} from "./bounded-response.js";

describe("bounded response readers", () => {
  it("reads bounded text and JSON", async () => {
    await expect(
      readBoundedResponseText(new Response("safe"), 4)
    ).resolves.toBe("safe");
    await expect(
      readBoundedResponseJson(new Response('{"ok":true}'), 12)
    ).resolves.toEqual({ ok: true });
  });

  it("rejects an oversized stream without Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5));
      },
    });
    await expect(
      readBoundedResponseText(new Response(body), 4)
    ).rejects.toThrow("response_too_large");
  });

  it("rejects malformed UTF-8", async () => {
    await expect(
      readBoundedResponseText(new Response(new Uint8Array([0xff])), 4)
    ).rejects.toThrow();
  });
});
