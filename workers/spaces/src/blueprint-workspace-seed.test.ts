import type { SpaceBlueprint } from "@naelao/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { SpaceDO } from "./do/SpaceDO.js";

const blueprint: SpaceBlueprint = {
  id: "starter-pack", schemaVersion: "2.0", metadata: { name: "Starter pack" }, templateCategory: "project",
  requiredExtensions: [], requiredCredentials: [],
  projects: [{ id: "demo", name: "Demo", kind: "DualPane", templateMode: "cowork_studio", viewports: {}, systemPrompt: "",
    initialTasks: [], starterFiles: [{ path: "index.html", content: "<h1>hello</h1>" }] }],
};

function fixture(initializationStatus = 201) {
  const events: string[] = [];
  const objects = new Map<string, Uint8Array>();
  const r2 = {
    put: vi.fn(async (key: string, value: string | Uint8Array) => {
      if (objects.has(key)) return null;
      objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value.slice());
      events.push(`put:${key}`);
      return { etag: "created" };
    }),
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer } : null;
    }),
    delete: vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); }),
  };
  const sql = { exec: vi.fn((query: string) => {
    if (query.includes("INSERT INTO projects")) events.push("project-visible");
    return { rowsWritten: 1, toArray: () => [], one: () => undefined, raw: function* () {}, [Symbol.iterator]: function* () {} };
  }) };
  const agents = { fetch: vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({})) as { scope?: { tenantId: string; spaceId: string; projectId: string; jurisdiction: string }; entries?: Array<{ path: string; sha256: string; size: number; objectKey: string }> };
    if (url.pathname.endsWith("/initialize")) {
      events.push("initialize-attempt");
      if (initializationStatus !== 201) return Response.json({ error_code: "workspace_init_failed" }, { status: initializationStatus });
      for (const entry of body.entries ?? []) {
        const bytes = objects.get(entry.objectKey);
        if (!bytes || bytes.byteLength !== entry.size) return Response.json({ error_code: "seed_bytes_missing" }, { status: 409 });
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        if (hash !== entry.sha256) return Response.json({ error_code: "seed_hash_mismatch" }, { status: 409 });
      }
      return Response.json({ created: true, head: { branch: "main", revision: 1 } }, { status: 201 });
    }
    if (url.pathname.endsWith("/erase") && body.scope) {
      events.push("rollback");
      const prefix = `workspace-v1/${body.scope.tenantId}/${body.scope.spaceId}/${body.scope.projectId}/${body.scope.jurisdiction}/`;
      for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key);
      return Response.json({ erased: true });
    }
    return new Response("not found", { status: 404 });
  }) };
  const instance = new SpaceDO({ storage: { sql, transactionSync: (run: () => unknown) => run(), put: vi.fn() } } as never,
    { PLATFORM_SECRET: "secret", UNIFIED_WORKSPACE_ENABLED: "true", SCRIPTS_R2: r2 as never, AGENTS_WORKER: agents as never });
  (instance as unknown as { initialized: boolean }).initialized = true;
  return { instance, events, objects, r2, agents };
}

describe("canonical blueprint workspace seeding", () => {
  it("verifies content and creates the initial coordinator revision before project visibility", async () => {
    const f = fixture();
    const result = await f.instance.instantiateBlueprint(blueprint, "space_01", "tenant_01");
    expect(result.fileCount).toBe(1);
    expect(f.events.indexOf("initialize-attempt")).toBeGreaterThanOrEqual(0);
    expect(f.events.indexOf("initialize-attempt")).toBeLessThan(f.events.indexOf("project-visible"));
    expect([...f.objects.keys()].every((key) => key.startsWith("workspace-v1/tenant_01/space_01/"))).toBe(true);
    expect(f.agents.fetch).toHaveBeenCalledOnce();
  });

  it("keeps projects invisible and rolls back attempted coordinator import on initialization failure", async () => {
    const f = fixture(503);
    await expect(f.instance.instantiateBlueprint(blueprint, "space_01", "tenant_01")).rejects.toThrow("workspace_seed_initialize_failed:503");
    expect(f.events).not.toContain("project-visible");
    expect(f.events).toContain("rollback");
    expect(f.objects.size).toBe(0);
  });
});
