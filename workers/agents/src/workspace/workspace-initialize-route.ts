import { readBoundedRequestText, verifyInternalToken } from "@naelao/http";
import { workspaceCoordinatorRequest, type WorkspaceCoordinatorBindings } from "./workspace-client.js";
import { validateWorkspaceScope } from "./workspace-contract.js";

type Env = WorkspaceCoordinatorBindings & { PLATFORM_SECRET?: string; UNIFIED_WORKSPACE_ENABLED?: string };

/** Initializes a project head from already staged immutable, content-addressed objects. */
export async function handleWorkspaceInitialize(request: Request, env: Env): Promise<Response> {
  const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
  if (!tenantId || !env.PLATFORM_SECRET || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, tenantId, env.PLATFORM_SECRET)) return Response.json({ error_code: "forbidden" }, { status: 403 });
  if (env.UNIFIED_WORKSPACE_ENABLED !== "true") return Response.json({ error_code: "workspace_global_kill_switch_active" }, { status: 423 });
  let body: { scope?: unknown; entries?: unknown };
  try { body = JSON.parse(await readBoundedRequestText(request, 8 * 1024 * 1024)) as typeof body; }
  catch { return Response.json({ error_code: "invalid_workspace_initialize_request" }, { status: 400 }); }
  if (!validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId || !Array.isArray(body.entries) || body.entries.length > 10_000) return Response.json({ error_code: "invalid_workspace_initialize_scope" }, { status: 400 });
  const response = await workspaceCoordinatorRequest(env, body.scope, "/v1/initialize", { body: { scope: body.scope, branch: "main", entries: body.entries } });
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
