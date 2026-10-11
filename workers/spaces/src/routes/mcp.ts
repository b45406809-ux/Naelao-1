import type { Hono } from "hono";
import { putBytesCas, readBytesWithHash } from "../../../agents/src/script-engine/r2-cas.js";

type RpcId = string | number | null;
type RpcRequest = { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown> };

const TOOLS = [
  { name: "readWorkspaceFile", description: "Read a UTF-8 file from this project's workspace.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "listDirectory", description: "List files below a project workspace directory.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "runAstPatch", description: "Atomically replace an exact source fragment in a project file.", inputSchema: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] } },
  { name: "getProjectJournal", description: "Read the project's durable journal.", inputSchema: { type: "object", properties: {} } },
] as const;

function safePath(value: unknown): string {
  const path = String(value ?? "").replace(/^\/+/, "");
  if (!path || path.includes("\0") || path.split("/").some((part) => part === "..")) throw new Error("invalid workspace path");
  return path;
}

function result(id: RpcId | undefined, value: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result: value }, { headers: { "mcp-protocol-version": "2025-03-26" } });
}

function rpcError(id: RpcId | undefined, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status: 200, headers: { "mcp-protocol-version": "2025-03-26" } });
}

/** Register the stateless Streamable HTTP MCP endpoint. Authentication is supplied by the
 * spaces worker's normal internal-HMAC gate; authorizeProject additionally enforces the target
 * project's ACL for every request, including calls made by another project. */
export function registerProjectMcpRoutes<Env extends { SCRIPTS_R2?: R2Bucket }>(
  app: Hono<{ Bindings: Env }>,
  authorizeProject: (c: any, spaceId: string, projectId: unknown) => Promise<Response | null>,
): void {
  app.post("/spaces/:spaceId/projects/:projectId/mcp", async (c) => {
    const { spaceId, projectId } = c.req.param();
    const denied = await authorizeProject(c, spaceId, projectId);
    if (denied) return denied;
    if (!c.env.SCRIPTS_R2) return c.json({ error_code: "workspace_unavailable", message: "Project workspace is not configured" }, 503);

    const request = await c.req.json<RpcRequest>().catch(() => null);
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return rpcError(request?.id, -32600, "Invalid JSON-RPC 2.0 request");
    if (request.method === "initialize") return result(request.id, { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "naelao-project", version: "2" } });
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "tools/list") return result(request.id, { tools: TOOLS });
    if (request.method !== "tools/call") return rpcError(request.id, -32601, "Method not found");

    const tool = String(request.params?.["name"] ?? "");
    const args = (request.params?.["arguments"] && typeof request.params["arguments"] === "object" ? request.params["arguments"] : {}) as Record<string, unknown>;
    const prefix = `spaces/${spaceId}/projects/${projectId}/workspace/`;
    try {
      let value: unknown;
      if (tool === "readWorkspaceFile") {
        const key = prefix + safePath(args["path"]);
        const object = await readBytesWithHash(c.env.SCRIPTS_R2, key);
        if (!object) throw new Error("file not found");
        value = { content: new TextDecoder().decode(object.bytes), etag: object.etag };
      } else if (tool === "listDirectory") {
        const path = args["path"] ? `${safePath(args["path"]).replace(/\/$/, "")}/` : "";
        const listing = await c.env.SCRIPTS_R2.list({ prefix: prefix + path, delimiter: "/", limit: 1000 });
        value = { files: listing.objects.filter((o) => o.customMetadata?.deleted !== "true").map((o) => o.key.slice(prefix.length)), directories: listing.delimitedPrefixes.map((p) => p.slice(prefix.length)) };
      } else if (tool === "runAstPatch") {
        const key = prefix + safePath(args["path"]);
        const oldText = String(args["oldText"] ?? "");
        if (!oldText) throw new Error("oldText is required");
        const object = await readBytesWithHash(c.env.SCRIPTS_R2, key);
        if (!object) throw new Error("file not found");
        const source = new TextDecoder().decode(object.bytes);
        const first = source.indexOf(oldText);
        if (first < 0) throw new Error("patch target not found");
        if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error("patch target is ambiguous");
        const updated = source.slice(0, first) + String(args["newText"] ?? "") + source.slice(first + oldText.length);
        await putBytesCas(c.env.SCRIPTS_R2, key, new TextEncoder().encode(updated), object.hash, {}, { contentType: "text/plain; charset=utf-8" });
        value = { patched: true, path: args["path"] };
      } else if (tool === "getProjectJournal") {
        const object = await readBytesWithHash(c.env.SCRIPTS_R2, `spaces/${spaceId}/projects/${projectId}/PROJECT.md`);
        value = { markdown: object ? new TextDecoder().decode(object.bytes) : "" };
      } else {
        return rpcError(request.id, -32602, `Unknown project tool: ${tool}`);
      }
      return result(request.id, { content: [{ type: "text", text: JSON.stringify(value) }] });
    } catch (error) {
      return result(request.id, { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Tool call failed" }] });
    }
  });
}
