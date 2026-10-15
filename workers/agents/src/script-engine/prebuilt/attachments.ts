/** Task-scoped attachment CLI operations. IDs are opaque handles, never storage locations. */
import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";
import { workspacePrefix } from "../types.js";

async function call(ctx: PrebuiltOpContext, path: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!ctx.env.taskId) throw new Error(`attachment ${path.endsWith("/list") ? "list" : "read"} requires an active task run`);
  if (!ctx.env.agentsWorker) throw new Error("attachment tool unavailable: Agents Worker binding not configured");
  const endpoint = path.startsWith("/") ? path : `/internal/attachments/${path}`;
  const response = await ctx.env.agentsWorker.fetch(new Request(`http://agents-worker${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": ctx.env.tenantId,
      "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
    },
    body: JSON.stringify({ tenantId: ctx.env.tenantId, spaceId: ctx.env.spaceId, taskId: ctx.env.taskId, ...args }),
  }));
  const result = await response.json<Record<string, unknown>>().catch(() => null);
  if (!response.ok || !result || result.error_code) throw new Error(`attachment ${path} failed: ${String(result?.error_code ?? response.status)}`);
  return result;
}

const list = async (_args: Record<string, unknown>, ctx: PrebuiltOpContext) => call(ctx, "list");
const inspect = async (args: Record<string, unknown>, ctx: PrebuiltOpContext) => {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) throw new Error("usage: attachment inspect <id>");
  return call(ctx, "inspect", { id });
};
const read = async (args: Record<string, unknown>, ctx: PrebuiltOpContext) => {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) throw new Error("usage: attachment read <id>");
  return call(ctx, "/internal/business-email/attachment/read-text", { id });
};
const ocr = async (args: Record<string, unknown>, ctx: PrebuiltOpContext) => {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) throw new Error("usage: attachment ocr <id>");
  return call(ctx, "/internal/business-email/attachment/ocr", {
    id, agentId: ctx.env.agentId,
    ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}),
  });
};
const copy = async (args: Record<string, unknown>, ctx: PrebuiltOpContext) => {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!id || !path) throw new Error("usage: attachment copy <id> <workspace-path>");
  const clean = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = clean.split("/");
  if (clean.length > 512 || parts.some(part => !part || part === "." || part === "..") ||
      parts.some(part => [".avos", ".naelao", ".git", "node_modules", ".env"].includes(part) || part.startsWith(".env."))) {
    throw new Error("attachment_workspace_path_rejected");
  }
  const prefix = workspacePrefix(ctx.env);
  return call(ctx, "copy", {
    id, path: clean, projectId: ctx.env.projectId ?? null,
    extensionId: ctx.env.spaceWorkspaceExtensionId ?? null,
    workspaceBranch: ctx.env.workspaceBranch ?? null,
    destinationKey: `${prefix}${clean}`,
  });
};

export const attachments: PrebuiltScript = {
  name: "attachments",
  description: "List task-owned inbound files and read them only when needed. Reading is explicit; storage-only handling never decodes content.",
  domain: "files",
  requires_tier: 1,
  operations: { "attachment.list": list, "attachment.inspect": inspect, "attachment.read": read, "attachment.ocr": ocr, "attachment.copy": copy },
  paramHints: {
    "attachment.list": "No parameters. Lists metadata for files received by this task only.",
    "attachment.inspect": "{id:string}. Gets metadata only for one file received by this task; does not open or decode its bytes.",
    "attachment.read": "{id:string}. Reads supported text, DOCX or PDF text from one task-owned file; binary image OCR is a separate explicit operation.",
    "attachment.ocr": "{id:string}. Requests hosted OCR for a task-owned image or at most five pages of a small scanned PDF. Requires Space-owner enablement and allowed egress.",
    "attachment.copy": "{id:string,path:string}. Copies original bytes to the current authorized workspace without decoding or sending them to a model; refuses an existing destination.",
  },
};
