import { afterEach, describe, expect, it, vi } from "vitest";
import { getProductSession, logOut } from "./productAccount.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => { values.delete(key); },
  };
}

function stubWindow(storage: ReturnType<typeof memoryStorage>) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
  vi.stubGlobal("localStorage", storage);
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

describe("Product account logout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  it("clears the browser token only after the server confirms revocation", async () => {
    const storage = memoryStorage();
    stubWindow(storage);
    storage.setItem("naelao_product_session:space/a", JSON.stringify({
      end_user_id: "user-1", session_token: "secret-session-token", expires_at: "2030-01-01T00:00:00.000Z",
    }));
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await logOut("space/a");

    expect(fetch).toHaveBeenCalledWith("http://localhost:8787/v1/spaces/space%2Fa/end-users/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ end_user_id: "user-1", session_token: "secret-session-token" }),
    });
    expect(getProductSession("space/a")).toBeNull();
  });

  it("retains the token when the server cannot confirm revocation so the user can retry", async () => {
    const storage = memoryStorage();
    stubWindow(storage);
    const session = { end_user_id: "user-1", session_token: "secret-session-token", expires_at: "2030-01-01T00:00:00.000Z" };
    storage.setItem("naelao_product_session:space-1", JSON.stringify(session));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(logOut("space-1")).rejects.toThrow("Could not revoke this product session (503)");
    expect(getProductSession("space-1")).toEqual(session);
  });

  it("clears local state without a request when no product bearer is stored", async () => {
    const storage = memoryStorage();
    stubWindow(storage);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    storage.setItem("naelao_product_session:space-1", "invalid-json");

    await logOut("space-1");

    expect(fetch).not.toHaveBeenCalled();
    expect(storage.getItem("naelao_product_session:space-1")).toBeNull();
  });
});
