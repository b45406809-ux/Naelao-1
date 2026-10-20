import { describe, expect, it } from "vitest";
import { checkRequestBodyByteLimit } from "./request-body.js";

describe("request body byte limits", () => {
  it("rejects declared oversized bodies without consuming them", async () => {
    const request = new Request("https://naelao.test/upload", {
      method: "POST",
      headers: { "content-length": "101" },
      body: "small",
    });
    await expect(checkRequestBodyByteLimit(request, 100)).resolves.toBe(
      "too_large"
    );
    await expect(request.text()).resolves.toBe("small");
  });

  it("counts streamed bytes when Content-Length is missing", async () => {
    const request = new Request("https://naelao.test/upload", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(5));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    await expect(checkRequestBodyByteLimit(request, 12)).resolves.toBe(
      "too_large"
    );
  });

  it("cancels the original request branch after discovering an oversized chunked body", async () => {
    let cancelled = false;
    const request = new Request("https://naelao.test/upload", {
      method: "POST",
      body: new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(9)); },
        cancel() { cancelled = true; },
      }),
      duplex: "half",
    } as RequestInit);
    await expect(checkRequestBodyByteLimit(request, 8)).resolves.toBe("too_large");
    expect(cancelled).toBe(true);
  });

  it("allows a bounded streamed body and preserves the original request", async () => {
    const request = new Request("https://naelao.test/upload", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    await expect(checkRequestBodyByteLimit(request, 5)).resolves.toBe(
      "within_limit"
    );
    await expect(request.text()).resolves.toBe("hello");
  });

  it("reports uninspectable streams and rejects invalid limits", async () => {
    const request = new Request("https://naelao.test/upload", {
      method: "POST",
      body: "x",
    });
    request.body?.getReader();
    await expect(checkRequestBodyByteLimit(request, 10)).resolves.toBe(
      "unavailable"
    );
    await expect(
      checkRequestBodyByteLimit(new Request("https://naelao.test/"), -1)
    ).rejects.toThrow(RangeError);
  });
});
