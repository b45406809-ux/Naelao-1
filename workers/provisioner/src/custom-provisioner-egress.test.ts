import { afterEach, describe, expect, it, vi } from "vitest";
import { callCustomProvisioner } from "./index.js";

describe("custom provisioner egress", () => {
  afterEach(() => vi.restoreAllMocks());

  it("blocks private address literals before making the custom request", async () => {
    const fetch = vi.fn();
    await expect(callCustomProvisioner("https://127.0.0.1/provision", { spaceId: "s" }, fetch))
      .rejects.toThrow("Blocked host");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a public hostname resolving to a link-local address", async () => {
    const fetch = vi.fn(async () => Response.json({ Answer: [{ data: "169.254.169.254" }] }));
    await expect(callCustomProvisioner("https://hooks.example.test/provision", { spaceId: "s" }, fetch))
      .rejects.toThrow("169.254.169.254");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("validates public DNS, refuses redirects, and sets a request deadline", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.startsWith("https://cloudflare-dns.com/")) {
        return Response.json({ Answer: url.includes("type=AAAA") ? [] : [{ data: "93.184.216.34" }] });
      }
      return new Response("ok", { status: 200 });
    });

    const response = await callCustomProvisioner("https://hooks.example.test/provision", { action: "provision" }, fetch);
    expect(response.status).toBe(200);
    const delivery = requests.find(({ url }) => url.startsWith("https://hooks.example.test/"));
    expect(delivery?.init?.redirect).toBe("error");
    expect(delivery?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(delivery?.init?.body))).toEqual({ action: "provision" });
  });
});
