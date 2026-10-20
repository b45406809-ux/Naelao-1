import { describe, expect, it } from "vitest";
import {
  readBoundedRequestBytes,
  readBoundedResponseJson,
  readBoundedResponseText,
  readResponsePrefixText,
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

  it("returns a bounded prefix and cancels the oversized response tail", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("abcdef"));
        },
        cancel() {
          cancelled = true;
        },
      })
    );
    await expect(readResponsePrefixText(response, 4)).resolves.toEqual({
      text: "abcd",
      truncated: true,
    });
    expect(cancelled).toBe(true);
  });

  it("bounds request streams without cloning or trusting Content-Length", async () => {
    const request = new Request("https://example.test/upload", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(5));
        },
      }),
      duplex: "half",
    } as RequestInit);
    await expect(readBoundedRequestBytes(request, 4)).rejects.toThrow(
      "request_body_too_large"
    );
  });

  it("rejects invalid ceilings instead of allowing comparisons to bypass the cap", async () => {
    for (const ceiling of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -1]) {
      await expect(readBoundedResponseText(new Response("payload"), ceiling)).rejects.toThrow("maximumBytes must be a non-negative safe integer");
      await expect(readBoundedRequestBytes(new Request("https://example.test/upload"), ceiling)).rejects.toThrow("maximumBytes must be a non-negative safe integer");
    }
  });
});
