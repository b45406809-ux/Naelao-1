import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { cors } from "./cors.js";

describe("CORS middleware", () => {
  it("varies cacheable responses by origin and handles immutable proxied responses", async () => {
    const app = new Hono();
    app.use("*", cors(["https://allowed.example"]));
    app.get("/redirect", () => Response.redirect("https://upstream.example/"));

    const response = await app.request("/redirect", {
      headers: { Origin: "https://allowed.example" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://allowed.example"
    );
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("adds Vary to preflight responses and omits permission for disallowed origins", async () => {
    const app = new Hono();
    app.use("*", cors(["https://allowed.example"]));
    app.options("/resource", (c) => c.body(null));

    const allowed = await app.request("/resource", {
      method: "OPTIONS",
      headers: { Origin: "https://allowed.example" },
    });
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://allowed.example"
    );
    expect(allowed.headers.get("Vary")).toBe("Origin");

    const denied = await app.request("/resource", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBe("");
  });
});
