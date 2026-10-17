import { durableWorkflowRunId, serializeWorkflowCheckpoint, validateDurableWorkflowIdentity, validateWorkflowPointer, workflowArtifactPrefix, type DurableWorkflowIdentity, type WorkflowCheckpointPointer, type WorkflowClass } from "@naelao/agent-sdk";
import { mintInternalToken } from "@naelao/http";
import type { WorkerLoaderBinding } from "../script-engine/code-runner.js";
import { SkillLibrary } from "../script-engine/skill-library.js";
import type { WorkflowRunDO } from "../do/WorkflowRunDO.js";

export interface WorkflowProviderInstance { id: string; status(): Promise<{ status: string; output?: unknown; error?: unknown }>; terminate(): Promise<void>; restart(): Promise<void>; sendEvent(event: { type: string; payload: unknown }): Promise<void> }
export interface DurableWorkflowHostEnv {
  PLATFORM_SECRET: string;
  SCRIPTS_R2?: R2Bucket | undefined;
  WORKFLOW_RUN_DO?: DurableObjectNamespace<WorkflowRunDO> | undefined;
  AGENT_SCRIPT_WORKFLOW?: { create(options: { id?: string; params?: unknown }): Promise<WorkflowProviderInstance>; get(id: string): Promise<WorkflowProviderInstance> } | undefined;
  SPACES_WORKER: Fetcher;
  AGENTS_WORKER?: Fetcher | undefined;
  BILLING_WORKER?: Fetcher | undefined;
  LOADER?: WorkerLoaderBinding | undefined;
}
export async function workflowHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function workflowRunStub(env: DurableWorkflowHostEnv, scope: Pick<DurableWorkflowIdentity, "tenantId" | "spaceId" | "runId">) {
  if (!env.WORKFLOW_RUN_DO) throw new Error("workflow_journal_unavailable");
  return env.WORKFLOW_RUN_DO.get(env.WORKFLOW_RUN_DO.idFromName("workflow:" + scope.tenantId + ":" + scope.spaceId + ":" + scope.runId));
}
export async function workflowHeaders(env: DurableWorkflowHostEnv, tenantId: string, actorId?: string): Promise<Record<string, string>> {
  return { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId), ...(actorId ? { "x-naelao-user-id": actorId } : {}) };
}
/** Changes to membership, installation or agent configuration invalidate resumed grants. */
export interface WorkflowInstallationGrant {
  instance: { tenant_id: string; space_id: string; project_id?: string | null; user_id?: string | null; scope?: string; status: string };
  manifest: { id?: string; daemons?: Array<{ workflowScript?: string }> };
  release?: { version?: string; artifactSha256?: string; signatureValid?: boolean } | null;
}
/** Recompute the canonical release digest over immutable extension files before loading code.
 * The DO's internal attestation check establishes that the recorded digest/manifest pair was
 * accepted by this host; this check establishes that R2 still contains those exact bytes. */
