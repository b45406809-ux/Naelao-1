import { afterEach, describe, expect, it, vi } from "vitest";
import { exportMyProductData, listMyProductInbox, markMyProductInboxNotificationRead } from "./api.js";

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

  it("reads and marks only the authenticated Product user's private inbox", async () => {
    const inbox = [{ id: `dunning-${"a".repeat(64)}`, kind: "billing_payment_failed", title: "Payment needs attention",
      body: "Review your subscription.", status: "unread", read_at: null, created_at: "2026-11-15 10:00:00" }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: inbox }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const session = { sessionToken: "nps-secret", endUserId: "user-a" };

    await expect(listMyProductInbox("product/a", session, { status: "unread" })).resolves.toEqual({ data: inbox });
    await markMyProductInboxNotificationRead("product/a", session, inbox[0]!.id);

    const [readUrl, readInit] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(readUrl).toBe("http://localhost:8787/v1/spaces/product%2Fa/product-users/me/inbox?limit=50&status=unread");
    expect(readInit.cache).toBe("no-store");
    expect(new Headers(readInit.headers).get("x-naelao-end-user-id")).toBe("user-a");
    const [writeUrl, writeInit] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(writeUrl).toBe("http://localhost:8787/v1/spaces/product%2Fa/product-users/me/inbox");
    expect(writeInit.method).toBe("POST");
    expect(JSON.parse(String(writeInit.body))).toEqual({ action: "mark_read", notification_id: inbox[0]!.id });
  });
});
