import { afterEach, describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

function env(options: { owned?: boolean; airGapped?: boolean } = {}) {
  const aiRun = vi.fn();
  const vectorQuery = vi.fn();
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "secret",
    PLATFORM_DB: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => sql.includes("tenant_id = ?")
            ? options.owned === false ? null : { id: "space" }
            : { config_json: options.airGapped === false ? "{}" : '{"compliance":{"airGappedOnly":true}}' }),
        })),
      })),
    } as unknown as D1Database,
    AI: { run: aiRun } as unknown as Ai,
    KB_VECTORS: { query: vectorQuery } as unknown as VectorizeIndex,
  } as Parameters<NonNullable<typeof worker.fetch>>[1] & {
    AI: Ai;
    KB_VECTORS: VectorizeIndex;
  };
}

describe("knowledge air-gap boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blocks semantic search before Workers AI, Vectorize, or web egress", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const bindings = env();
    const token = await mintInternalToken("secret", "tenant");
    const response = await worker.fetch!(new Request("https://knowledge/spaces/s/kb/search?q=secret", {
      headers: {
        "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": token,
      },
    }), bindings, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "air_gap_egress_denied" });
    expect((bindings.AI as unknown as { run: ReturnType<typeof vi.fn> }).run).not.toHaveBeenCalled();
    expect((bindings.KB_VECTORS as unknown as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each(["search", "fetch", "extract", "download"])(
    "blocks internal web %s before SSRF resolution or outbound fetch",
    async (operation) => {
      const outbound = vi.fn();
      vi.stubGlobal("fetch", outbound);
      const token = await mintInternalToken("secret", "tenant");
      const response = await worker.fetch!(new Request(`https://knowledge/internal/web-search/${operation}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant",
          "x-naelao-space-id": "s",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify(operation === "search" ? { query: "secret" } : { url: "https://example.com" }),
      }), env(), {} as ExecutionContext);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error_code: "air_gap_egress_denied" });
      expect(outbound).not.toHaveBeenCalled();
    },
  );

  it("fails closed when an internal web caller omits its space identity", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const token = await mintInternalToken("secret", "tenant");
    const response = await worker.fetch!(new Request("https://knowledge/internal/web-search/fetch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": token,
      },
      body: JSON.stringify({ url: "https://example.com" }),
    }), env(), {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("does not let a tenant borrow another space's less restrictive egress policy", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const token = await mintInternalToken("secret", "tenant-a");
    const bindings = env({ owned: false, airGapped: false });
    const response = await worker.fetch!(new Request("https://knowledge/internal/web-search/fetch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-space-id": "space-b", "x-naelao-internal-token": token },
      body: JSON.stringify({ url: "https://example.com" }),
    }), bindings, {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(outbound).not.toHaveBeenCalled();
  });
});
