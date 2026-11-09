import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerProjectMcpRoutes } from "./mcp.js";

class MemoryBucket {
  data = new Map<string, string>();
  private async hash(value: string) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
  async head(key: string) { const value = this.data.get(key); return value === undefined ? null : { key, etag: "etag", size: value.length, customMetadata: { sha256: await this.hash(value) } }; }
  async get(key: string) { const value = this.data.get(key); return value === undefined ? null : { text: async () => value, arrayBuffer: async () => new TextEncoder().encode(value).buffer, httpEtag: "etag", customMetadata: { sha256: await this.hash(value) } }; }
  async put(key: string, value: string | Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
    const previous = this.data.get(key);
    if (options?.onlyIf?.etagMatches && previous === undefined) return null;
    if (options?.onlyIf?.etagDoesNotMatch === "*" && previous !== undefined) return null;
    this.data.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
    return { etag: "etag-next" };
  }
  async list({ prefix }: { prefix: string }) { return { objects: [...this.data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), delimitedPrefixes: [] }; }
}

describe("project MCP Streamable HTTP endpoint", () => {
  it("lists and calls project tools without a stateful session", async () => {
    const app = new Hono<{ Bindings: { SCRIPTS_R2: R2Bucket } }>();
    registerProjectMcpRoutes(app, async () => null);
    const bucket = new MemoryBucket();
    bucket.data.set("spaces/s/projects/p/workspace/readme.md", "hello");
    const rpc = (body: unknown) => app.request("/spaces/s/projects/p/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, { SCRIPTS_R2: bucket as unknown as R2Bucket });
    const listed = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json() as any;
    expect(listed.result.tools.map((tool: any) => tool.name)).toContain("readWorkspaceFile");
    const called = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "readWorkspaceFile", arguments: { path: "readme.md" } } })).json() as any;
    expect(called.result.content[0].text).toContain("hello");
  });

  it("fails closed when project authorization rejects the caller", async () => {
    const app = new Hono<{ Bindings: { SCRIPTS_R2: R2Bucket } }>();
    registerProjectMcpRoutes(app, async () => Response.json({ error: "forbidden" }, { status: 403 }));
    const response = await app.request("/spaces/s/projects/foreign/mcp", { method: "POST" }, { SCRIPTS_R2: new MemoryBucket() as unknown as R2Bucket });
    expect(response.status).toBe(403);
  });

  it("serializes feature-off project patches through the migration barrier adapter", async () => {
    const app = new Hono<{ Bindings: { SCRIPTS_R2: R2Bucket; AGENTS_WORKER: Fetcher; PLATFORM_SECRET: string; UNIFIED_WORKSPACE_ENABLED: string } }>();
    registerProjectMcpRoutes(app, async () => null);
    const bucket = new MemoryBucket();
    bucket.data.set("spaces/s/projects/p/workspace/readme.md", "before");
    let legacyBody: Record<string, unknown> | null = null;
    const agentsWorker = { fetch: async (request: Request) => {
      if (new URL(request.url).pathname.endsWith("/legacy-write")) {
        legacyBody = await request.json() as Record<string, unknown>;
        return Response.json({ written: true, hash: "a".repeat(64) });
      }
      return Response.json({ error_code: "unexpected_route" }, { status: 404 });
    } } as unknown as Fetcher;
    const response = await app.request("/spaces/s/projects/p/mcp", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "user" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "runAstPatch", arguments: { path: "readme.md", oldText: "before", newText: "after" } } }) },
      { SCRIPTS_R2: bucket as unknown as R2Bucket, AGENTS_WORKER: agentsWorker, PLATFORM_SECRET: "test-secret", UNIFIED_WORKSPACE_ENABLED: "false" });
    const result = await response.json() as any;
    expect(result.result.content[0].text).toContain('"hash"');
    expect(legacyBody).toMatchObject({ scope: { tenantId: "tenant", spaceId: "s", projectId: "p" }, actorId: "user", path: "readme.md", expectedHash: expect.stringMatching(/^[a-f0-9]{64}$/), idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const encoded = (legacyBody as Record<string, unknown>).contentBase64 as string;
    expect(new TextDecoder().decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0)))).toBe("after");
    expect(bucket.data.get("spaces/s/projects/p/workspace/readme.md")).toBe("before");
  });

  it("serves project MCP reads from the canonical manifest in unified mode", async () => {
    const app = new Hono<{ Bindings: { SCRIPTS_R2: R2Bucket; AGENTS_WORKER: Fetcher; PLATFORM_SECRET: string; UNIFIED_WORKSPACE_ENABLED: string } }>();
    registerProjectMcpRoutes(app, async () => null);
    const bucket = new MemoryBucket();
    bucket.data.set("spaces/s/projects/p/workspace/readme.md", "stale legacy text");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("canonical text"));
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const objectKey = `workspace-v1/tenant/s/p/global/content/${sha256}`;
    bucket.data.set(objectKey, "canonical text");
    const entry = { path: "readme.md", sha256, size: 14, executable: false, objectKey };
    let checkedBody: Record<string, unknown> | null = null;
    const agentsWorker = { fetch: async (request: Request) => {
      if (new URL(request.url).pathname.endsWith("/checked-publish")) {
        checkedBody = await request.json() as Record<string, unknown>;
        return Response.json({ publication: { status: "published", revision: 2 } });
      }
      return Response.json({ canonical: true, head: { branch: "main", revision: 1, updatedAt: "2026-11-08T00:00:00Z" }, entries: [entry] });
    } } as unknown as Fetcher;
    const env = { SCRIPTS_R2: bucket as unknown as R2Bucket, AGENTS_WORKER: agentsWorker, PLATFORM_SECRET: "test-secret", UNIFIED_WORKSPACE_ENABLED: "true" };
    const rpc = (name: string, args: Record<string, unknown>) => app.request("/spaces/s/projects/p/mcp", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }, env);
    const read = await (await rpc("readWorkspaceFile", { path: "readme.md" })).json() as any;
    expect(read.result.content[0].text).toContain("canonical text");
    expect(read.result.content[0].text).not.toContain("stale legacy text");
    const list = await (await rpc("listDirectory", {})).json() as any;
    expect(list.result.content[0].text).toContain("readme.md");
    const patched = await (await rpc("runAstPatch", { path: "readme.md", oldText: "canonical", newText: "changed" })).json() as any;
    expect(patched.result.content[0].text).toContain('"revision":2');
    expect(checkedBody).toMatchObject({ branch: "main", path: "readme.md", expectedHash: sha256, idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const encoded = (checkedBody as Record<string, unknown>).contentBase64 as string;
    expect(new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)))).toBe("changed text");
    expect(bucket.data.get("spaces/s/projects/p/workspace/readme.md")).toBe("stale legacy text");
  });
});
