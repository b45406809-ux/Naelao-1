import { afterEach, describe, expect, it, vi } from "vitest";
import { getToken, getUser, logout } from "./account.js";
import { getProductSession, logOut } from "./productAccount.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function stubBrowserStorage(storage: ReturnType<typeof memoryStorage>) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
  vi.stubGlobal("localStorage", storage);
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("Portal logout", () => {
  it("revokes the builder token before clearing local credentials", async () => {
    const storage = memoryStorage();
    stubBrowserStorage(storage);
    storage.setItem("naelao_token", "builder-token");
    storage.setItem("naelao_user", JSON.stringify({ id: "user-1", email: "owner@example.test", role: "owner" }));
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ revoked: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await logout();

    expect(fetch).toHaveBeenCalledWith("http://localhost:8787/v1/auth/revoke", {
      method: "POST", headers: { authorization: "Bearer builder-token" },
    });
    expect(getToken()).toBeNull();
    expect(getUser()).toBeNull();
  });

  it("retains builder credentials after an unconfirmed revoke and clears already-revoked tokens", async () => {
    const storage = memoryStorage();
    stubBrowserStorage(storage);
    storage.setItem("naelao_token", "builder-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(logout()).rejects.toThrow("Could not revoke this account session (503)");
    expect(getToken()).toBe("builder-token");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    await logout();
    expect(getToken()).toBeNull();
  });

  it("revokes the current Product-user bearer before clearing its scoped storage", async () => {
    const storage = memoryStorage();
    stubBrowserStorage(storage);
    const session = { end_user_id: "end-user-1", session_token: "product-token", expires_at: "2030-01-01T00:00:00.000Z" };
    storage.setItem("naelao_product_session:space-1", JSON.stringify(session));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await logOut("space-1");

    expect(getProductSession("space-1")).toBeNull();
    expect(storage.getItem("naelao_product_session:space-2")).toBeNull();
  });
});
