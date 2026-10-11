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
});
