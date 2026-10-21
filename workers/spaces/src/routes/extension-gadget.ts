import type { Hono } from "hono";
import type { Env } from "../index.js";
import { getDOName } from "@naelao/crypto";
import { verifyInternalToken } from "@naelao/http";
import { gadgetActorId } from "../do/MicroAppDO.js";

/** Internal-only bridge used by an already-authorized project workflow role. */
export function registerExtensionGadgetRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/spaces/:spaceId/internal/extensions/:installationId/gadgets/:primitiveId/:operation", async c => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
    const { spaceId, installationId, primitiveId, operation } = c.req.param();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(installationId) || !/^[a-z][a-z0-9_-]{1,63}$/.test(primitiveId)
      || !["list", "get", "insert", "update", "delete"].includes(operation)) return c.json({ error_code: "extension_gadget_request_invalid" }, 400);
    const body = await c.req.json<{ project_id?: unknown; workflow_id?: unknown; arguments?: unknown }>().catch(() => ({} as { project_id?: unknown; workflow_id?: unknown; arguments?: unknown }));
    const projectId = typeof body.project_id === "string" ? body.project_id : "";
    const workflowId = typeof body.workflow_id === "string" ? body.workflow_id : "";
    const args = body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments) ? body.arguments as Record<string, unknown> : {};
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return c.json({ error_code: "extension_gadget_project_required" }, 400);
    const spaceRow = await c.env.PLATFORM_DB.prepare(`SELECT s.id FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'`).bind(spaceId, tenantId).first();
    if (!spaceRow) return c.json({ error_code: "space_not_found" }, 404);
    const name = await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET);
    const stub = c.env.SPACE_DO.get(c.env.SPACE_DO.idFromName(name));
    const installed = await stub.fetch(new Request("http://space-do/workflow-installation?" + new URLSearchParams({ instance_id: installationId, tenant_id: tenantId, space_id: spaceId })));
    if (!installed.ok) return c.json({ error_code: "extension_installation_unavailable" }, installed.status === 404 ? 404 : 503);
    const value = await installed.json<{ instance?: { instance_id?: string; tenant_id?: string; space_id?: string; project_id?: string | null; instance_key?: string | null; status?: string; scope?: string }; manifest?: { id?: string; bundle?: { id?: string; version?: string; primitives?: Array<{ id?: string; kind?: string; entry?: string; toolNames?: string[] }>; workerRoles?: Array<{ principal?: string; execution?: string; invocation?: string; entry?: string; primitiveIds?: string[]; gadgetActions?: Array<{ gadgetId: string; operations: string[]; tables: string[] }> }> } } }>();
    const instance = value.instance, bundle = value.manifest?.bundle;
    if (!instance || instance.instance_id !== installationId || instance.tenant_id !== tenantId || instance.space_id !== spaceId
      || instance.project_id !== projectId || instance.status !== "active" || instance.scope !== "PROJECT_BOUND"
      || !bundle?.id || value.manifest?.id !== bundle.id || !bundle.version
      || !bundle.primitives?.some(part => part.id === primitiveId && part.kind === "gadget")) return c.json({ error_code: "extension_gadget_scope_mismatch" }, 403);
    const appId = instance.instance_key && instance.instance_key !== "default" ? `${instance.instance_key}_${primitiveId}` : primitiveId;
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "extension_gadget_identity_invalid" }, 400);
    const allowed = operation === "list" ? ["table", "filter", "limit"] : operation === "get" || operation === "delete" ? ["table", "id"] : operation === "insert" ? ["table", "record"] : ["table", "id", "record"];
    if (Object.keys(args).some(key => !allowed.includes(key))) return c.json({ error_code: "extension_gadget_arguments_invalid" }, 400);
    const workflow = bundle.primitives?.find(part => part.id === workflowId && part.kind === "workflow");
    const toolName = `extension.gadget.${operation}`;
    const roles = bundle.workerRoles?.filter(role => role.principal === "project_member" && role.execution === "worker"
      && ["workflow_step", "tool"].includes(role.invocation ?? "") && role.entry === workflow?.entry && role.primitiveIds?.includes(workflowId)) ?? [];
    const table = typeof args.table === "string" ? args.table : "";
    const actionAllowed = roles.length === 1 && workflow?.toolNames?.includes(toolName)
      && roles[0]?.gadgetActions?.some(grant => grant.gadgetId === primitiveId && grant.operations.includes(toolName) && grant.tables.includes(table));
    if (!actionAllowed) return c.json({ error_code: "extension_gadget_action_not_granted" }, 403);
    const actor = gadgetActorId(c.env.MICRO_APP_DO, { scope: "PROJECT_BOUND", spaceId, projectId, appId });
    const response = await c.env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/mcp", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-user-id": `workflow:${workflowId}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: `app_${appId}_${operation}`, arguments: args } }),
    }));
    return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
  });
}
