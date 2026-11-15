import { afterEach, describe, expect, it, vi } from "vitest";
import { exportMyProductData } from "./api.js";

describe("Product-user portability export client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests the exact product export with the authenticated session and no browser cache", async () => {
    const payload = { version: 4, product: { id: "product-a" }, conversations: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exportMyProductData("space/a", { sessionToken: "nps-secret", endUserId: "user-a" })).resolves.toEqual(payload);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/v1/spaces/space%2Fa/product-users/me/export");
    expect(init.method).toBeUndefined();
    expect(init.cache).toBe("no-store");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer nps-secret");
    expect(headers.get("x-naelao-end-user-id")).toBe("user-a");
  });

  it("surfaces an oversized-export response without accepting a partial payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "Export exceeds the response limit",
      error_code: "product_user_export_space_limit_exceeded",
    }), { status: 413, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exportMyProductData("product-a", { sessionToken: "nps-secret", endUserId: "user-a" }))
      .rejects.toMatchObject({ status: 413, errorCode: "product_user_export_space_limit_exceeded" });
  });
});
