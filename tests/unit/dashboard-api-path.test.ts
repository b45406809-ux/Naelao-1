import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, getSpace, listSpaces } from "../../apps/dashboard/src/lib/api";

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

  it("loads the tenant's generic Space collection", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await listSpaces();

    const requested = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requested.pathname).toBe("/spaces");
  });

  it("does not add JSON Content-Type to bodyless requests", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/spaces");

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  });

  it("keeps Headers instances and sets JSON Content-Type for a JSON body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const headers = new Headers({ "X-Request-Trace": "trace-1" });

    await apiFetch("/spaces", { method: "POST", headers, body: "{}" });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("X-Request-Trace")).toBe("trace-1");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });
});
