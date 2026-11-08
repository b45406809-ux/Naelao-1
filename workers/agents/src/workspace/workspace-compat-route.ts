import { readBoundedRequestText, verifyInternalToken } from "@naelao/http";
import { workspaceCoordinatorRequest, type WorkspaceCoordinatorBindings } from "./workspace-client.js";
import { validateWorkspaceBranch, validateWorkspaceScope } from "./workspace-contract.js";

type Env = WorkspaceCoordinatorBindings & { UNIFIED_WORKSPACE_ENABLED?: string };

/** Read-only bridge used by compatibility clients after they authorize a user/project. */
export async function handleWorkspaceCompatRead(request: Request, env: Env): Promise<Response> {
  const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
  if (!tenantId || !env.PLATFORM_SECRET || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, tenantId, env.PLATFORM_SECRET)) return Response.json({ error_code: "forbidden" }, { status: 403 });
  if (env.UNIFIED_WORKSPACE_ENABLED !== "true") return Response.json({ canonical: false }, { headers: { "cache-control": "no-store" } });
  let body: { scope?: unknown; branch?: unknown; path?: unknown };
  try { body = JSON.parse(await readBoundedRequestText(request, 8 * 1024)) as typeof body; }
  catch { return Response.json({ error_code: "invalid_workspace_read_request" }, { status: 400 }); }
  if (!validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId ||
      (body.branch !== undefined && !validateWorkspaceBranch(body.branch)) ||
      (body.path !== undefined && (typeof body.path !== "string" || !body.path))) return Response.json({ error_code: "invalid_workspace_read_scope" }, { status: 400 });
  const branch = typeof body.branch === "string" ? body.branch : "main";
  const query = new URLSearchParams({ branch });
  if (typeof body.path === "string") query.append("path", body.path);
  const response = await workspaceCoordinatorRequest(env, body.scope, `/v1/read?${query}`, {});
  if (response.status === 404) return Response.json({ canonical: false }, { headers: { "cache-control": "no-store" } });
  if (!response.ok) return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") return Response.json({ error_code: "workspace_read_invalid_response" }, { status: 503 });
  return Response.json({ canonical: true, ...(payload as Record<string, unknown>) }, { headers: { "cache-control": "no-store" } });
}
