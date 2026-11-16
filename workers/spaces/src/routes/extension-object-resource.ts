import type { Hono } from "hono";
import { digestExtensionManifest, resolveExtensionObjectResourceRequest, validateExtensionManifest } from "@naelao/agent-sdk";
import { getDOName } from "@naelao/crypto";
import { mintInternalToken, readBoundedRequestBytes, readBoundedResponseText, RequestBodyTooLargeError, verifyInternalToken } from "@naelao/http";
import type { Env } from "../index.js";
import { extensionRuntimeWork } from "./gadget-mcp.js";

type ObjectGrantProof = { manifest_sha256?: unknown; resource_sha256?: unknown; installation_generation?: unknown; grant_revision?: unknown };

/** Internal workflow bridge. The signed Project manifest and current owner grant are rechecked
 * before a fixed object operation reaches SpaceDO; extensions never provide a bucket or path. */
export function registerExtensionObjectResourceRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/spaces/:spaceId/internal/extensions/:installationId/objects", async c => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET))
      return c.json({ error_code: "forbidden" }, 403);
    const { spaceId, installationId } = c.req.param();
    if (!/^[A-Za-z0-9._:-]{1,768}$/.test(installationId)) return c.json({ error_code: "extension_object_installation_invalid" }, 400);
    let body: { project_id?: unknown; workflow_id?: unknown; requirement_id?: unknown; operation_id?: unknown; input?: unknown; grant?: ObjectGrantProof };
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readBoundedRequestBytes(c.req.raw, 256 * 1024))) as typeof body; }
    catch (error) { return c.json({ error_code: error instanceof RequestBodyTooLargeError ? "extension_object_request_too_large" : "extension_object_request_invalid" },
      error instanceof RequestBodyTooLargeError ? 413 : 400); }
    const projectId = typeof body.project_id === "string" ? body.project_id : "";
    const workflowId = typeof body.workflow_id === "string" ? body.workflow_id : "";
    const requirementId = typeof body.requirement_id === "string" ? body.requirement_id : "";
    const operationId = typeof body.operation_id === "string" ? body.operation_id : "";
    const proof = body.grant;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId) || !/^[a-z][a-z0-9_-]{0,63}$/.test(workflowId)
      || !/^[a-z][a-z0-9._-]{1,63}$/.test(requirementId) || !["get", "put", "delete"].includes(operationId)
      || !proof || !/^[a-f0-9]{64}$/.test(String(proof.manifest_sha256 ?? "")) || !/^[a-f0-9]{64}$/.test(String(proof.resource_sha256 ?? ""))
      || typeof proof.installation_generation !== "number" || !Number.isSafeInteger(proof.installation_generation) || proof.installation_generation < 1
      || typeof proof.grant_revision !== "number" || !Number.isSafeInteger(proof.grant_revision) || proof.grant_revision < 1)
      return c.json({ error_code: "extension_object_request_invalid" }, 400);
    const spaceRow = await c.env.PLATFORM_DB.prepare(`SELECT s.id FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'`).bind(spaceId, tenantId).first();
    if (!spaceRow) return c.json({ error_code: "space_not_found" }, 404);
    const name = await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET);
    const stub = c.env.SPACE_DO.get(c.env.SPACE_DO.idFromName(name));
    const installed = await stub.fetch(new Request("http://space-do/workflow-installation?" + new URLSearchParams({
      instance_id: installationId, tenant_id: tenantId, space_id: spaceId,
    })));
    if (!installed.ok) return c.json({ error_code: "extension_installation_unavailable" }, installed.status === 404 ? 404 : 503);
    const current = await installed.json<{ instance?: { instance_id?: string; tenant_id?: string; space_id?: string; project_id?: string | null;
      generation?: number; status?: string; scope?: string }; manifest?: unknown; resource_grants?: Array<Record<string, unknown>>;
      release?: { signatureValid?: boolean; dependenciesResolved?: boolean; publisher?: { keyId?: string; revoked?: boolean } } | null }>();
    let manifest: ReturnType<typeof validateExtensionManifest>;
    try { manifest = validateExtensionManifest(current.manifest); } catch { return c.json({ error_code: "extension_installation_manifest_invalid" }, 409); }
    const instance = current.instance;
    if (!instance || instance.instance_id !== installationId || instance.tenant_id !== tenantId || instance.space_id !== spaceId
      || instance.project_id !== projectId || instance.generation !== proof.installation_generation || instance.status !== "active"
      || instance.scope !== "PROJECT_BOUND" || current.release?.signatureValid !== true || current.release.dependenciesResolved !== true
      || current.release.publisher?.revoked) return c.json({ error_code: "extension_object_installation_changed" }, 409);
    if (typeof current.release.publisher?.keyId === "string") {
      const publisher = await c.env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM extension_publisher_keys
        WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(tenantId, spaceId, current.release.publisher.keyId).first();
      if (!publisher) return c.json({ error_code: "extension_publisher_revoked" }, 403);
    }
    const manifestSha256 = await digestExtensionManifest(manifest);
    if (manifestSha256 !== proof.manifest_sha256) return c.json({ error_code: "extension_object_grant_stale" }, 409);
    const resolved = resolveExtensionObjectResourceRequest({ manifest, workflowId, requirementId, operationId, input: body.input });
    if (!resolved) return c.json({ error_code: "extension_object_operation_not_declared" }, 403);
    // Resource approvals bind the requirement alone, so compute that exact digest here.
    const requirement = manifest.resourceRequirements?.find(item => item.id === requirementId && item.kind === "objects");
    if (!requirement) return c.json({ error_code: "extension_object_operation_not_declared" }, 403);
    const exactResourceSha256 = await (async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(requirement));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    })();
    if (exactResourceSha256 !== proof.resource_sha256) return c.json({ error_code: "extension_object_grant_stale" }, 409);
    const grant = current.resource_grants?.find(item => item.requirement_id === requirementId && item.status === "approved"
      && item.manifest_sha256 === manifestSha256 && item.resource_sha256 === exactResourceSha256
      && item.installation_generation === instance.generation && item.revision === proof.grant_revision
      && Array.isArray(item.operations) && item.operations.includes(operationId) && Array.isArray(item.tables) && item.tables.length === 0);
    if (!grant) return c.json({ error_code: "extension_object_owner_grant_required" }, 403);

    const workId = crypto.randomUUID();
    const admitted = await extensionRuntimeWork(c.env, { action: "acquire", tenantId, spaceId, projectId,
      installationId, workId, workKind: "gadget" });
    if (admitted.acquired !== true) return c.json({ error_code: admitted.errorCode ?? "extension_installation_inactive" }, 409);
    let leaseId: string | null = null;
    const internalHeaders = { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) };
    const releaseAll = async () => {
      if (leaseId) await stub.fetch(new Request("http://space-do/extension-resource-operation/release", { method: "POST", headers: internalHeaders,
        body: JSON.stringify({ tenantId, spaceId, projectId, instanceId: installationId, leaseId }) })).catch(() => undefined);
      await extensionRuntimeWork(c.env, { action: "release", tenantId, spaceId, projectId, installationId, workId, workKind: "gadget" });
    };
    try {
      const claim = await stub.fetch(new Request("http://space-do/extension-resource-operation", { method: "POST", headers: internalHeaders,
        body: JSON.stringify({ tenantId, spaceId, projectId, instanceId: installationId, requirementId, operationId, resourceKind: "objects",
          gadgetId: "objects", table: "objects", manifestSha256, resourceSha256: exactResourceSha256,
          installationGeneration: instance.generation, grantRevision: proof.grant_revision }) }));
      if (!claim.ok) {
        const text = await readBoundedResponseText(claim, 16 * 1024).catch(() => "{\"error_code\":\"extension_object_operation_claim_failed\"}");
        return new Response(text, { status: claim.status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
      }
      const claimed = await claim.json<{ lease_id?: unknown }>().catch(() => null);
      if (typeof claimed?.lease_id !== "string") return c.json({ error_code: "extension_object_operation_claim_invalid" }, 503);
      leaseId = claimed.lease_id;
      const response = await stub.fetch(new Request("http://space-do/extension-object-operation", { method: "POST", headers: internalHeaders,
        body: JSON.stringify({ tenantId, spaceId, projectId, instanceId: installationId, requirementId, operationId, leaseId,
          manifestSha256, resourceSha256: exactResourceSha256, installationGeneration: instance.generation,
          grantRevision: proof.grant_revision, input: resolved.value }) }));
      const text = await readBoundedResponseText(response, 128 * 1024).catch(() => "{\"error_code\":\"extension_object_result_invalid\"}");
      return new Response(text, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "private, no-store" } });
    } finally { await releaseAll(); }
  });
}
