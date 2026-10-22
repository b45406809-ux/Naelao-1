import { afterEach, describe, expect, it, vi } from "vitest";
import { getSpace, updateProduct } from "../../apps/dashboard/src/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("dashboard API path identifiers", () => {
  it("keeps an identifier containing separators inside one encoded route segment", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "space/a" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getSpace("space/a");

    const requested = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requested.pathname).toBe("/spaces/space%2Fa");
  });

  it("rejects dot-segment identifiers before any request can be path-normalized", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSpace("..")).rejects.toThrow("Invalid API path identifier");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("encodes each space and product identifier independently on writes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await updateProduct("space/a", "product b", { name: "updated" });

    const requested = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requested.pathname).toBe("/spaces/space%2Fa/products/product%20b");
  });
});
