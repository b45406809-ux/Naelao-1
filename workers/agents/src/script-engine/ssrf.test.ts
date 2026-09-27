import { describe, expect, it, vi } from "vitest";
import { checkSsrf } from "../../../../packages/security/src/ssrf.js";

describe("outbound SSRF firewall", () => {
  it.each(["http://169.254.169.254/latest", "http://127.0.0.1", "http://10.1.2.3", "http://172.16.2.3", "http://192.168.1.1"])("blocks %s", async (url) => {
    expect((await checkSsrf(url)).blocked).toBe(true);
  });
  it("blocks a hostname whose DoH answer rebinds private", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const type = String(_url).includes("type=A") ? [{ data: "169.254.169.254" }] : [];
      return new Response(JSON.stringify({ Status: 0, Answer: type }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    expect((await checkSsrf("https://rebind.example/path", { fetchImpl })).blocked).toBe(true);
  });
});
