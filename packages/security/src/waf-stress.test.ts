import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  MAX_WAF_JSON_BODY_BYTES,
  readBoundedRequestBody,
  scanRequestBody,
  wafMiddleware,
} from "./waf.js";

describe("WAF request-body bounds", () => {
  it("fails closed when an attack is nested beyond the scanner depth", () => {
    let body: unknown = "<script>alert(1)</script>";
    for (let depth = 0; depth < 7; depth++) body = { nested: body };
    expect(scanRequestBody(body)).toEqual({
      detected: true,
      pattern: "body_depth_exceeded",
    });
  });

  it("rejects oversized strings before running the pattern checks", () => {
    expect(scanRequestBody("x".repeat(1_000_001))).toEqual({
      detected: true,
      pattern: "body_value_too_large",
    });
  });

  it("still scans normal nested JSON and leaves shallow benign values alone", () => {
    expect(
      scanRequestBody({ profile: { note: "<script>alert(1)</script>" } })
    ).toMatchObject({
      detected: true,
      pattern: "xss",
    });
    expect(scanRequestBody({ profile: { note: "ordinary text" } })).toEqual({
      detected: false,
    });
  });
});

describe("WAF JSON byte limits", () => {
  it("rejects a declared oversized body without reading it", async () => {
    const req = new Request("https://naelao.test/", {
      method: "POST",
      headers: { "content-length": String(MAX_WAF_JSON_BODY_BYTES + 1) },
      body: "{}",
    });
    await expect(readBoundedRequestBody(req)).resolves.toEqual({
      status: "too_large",
    });
  });

  it("counts streamed bytes when content length is absent or understated", async () => {
    const overLimit = new Request("https://naelao.test/", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_WAF_JSON_BODY_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
      // Node requires duplex for streaming request bodies.
      duplex: "half",
    } as RequestInit);
    await expect(readBoundedRequestBody(overLimit, 8)).resolves.toEqual({
      status: "too_large",
    });
  });

  it("keeps safe bounded JSON available to downstream handlers", async () => {
    const app = new Hono();
    app.use("*", wafMiddleware());
    app.post("/", async (c) => c.json(await c.req.json()));

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "safe body" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ note: "safe body" });
  });

  it("returns 413 for an oversized chunked JSON body before calling the handler", async () => {
    const app = new Hono();
    let handlerCalled = false;
    app.use("*", wafMiddleware());
    app.post("/", (c) => {
      handlerCalled = true;
      return c.text("unexpected");
    });
    const request = new Request("https://naelao.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"x":"'));
          controller.enqueue(new Uint8Array(MAX_WAF_JSON_BODY_BYTES));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);

    const response = await app.fetch(request);
    expect(response.status).toBe(413);
    expect(handlerCalled).toBe(false);
  });
});
