import { readBoundedRequestText, verifyInternalToken } from "@naelao/http";
import { workspaceCoordinatorRequest, type WorkspaceCoordinatorBindings } from "./workspace-client.js";
import { validateWorkspaceBranch, validateWorkspacePath, validateWorkspaceScope } from "./workspace-contract.js";

type Env = WorkspaceCoordinatorBindings & { PLATFORM_SECRET?: string };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/** Checked one-shot adapter for authorized service clients. It never writes legacy R2. */
export async function handleWorkspaceCheckedPublish(request: Request, env: Env): Promise<Response> {
  const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
  if (!tenantId || !env.PLATFORM_SECRET || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, tenantId, env.PLATFORM_SECRET)) return Response.json({ error_code: "forbidden" }, { status: 403 });
  let body: { scope?: unknown; branch?: unknown; actorId?: unknown; path?: unknown; expectedHash?: unknown; contentBase64?: unknown; idempotencyKey?: unknown };
  try { body = JSON.parse(await readBoundedRequestText(request, 1_100_000)) as typeof body; }
  catch { return Response.json({ error_code: "invalid_workspace_publish_request" }, { status: 400 }); }
  if (!validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId || (body.branch !== undefined && !validateWorkspaceBranch(body.branch)) || typeof body.actorId !== "string" || !ID.test(body.actorId) ||
      typeof body.path !== "string" || !validateWorkspacePath(body.path) ||
      !(body.expectedHash === null || (typeof body.expectedHash === "string" && /^[a-f0-9]{64}$/.test(body.expectedHash))) ||
      !(body.contentBase64 === null || (typeof body.contentBase64 === "string" && body.contentBase64.length <= 1_048_576)) || typeof body.idempotencyKey !== "string" || !ID.test(body.idempotencyKey)) {
    return Response.json({ error_code: "invalid_workspace_publish_request" }, { status: 400 });
  }
  const scope = body.scope;
  const branch = typeof body.branch === "string" ? body.branch : "main";
  const headResponse = await workspaceCoordinatorRequest(env, scope, `/v1/head?branch=${branch}`, {});
  if (!headResponse.ok) return new Response(headResponse.body, { status: headResponse.status, headers: { "content-type": "application/json" } });
  const headPayload = await headResponse.json() as { head?: { revision?: number } };
  const revision = headPayload.head?.revision;
  if (!Number.isSafeInteger(revision)) return Response.json({ error_code: "workspace_head_invalid" }, { status: 503 });
  const runtimeId = "spaces-checked-publisher";
  const opened = await workspaceCoordinatorRequest(env, scope, "/v1/open", { body: { scope, branch, actorId: body.actorId, runtimeId, allocationGeneration: 1, mode: "checked_handoff" } });
  if (!opened.ok) return new Response(opened.body, { status: opened.status, headers: { "content-type": "application/json" } });
  const openPayload = await opened.json() as { session?: { id?: string; fence?: number }; head?: { revision?: number } };
  const sessionId = openPayload.session?.id;
  const fence = openPayload.session?.fence;
  const baseRevision = openPayload.head?.revision;
  if (typeof sessionId !== "string" || !Number.isSafeInteger(fence) || !Number.isSafeInteger(baseRevision) || baseRevision !== revision) {
    if (sessionId) await workspaceCoordinatorRequest(env, scope, "/v1/close", { body: { sessionId, runtimeId } }).catch(() => undefined);
    return Response.json({ error_code: "workspace_head_changed" }, { status: 409 });
  }
  const stageId = crypto.randomUUID();
  try {
    const staged = await workspaceCoordinatorRequest(env, scope, "/v1/stage", { body: { sessionId, stageId, allocationGeneration: 1, fence,
      changes: [{ path: body.path, expectedHash: body.expectedHash, contentBase64: body.contentBase64 }] } });
    if (!staged.ok) return new Response(staged.body, { status: staged.status, headers: { "content-type": "application/json" } });
    const committed = await workspaceCoordinatorRequest(env, scope, "/v1/checkpoint", { body: { sessionId, stageId, runtimeId, baseRevision, allocationGeneration: 1, fence, idempotencyKey: body.idempotencyKey } });
    return new Response(committed.body, { status: committed.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } finally {
    await workspaceCoordinatorRequest(env, scope, "/v1/close", { body: { sessionId, runtimeId } }).catch(() => undefined);
  }
}
