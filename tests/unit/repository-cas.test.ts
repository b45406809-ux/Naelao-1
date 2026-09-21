import { describe, expect, it } from "vitest";
import { RepositoryDO } from "../../workers/artifact/src/RepositoryDO.js";

function fixture() {
  const state = new Map<string, unknown>();
  const objects = new Map<string, Uint8Array>();
  const instance = new RepositoryDO({ storage: {
    get: async (key: string) => structuredClone(state.get(key)),
    put: async (key: string, value: unknown) => { state.set(key, structuredClone(value)); },
  } } as never, { REPOSITORY_OBJECTS: {
    head: async (key: string) => objects.has(key) ? {} : null,
    put: async (key: string, value: Uint8Array) => { objects.set(key, new Uint8Array(value)); },
    get: async (key: string) => { const value = objects.get(key); return value ? { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) } : null; },
  } } as never);
  const call = async (operation: string, method: string, body: Record<string, unknown> = {}) => {
    const response = await instance.fetch(new Request(`https://repo/${operation}`, { method, headers: { "content-type": "application/json", "x-repository-scope": JSON.stringify({ tenantId: "tenant", spaceId: "space", projectId: "project" }) }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, body: await response.json<any>() };
  };
  return { call };
}

describe("RepositoryDO SHA-256 compare-and-swap", () => {
  it("calculates exact-byte hashes and rejects stale update/delete attempts", async () => {
    const { call } = fixture();
    await call("init", "POST");
    const created = await call("write", "PUT", { path: "src/a.txt", content: "one" });
    expect(created.body.sha256).toMatch(/^[a-f0-9]{64}$/);
    const missingBase = await call("write", "PUT", { path: "src/a.txt", content: "two" });
    expect(missingBase.status).toBe(428);
    const stale = await call("write", "PUT", { path: "src/a.txt", content: "two", base_sha256: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error_code: "cas_conflict", current_sha256: created.body.sha256 });
    const updated = await call("write", "PUT", { path: "src/a.txt", content: "two", base_sha256: created.body.sha256 });
    expect(updated.status).toBe(200);
    expect((await call("file", "DELETE", { path: "src/a.txt", base_sha256: created.body.sha256 })).status).toBe(409);
    expect((await call("file", "DELETE", { path: "src/a.txt", base_sha256: updated.body.sha256 })).status).toBe(200);
  });
});
