import { describe, expect, it, vi } from "vitest";
import {
  readBoundedRequestText,
  readBoundedResponseText,
} from "./bounded-response-text.js";

describe("bounded provider response text", () => {
  it("reads responses within budget", async () => {
    await expect(readBoundedResponseText(new Response("ok"), 2)).resolves.toBe(
      "ok"
    );
  });

  it("rejects a declared oversize without reading the body", async () => {
    const response = new Response("oversized body");
    response.headers.set("content-length", "10");
    await expect(readBoundedResponseText(response, 4)).rejects.toThrow(
      "response_too_large"
    );
  });

  it("stops an undeclared oversized stream at the byte limit", async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel,
    });
    await expect(
      readBoundedResponseText(new Response(body), 4)
    ).rejects.toThrow("response_too_large");
    expect(cancel).toHaveBeenCalled();
  });

  it("bounds inbound request bodies with no Content-Length", async () => {
    const request = new Request("https://naelao.invalid/webhook", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(5));
        },
      }),
      duplex: "half",
    } as RequestInit);
    await expect(readBoundedRequestText(request, 4)).rejects.toThrow(
      "response_too_large"
    );
  });
});
