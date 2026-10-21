import { describe, it, expect } from "vitest";
import { BuilderAccountDO } from "../../workers/spaces/src/do/BuilderAccountDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// Three-Tier Platform Model, Phase 1 (docs/spec-appendix A1.17). BuilderAccountDO is
// deliberately thin — a per-builder product index + scoped API keys — everything else
// (usage/billing/rate-limiting) reads from systems that already exist elsewhere.

function makeDO() {
  const ctx = { storage: createDOStorage() };
  return new BuilderAccountDO(ctx as never, {} as never);
}

async function call(doInstance: BuilderAccountDO, path: string, init?: RequestInit) {
  return doInstance.fetch(new Request(`http://do${path}`, init));
}

describe("BuilderAccountDO — product index", () => {
  it("indexes a product and lists it back", async () => {
    const doInstance = makeDO();
    const addRes = await call(doInstance, "/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product_space_id: "space-1" }),
    });
    expect(addRes.status).toBe(201);

    const listRes = await call(doInstance, "/products");
    const body = await listRes.json() as { data: Array<{ product_space_id: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.product_space_id).toBe("space-1");
  });

  it("adding the same product twice does not duplicate it", async () => {
    const doInstance = makeDO();
    await call(doInstance, "/products", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ product_space_id: "space-1" }),
    });
    await call(doInstance, "/products", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ product_space_id: "space-1" }),
    });
    const listRes = await call(doInstance, "/products");
    const body = await listRes.json() as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it("rejects a missing product_space_id", async () => {
    const doInstance = makeDO();
    const res = await call(doInstance, "/products", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("BuilderAccountDO — scoped API keys", () => {
  it("mints a key, returns the raw value once, and never re-exposes it in the list", async () => {
    const doInstance = makeDO();
    const createRes = await call(doInstance, "/api-keys", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Production", scopes: ["spaces:read"] }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { key: string; key_prefix: string; id: string };
    expect(created.key).toMatch(/^nbk_/);
    expect(created.key_prefix).toBe(created.key.slice(0, 11));

    const listRes = await call(doInstance, "/api-keys");
    const list = await listRes.json() as { data: Array<Record<string, unknown>> };
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).not.toHaveProperty("key");
    expect(list.data[0]).not.toHaveProperty("key_hash");
    expect(list.data[0]!["key_prefix"]).toBe(created.key_prefix);
    expect(list.data[0]!["scopes"]).toEqual(["spaces:read"]);
  });

  it("rejects creating a key with no scopes", async () => {
    const doInstance = makeDO();
    const res = await call(doInstance, "/api-keys", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Empty", scopes: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("verify resolves a valid key to its scopes and bumps last_used_at", async () => {
    const doInstance = makeDO();
    const createRes = await call(doInstance, "/api-keys", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "K", scopes: ["billing:read", "spaces:write"] }),
    });
    const created = await createRes.json() as { key: string };

    const verifyRes = await call(doInstance, "/api-keys/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: created.key }),
    });
    const verified = await verifyRes.json() as { valid: boolean; scopes: string[] };
    expect(verified.valid).toBe(true);
    expect(verified.scopes.sort()).toEqual(["billing:read", "spaces:write"]);

    const listRes = await call(doInstance, "/api-keys");
    const list = await listRes.json() as { data: Array<{ last_used_at: string | null }> };
    expect(list.data[0]!.last_used_at).not.toBeNull();
  });

  it("verify rejects a forged/unknown key", async () => {
    const doInstance = makeDO();
    const res = await call(doInstance, "/api-keys/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "nbk_forgedvalue" }),
    });
    const body = await res.json() as { valid: boolean };
    expect(body.valid).toBe(false);
  });

  it("verify rejects an expired key", async () => {
    const doInstance = makeDO();
    const createRes = await call(doInstance, "/api-keys", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Short-lived", scopes: ["spaces:read"], expires_in_days: -1 }),
    });
    const created = await createRes.json() as { key: string };

    const verifyRes = await call(doInstance, "/api-keys/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: created.key }),
    });
    const verified = await verifyRes.json() as { valid: boolean };
    expect(verified.valid).toBe(false);
  });

  it("revoking a key makes it fail verification and disappear from the list", async () => {
    const doInstance = makeDO();
    const createRes = await call(doInstance, "/api-keys", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ToRevoke", scopes: ["spaces:read"] }),
    });
    const created = await createRes.json() as { id: string; key: string };

    const revokeRes = await call(doInstance, `/api-keys/${created.id}`, { method: "DELETE" });
    expect(revokeRes.status).toBe(204);

    const listRes = await call(doInstance, "/api-keys");
    const list = await listRes.json() as { data: unknown[] };
    expect(list.data).toHaveLength(0);

    const verifyRes = await call(doInstance, "/api-keys/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: created.key }),
    });
    const verified = await verifyRes.json() as { valid: boolean };
    expect(verified.valid).toBe(false);
  });
});