export async function verifyExtensionArtifactSet(bucket: R2Bucket, input: { spaceId: string; extensionId: string; version: string; expectedSha256: string }): Promise<boolean> {
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(input.extensionId) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)
    || !/^[a-f0-9]{64}$/.test(input.expectedSha256)) return false;
  const prefix = `spaces/${input.spaceId}/extensions/${input.extensionId}/${input.version}/`;
  const entries: Array<[string, string]> = [];
  let cursor: string | undefined, totalBytes = 0;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}), limit: 256 });
    if (entries.length + page.objects.length > 256) return false;
    for (const item of page.objects) {
      const object = await bucket.get(item.key);
      if (!object) return false;
      const source = await object.text(); totalBytes += new TextEncoder().encode(source).byteLength;
      if (totalBytes > 2_000_000) return false;
      entries.push([`./${item.key.slice(prefix.length)}`, source]);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (!entries.length) return false;
  entries.sort(([a], [b]) => a.localeCompare(b));
  const digest = await workflowHash(JSON.stringify(entries));
  return digest === input.expectedSha256;
}
export async function readWorkflowGrant(env: DurableWorkflowHostEnv, scope: Pick<DurableWorkflowIdentity, "tenantId" | "spaceId" | "projectId" | "actorId" | "agentId" | "installationId">): Promise<{ version: string; role: string; installation?: WorkflowInstallationGrant }> {
  if (!env.SCRIPTS_R2 || !scope.actorId || scope.actorId === "system") throw new Error("workflow_actor_required");
  const headers = await workflowHeaders(env, scope.tenantId, scope.actorId);
  const base = "http://spaces-worker/spaces/" + encodeURIComponent(scope.spaceId);
  const response = await env.SPACES_WORKER.fetch(new Request(base + "/members", { headers }));
  if (!response.ok) throw new Error("workflow_membership_unavailable");
  const members = await response.json<{ data?: Array<Record<string, unknown>> }>();
  const member = members.data?.find((row) => row.user_id === scope.actorId);
  if (!member) throw new Error("workflow_membership_revoked");
  const role = String(member.role);
  let projectMember: unknown = null;
  if (scope.projectId) {
    const projectResponse = await env.SPACES_WORKER.fetch(new Request(base + "/projects/" + encodeURIComponent(scope.projectId) + "/members", { headers }));
    if (!projectResponse.ok) throw new Error("workflow_project_unavailable");
    const rows = await projectResponse.json<{ data?: Array<Record<string, unknown>> }>();
    projectMember = rows.data?.find((row) => row.user_id === scope.actorId) ?? null;
    if (!projectMember && role !== "owner" && role !== "admin") throw new Error("workflow_project_membership_revoked");
  }
  let installation: WorkflowInstallationGrant | null = null;
  if (scope.installationId) {
    const installed = await env.SPACES_WORKER.fetch(new Request(base + "/workflow-installations/" + encodeURIComponent(scope.installationId), { headers }));
    if (!installed.ok) throw new Error("workflow_installation_revoked");
    const record = await installed.json<WorkflowInstallationGrant>();
    const instance = record.instance;
    if (instance.status !== "active" || instance.tenant_id !== scope.tenantId || instance.space_id !== scope.spaceId || instance.project_id && instance.project_id !== scope.projectId || instance.user_id && instance.user_id !== scope.actorId) throw new Error("workflow_installation_scope_mismatch");
    installation = record;
  }
  const config = await Promise.all(["agents.md", "system-prompt.md", "scripts.json", "skills.json"].map(async (file) => {
    const object = await env.SCRIPTS_R2!.get("spaces/" + scope.spaceId + "/agents/" + scope.agentId + "/" + file);
    if (!object) throw new Error("workflow_agent_not_provisioned");
    return [file, await workflowHash(await object.text())];
  }));
  return { role, version: await workflowHash(JSON.stringify([member, projectMember, installation, config])), ...(installation ? { installation } : {}) };
}

