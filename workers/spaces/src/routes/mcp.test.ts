import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerProjectMcpRoutes } from "./mcp.js";

class MemoryBucket {
  data = new Map<string, string>();
  async get(key: string) { const value = this.data.get(key); return value === undefined ? null : { text: async () => value, httpEtag: "etag" }; }
  async put(key: string, value: string) { this.data.set(key, value); }
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
