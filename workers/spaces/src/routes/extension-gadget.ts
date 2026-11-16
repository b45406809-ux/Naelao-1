import type { Hono } from "hono";
import type { Env } from "../index.js";
import { getDOName } from "@naelao/crypto";
import { mintInternalToken, readBoundedRequestBytes, RequestBodyTooLargeError, verifyInternalToken } from "@naelao/http";
import { gadgetActorId } from "../do/MicroAppDO.js";
import { extensionRuntimeWork, releaseRuntimeWorkAfterResponse } from "./gadget-mcp.js";

/** Internal-only bridge used by an already-authorized project workflow role. */
export function registerExtensionGadgetRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/spaces/:spaceId/internal/extensions/:installationId/gadgets/:primitiveId/:operation", async c => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
    const { spaceId, installationId, primitiveId, operation } = c.req.param();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(installationId) || !/^[a-z][a-z0-9_-]{1,63}$/.test(primitiveId)
      || !["list", "get", "insert", "update", "delete"].includes(operation)) return c.json({ error_code: "extension_gadget_request_invalid" }, 400);
    let body: { project_id?: unknown; workflow_id?: unknown; arguments?: unknown; resource_mode?: unknown; resource_grant?: unknown };
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readBoundedRequestBytes(c.req.raw, 300 * 1024))) as typeof body; }
    catch (error) { return c.json({ error_code: error instanceof RequestBodyTooLargeError ? "extension_gadget_request_too_large" : "extension_gadget_request_invalid" },
      error instanceof RequestBodyTooLargeError ? 413 : 400); }
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
    const value = await installed.json<{ instance?: { instance_id?: string; tenant_id?: string; space_id?: string; project_id?: string | null; instance_key?: string | null; status?: string; scope?: string }; manifest?: { id?: string; bundle?: { id?: string; version?: string; primitives?: Array<{ id?: string; kind?: string; entry?: string; toolNames?: string[] }>; workerRoles?: Array<{ principal?: string; execution?: string; invocation?: string; entry?: string; primitiveIds?: string[]; gadgetActions?: Array<{ gadgetId: string; operations: string[]; tables: string[] }> }> } }; release?: { signatureValid?: boolean; dependenciesResolved?: boolean; publisher?: { keyId?: string; revoked?: boolean } } | null }>();
    const instance = value.instance, bundle = value.manifest?.bundle;
    if (typeof value.release?.publisher?.keyId === "string") {
      const active = await c.env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM extension_publisher_keys
        WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(tenantId, spaceId, value.release.publisher.keyId).first();
      if (!active) return c.json({ error_code: "extension_publisher_revoked" }, 403);
    }
    if (!instance || instance.instance_id !== installationId || instance.tenant_id !== tenantId || instance.space_id !== spaceId
      || instance.project_id !== projectId || instance.status !== "active" || instance.scope !== "PROJECT_BOUND"
      || !bundle?.id || value.manifest?.id !== bundle.id || !bundle.version
      || !bundle.primitives?.some(part => part.id === primitiveId && part.kind === "gadget")
      || value.release?.signatureValid !== true || value.release.dependenciesResolved !== true || value.release.publisher?.revoked)
      return c.json({ error_code: value.release?.dependenciesResolved === false ? "extension_dependency_unavailable" : "extension_gadget_scope_mismatch" }, 403);
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
    if (body.resource_mode !== undefined && body.resource_mode !== "structured_data")
      return c.json({ error_code: "extension_resource_mode_invalid" }, 400);
    const resourceGrant = body.resource_grant && typeof body.resource_grant === "object" && !Array.isArray(body.resource_grant)
      ? body.resource_grant as Record<string, unknown> : null;
    if (body.resource_mode === "structured_data" && !resourceGrant)
      return c.json({ error_code: "extension_resource_owner_grant_required" }, 403);
    let resourceLeaseId: string | null = null;
    if (resourceGrant) {
      const requirementId = typeof resourceGrant.requirement_id === "string" ? resourceGrant.requirement_id : "";
      const resourceOperationId = typeof resourceGrant.operation_id === "string" ? resourceGrant.operation_id : "";
      const resourceGadgetId = typeof resourceGrant.gadget_id === "string" ? resourceGrant.gadget_id : "";
      if (body.resource_mode !== "structured_data" || resourceOperationId !== operation || resourceGadgetId !== primitiveId
        || requirementId.length > 64 || typeof resourceGrant.manifest_sha256 !== "string" || typeof resourceGrant.resource_sha256 !== "string")
        return c.json({ error_code: "extension_resource_grant_proof_invalid" }, 400);
    }
    const actor = gadgetActorId(c.env.MICRO_APP_DO, { scope: "PROJECT_BOUND", spaceId, projectId, appId });
    const workId = crypto.randomUUID();
    const admitted = await extensionRuntimeWork(c.env, { action: "acquire", tenantId, spaceId, projectId,
      installationId, workId, workKind: "gadget" });
    if (admitted.acquired !== true) {
      return c.json({ error_code: admitted.errorCode ?? "extension_installation_inactive" }, 409);
    }
    const release = () => extensionRuntimeWork(c.env, { action: "release", tenantId, spaceId, projectId, installationId, workId, workKind: "gadget" });
    if (resourceGrant) {
      const requirementId = String(resourceGrant.requirement_id), resourceOperationId = String(resourceGrant.operation_id), resourceGadgetId = String(resourceGrant.gadget_id);
      const claim = await stub.fetch(new Request("http://space-do/extension-resource-operation", { method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
          "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
        body: JSON.stringify({ tenantId, spaceId, projectId, instanceId: installationId, requirementId,
          operationId: resourceOperationId, gadgetId: resourceGadgetId, table,
          manifestSha256: resourceGrant.manifest_sha256, resourceSha256: resourceGrant.resource_sha256,
          installationGeneration: resourceGrant.installation_generation, grantRevision: resourceGrant.grant_revision }) }));
      if (!claim.ok) {
        await release();
        return new Response(claim.body, { status: claim.status, headers: { "content-type": claim.headers.get("content-type") ?? "application/json" } });
      }
      const claimBody = await claim.json<{ lease_id?: unknown }>().catch(() => null);
      if (typeof claimBody?.lease_id !== "string") {
        await release();
        return c.json({ error_code: "extension_resource_operation_claim_invalid" }, 503);
      }
      resourceLeaseId = claimBody.lease_id;
    }
    const releaseAll = async () => {
      await release();
      if (resourceLeaseId) await stub.fetch(new Request("http://space-do/extension-resource-operation/release", { method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
          "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
        body: JSON.stringify({ tenantId, spaceId, projectId, instanceId: installationId, leaseId: resourceLeaseId }) })).catch(() => undefined);
    };
    try {
      const response = await c.env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/mcp", {
        method: "POST", headers: { "content-type": "application/json", "x-naelao-user-id": `workflow:${workflowId}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: `app_${appId}_${operation}`, arguments: args } }),
      }));
      const relayed = new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
      return await releaseRuntimeWorkAfterResponse(relayed, releaseAll);
    } catch (error) { await releaseAll(); throw error; }
  });
}