/** SkillLibrary names are single path segments; extension manifests declare relative script paths. */
export function extensionWorkflowName(path: string): string | null {
  if (!/^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js|mjs)$/.test(path)) return null;
  return path.slice(2).replace(/\.(?:ts|js|mjs)$/, "");
}
export function workflowWorkspaceExtensionId(identity: Pick<DurableWorkflowIdentity, "workflowClass" | "projectId" | "installationId">): string | undefined {
  return identity.workflowClass === "vertical_extension" && !identity.projectId ? identity.installationId : undefined;
}
export function assertDeclaredExtensionWorkflow(installation: WorkflowInstallationGrant | undefined, name: string, extensionId: string | undefined): void {
  if (!installation?.manifest.daemons?.some((daemon) => typeof daemon.workflowScript === "string" && extensionWorkflowName(daemon.workflowScript) === name)) {
    throw new Error("workflow_script_not_declared_by_installation");
  }
  if (!extensionId || installation.manifest.id !== extensionId) throw new Error("workflow_extension_identity_mismatch");
}
export async function putWorkflowArtifact(env: DurableWorkflowHostEnv, identity: DurableWorkflowIdentity, value: unknown): Promise<WorkflowCheckpointPointer> {
  if (!env.SCRIPTS_R2) throw new Error("workflow_artifacts_unavailable");
  const json = serializeWorkflowCheckpoint(value, 4 * 1024 * 1024);
  const hash = await workflowHash(json);
  const pointer: WorkflowCheckpointPointer = { schema: 1, r2_key: workflowArtifactPrefix(identity) + hash + ".json", sha256: hash, bytes: new TextEncoder().encode(json).byteLength };
  await env.SCRIPTS_R2.put(pointer.r2_key, json, { httpMetadata: { contentType: "application/json" } });
  serializeWorkflowCheckpoint(pointer);
  return pointer;
}
export async function readWorkflowArtifact(env: DurableWorkflowHostEnv, identity: DurableWorkflowIdentity, pointer: WorkflowCheckpointPointer): Promise<unknown> {
  validateWorkflowPointer(identity, pointer);
  const object = await env.SCRIPTS_R2?.get(pointer.r2_key);
  if (!object || object.size !== pointer.bytes || object.size > 4 * 1024 * 1024) throw new Error("workflow_artifact_missing_or_oversized");
  const text = await object.text();
  if (await workflowHash(text) !== pointer.sha256) throw new Error("workflow_artifact_digest_mismatch");
  return JSON.parse(text);
}
export interface StartDurableWorkflowOptions {
  tenantId: string; spaceId: string; projectId?: string | undefined; actorId: string; agentId: string;
  name: string; params: Record<string, unknown>; startKey: string;
  workflowClass?: WorkflowClass | undefined; budgetKey?: string | undefined; budgetCredits?: number | undefined;
  installationId?: string | undefined; extensionId?: string | undefined; expiresAt?: number;
}
export async function startDurableWorkflow(env: DurableWorkflowHostEnv, options: StartDurableWorkflowOptions): Promise<{ id: string; queued: boolean; durable: true }> {
  if (!env.SCRIPTS_R2 || !env.AGENT_SCRIPT_WORKFLOW || !env.LOADER) throw new Error("dynamic_workflow_runtime_unavailable");
  const runId = await durableWorkflowRunId({ tenantId: options.tenantId, spaceId: options.spaceId, actorId: options.actorId, ...(options.projectId ? { projectId: options.projectId } : {}) }, options.startKey);
  const stub = workflowRunStub(env, { ...options, runId });
  // A repeated start keeps its original code pin and expiry even after a code update.
  const prior = await stub.existing();
  const inputDigest = await workflowHash(serializeWorkflowCheckpoint(options.params, 4 * 1024 * 1024));
  if (prior) {
    if (prior.inputDigest !== inputDigest || prior.identity.agentId !== options.agentId || prior.identity.installationId !== options.installationId || prior.identity.definitionId !== options.name || prior.identity.workflowClass !== (options.workflowClass ?? "ephemeral_task")) throw new Error("workflow_start_key_conflict");
    if (prior.identity.workflowClass === "vertical_extension") {
      const replayGrant = await readWorkflowGrant(env, { tenantId: options.tenantId, spaceId: options.spaceId, agentId: options.agentId, actorId: options.actorId, ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.installationId ? { installationId: options.installationId } : {}) });
      assertDeclaredExtensionWorkflow(replayGrant.installation, options.name, options.extensionId);
    }
    await stub.authorize(runId);
    await stub.launch();
    return { id: runId, queued: prior.status === "queued", durable: true };
  }
  const script = await new SkillLibrary(env.SCRIPTS_R2, options.spaceId).read(options.name);
  if (!script?.code || script.metadata.runtime !== "workflow") throw new Error("workflow_script_not_found");
  const grant = await readWorkflowGrant(env, { tenantId: options.tenantId, spaceId: options.spaceId, agentId: options.agentId, actorId: options.actorId, ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.installationId ? { installationId: options.installationId } : {}) });
  const workflowClass = options.workflowClass ?? "ephemeral_task";
  if (workflowClass === "company_automation" && (options.projectId || !["owner", "admin"].includes(grant.role))) throw new Error("workflow_owner_required");
  if (workflowClass === "vertical_extension") {
    if (!options.installationId) throw new Error("workflow_installation_required");
    assertDeclaredExtensionWorkflow(grant.installation, options.name, options.extensionId);
  }
  const codeDigest = await workflowHash(script.code);
  const identity: DurableWorkflowIdentity = { schema: 1, runId, tenantId: options.tenantId, spaceId: options.spaceId, ...(options.projectId ? { projectId: options.projectId } : {}), actorId: options.actorId, agentId: options.agentId, ...(options.installationId ? { installationId: options.installationId } : {}),
    startKey: options.startKey, definitionId: options.name, codeDigest, codeKey: "workflow-code/" + options.tenantId + "/" + options.spaceId + "/" + codeDigest + ".js", grantVersion: grant.version,
    reservationId: runId, expiresAt: options.expiresAt ?? Date.now() + 90 * 86400_000, workflowClass, capabilities: script.metadata.code_capabilities ?? [] };
  validateDurableWorkflowIdentity(identity);
  await env.SCRIPTS_R2.put(identity.codeKey, script.code, { httpMetadata: { contentType: "application/javascript" } });
  const input = await putWorkflowArtifact(env, identity, options.params);
  await stub.initialize(identity, input, { ...(options.budgetKey ? { budgetKey: options.budgetKey } : {}), ...(options.budgetCredits !== undefined ? { budgetCredits: options.budgetCredits } : {}) });
  await stub.launch();
  return { id: runId, queued: true, durable: true };
}
