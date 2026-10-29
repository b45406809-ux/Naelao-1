import { eligibleEnvironments, selectEnvironment, tunnelHash, type EnvironmentCard, type EnvironmentOwner } from "@naelao/agent-sdk";
import type { PrebuiltOpContext, PrebuiltScript } from "./index.js";
import { publishEnvironmentArtifact, publishEnvironmentArtifactBytes, readEnvironmentArtifact, restoreEnvironmentArtifact } from "../environment-artifacts.js";
import { authorizeEnvironmentCommand, runEnvironmentBash } from "./code-exec.js";
import { ExecutionPreDispatchError } from "../../tunnels/execution-sessions.js";

function owner(ctx: PrebuiltOpContext): EnvironmentOwner {
  return { tenantId: ctx.env.tenantId, spaceId: ctx.env.spaceId, ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}),
    ...(ctx.env.spaceWorkspaceExtensionId ? { workspaceId: ctx.env.spaceWorkspaceExtensionId } : {}),
    scope: ctx.env.spaceWorkspaceExtensionId ? "SPACE_SHARED" : ctx.env.projectId ? "PROJECT_BOUND" : "ASSISTANT_PRIVATE" };
}
const MAX_MACHINE_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MACHINE_ARTIFACT_CHUNK_BYTES = 8192;
function validMachinePath(path: string) { return Boolean(path) && path.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(path); }
function decodeBase64(value: string, expectedBytes?: number): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || value.length > 4 * Math.ceil(MACHINE_ARTIFACT_CHUNK_BYTES / 3)) throw new Error("environment_machine_artifact_encoding_invalid");
  const binary = atob(value), bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length > MACHINE_ARTIFACT_CHUNK_BYTES || expectedBytes !== undefined && bytes.length !== expectedBytes || btoa(binary) !== value) throw new Error("environment_machine_artifact_encoding_invalid");
  return bytes;
}
async function transferRequestId(ctx: PrebuiltOpContext, operation: string, machine: string, path: string, digest?: string) {
  return tunnelHash(JSON.stringify([ctx.env.tenantId, ctx.env.spaceId, ctx.env.projectId ?? "_assistant", ctx.env.humanInvokerId, ctx.env.runId, operation, machine, path, digest ?? null]));
}
async function settleExternalEnvironment(result: unknown, ctx: PrebuiltOpContext) {
  if (!result || typeof result !== "object" || !ctx.env.finalizeExternalEnvironment) return;
  const value = result as { status?: unknown; budget_reservation_id?: unknown };
  if (typeof value.budget_reservation_id === "string" && ["succeeded", "failed", "cancelled"].includes(String(value.status))) {
    await ctx.env.finalizeExternalEnvironment(value.budget_reservation_id, "settle", 1);
  }
}
async function cards(ctx: PrebuiltOpContext, command?: string): Promise<EnvironmentCard[]> {
  if (!ctx.env.humanInvokerId || Boolean(command) && !ctx.env.nativeExecutionAllowed || ctx.env.airGappedOnly || ctx.env.workspaceFileScope !== undefined) throw new Error("environment_scoped_native_authority_required");
  const now = Date.now(), scope = owner(ctx), result: EnvironmentCard[] = [];
  if (ctx.env.containerRuntimeInventory) {
    const inventory = await ctx.env.containerRuntimeInventory();
    result.push(...inventory.installed.slice(0, 128).filter(item => item.projectId === ctx.env.projectId).map(item => ({ ...scope, id: item.installationId, name: item.installationId,
      kind: "managed" as const, provider: "cloudflare", capabilities: ["bash", ...item.contract.exportedBinaries], observedAt: now,
      available: ctx.env.managedEnvironmentsUnavailable !== true && inventory.catalogue.some(image => image.available && image.image === item.contract.image), authorized: true, persistence: "ephemeral" as const, filesystemModel: "workspace-backed" as const, apps: [], externalUse: [] })));
  }
  if (ctx.env.localTunnel) {
    const machines = await ctx.env.localTunnel.list();
    for (const machine of machines.slice(0, 128)) {
      const grants = machine.grants.filter(grant => grant.actorId === ctx.env.humanInvokerId && (!grant.projectId || grant.projectId === ctx.env.projectId) && grant.expiresAt > now
        && (!command || grant.commands.includes(command) || grant.shellAccess === "sandboxed"));
      if (!grants.length) continue;
      const status = await ctx.env.localTunnel.status(machine.machineId).catch(() => ({ connected: false }));
      result.push({ ...scope, id: machine.machineId, name: machine.name, kind: "external", provider: "bridge", capabilities: machine.hardware.capabilities,
        observedAt: machine.heartbeatAt ?? machine.updatedAt, available: status.connected, authorized: true, persistence: "filesystem", filesystemModel: "machine-local", apps: machine.hardware.apps ?? [],
        externalUse: [...new Set(grants.flatMap(grant => grant.externalUse ?? []))] });
    }
  }
  return result;
}
export const environments: PrebuiltScript = {
  name: "execution-environments", domain: "orchestration", requires_tier: 1,
  description: "Inspect scoped execution environment cards and run a bounded dependent command group on one durable target. External machines keep their own filesystem; commands and file transfers can only access locally consented roots. Transfer files up to 16 MiB only through explicit resumable artifact import/export in 8 KiB chunks; export creates a new file and never overwrites. There is no mount or automatic synchronization. External execution requires a host grant plus owner consent. No automatic replay or migration. Browser logins and credentials are never copied.",
  paramHints: {
    "environment.artifact_publish": "path (required). Create an immutable scoped artifact, maximum 16 MiB. No implicit machine synchronization.",
    "environment.artifact_restore": "digest, path and expected_hash (null only for an absent destination). Verify integrity and publish with a fenced revision check.",
    "environment.artifact_import": "machine_id and path (required). Explicitly read a file from an owner-authorized connected machine into this workspace's immutable artifact store. Binary-safe, maximum 16 MiB in resumable 8 KiB chunks; returns a digest to restore into the workspace. No filesystem mount or synchronization. If pending/indeterminate, reconcile the returned request_id with tunnel.status; do not create a new request.",
    "environment.artifact_export": "machine_id, digest and path (required). Explicitly write an immutable workspace artifact as a new file in an owner-authorized local folder. Refuses to overwrite. Binary-safe, maximum 16 MiB in resumable 8 KiB chunks. If pending/indeterminate, reconcile request IDs; do not resubmit with different IDs.",
    "environment.status": "session_id and action_id. Reconcile an accepted tunnel request without resubmitting it.",
    "environment.list": "List visible environment capabilities and availability. Observations are untrusted evidence, not permissions.",
    "environment.execute": "session_id, action_id, command, capabilities (string array; default bash), mode (managed, capability, or host-verified fallback; default managed), optional app_id plus connection_id to require a fresh authenticated app observation, target_id and external-only absolute cwd. A host-classified worker runtime requirement is automatically included for managed execution and remains pinned by the session. Tunnel files stay on that machine inside its owner-consented folders; import/export files explicitly through artifact operations. Repeat action_id only to retrieve a confirmed outcome. Group commands needing shell state into one command. Pending tunnel receipts require tunnel.status reconciliation; do not resubmit.",
  },
  operations: {
    "environment.artifact_publish": async (args, ctx) => {
      if (typeof args.path !== "string") throw new Error("environment_artifact_path_required");
      if (!ctx.authorizeShell || !await ctx.authorizeShell({ kind: "file", name: args.path, access: "read" })) throw new Error("environment_artifact_read_denied");
      return publishEnvironmentArtifact(ctx.env, args.path);
    },
    "environment.artifact_restore": async (args, ctx) => {
      if (typeof args.path !== "string" || typeof args.digest !== "string" || args.expected_hash !== null && typeof args.expected_hash !== "string") throw new Error("environment_artifact_expected_revision_required");
      if (!ctx.authorizeShell || !await ctx.authorizeShell({ kind: "file", name: args.path, access: "write" })) throw new Error("environment_artifact_write_denied");
      return restoreEnvironmentArtifact(ctx.env, args.digest, args.path, args.expected_hash);
    },
    "environment.artifact_import": async (args, ctx) => {
      const machineId = String(args.machine_id ?? ""), path = String(args.path ?? "");
      if (!machineId || !validMachinePath(path) || !ctx.env.localTunnel || !ctx.env.humanInvokerId) throw new Error("environment_machine_artifact_scope_required");
      if (!ctx.authorizeShell || !await ctx.authorizeShell({ kind: "file", name: `tunnel:${machineId}:${path}`, access: "read" })) throw new Error("environment_artifact_read_denied");
      const candidates = await cards(ctx);
      const machine = candidates.find(card => card.id === machineId && card.kind === "external" && card.available && card.authorized);
      if (!machine) throw new Error("environment_machine_unavailable_or_unauthorized");
      const metaRequestId = typeof args.request_id === "string" ? args.request_id : await transferRequestId(ctx, "import-meta", machineId, path);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(metaRequestId)) throw new Error("environment_machine_artifact_request_id_invalid");
      const metadata = await ctx.env.localTunnel.exec({ machine: machineId, op: "read_file", params: { path, encoding: "base64", offset: 0, length: 0 }, requestId: metaRequestId });
      if (!metadata.ok || metadata.status !== "succeeded") return { status: metadata.status ?? "indeterminate", request_id: metadata.request_id ?? metaRequestId, machine_id: machineId, offset: 0 };
      const meta = metadata.result as { total_bytes?: unknown; fingerprint?: unknown } | undefined;
      if (!meta || !Number.isSafeInteger(meta.total_bytes) || (meta.total_bytes as number) < 0 || (meta.total_bytes as number) > MAX_MACHINE_ARTIFACT_BYTES
        || typeof meta.fingerprint !== "string" || !/^[0-9]+(:[0-9]+){4}$/.test(meta.fingerprint)) throw new Error("environment_machine_artifact_response_invalid");
      const totalBytes = meta.total_bytes as number, chunks: Uint8Array[] = [], pending: Array<{ offset: number; request_id: string }> = [];
      const ranges = Array.from({ length: Math.ceil(totalBytes / MACHINE_ARTIFACT_CHUNK_BYTES) }, (_, index) => index * MACHINE_ARTIFACT_CHUNK_BYTES);
      for (let start = 0; start < ranges.length; start += 8) {
        const batch = await Promise.all(ranges.slice(start, start + 8).map(async offset => {
          const length = Math.min(MACHINE_ARTIFACT_CHUNK_BYTES, totalBytes - offset);
          const requestId = await transferRequestId(ctx, "import", machineId, path, `${meta.fingerprint}:${offset}:${length}`);
          const response = await ctx.env.localTunnel!.exec({ machine: machineId, op: "read_file", params: { path, encoding: "base64", offset, length, fingerprint: meta.fingerprint }, requestId });
          if (!response.ok || response.status !== "succeeded") return { offset, request_id: response.request_id ?? requestId, bytes: new Uint8Array() };
          const part = response.result as { encoding?: unknown; content?: unknown; bytes?: unknown; offset?: unknown; total_bytes?: unknown; fingerprint?: unknown } | undefined;
          if (!part || part.encoding !== "base64" || typeof part.content !== "string" || part.offset !== offset || part.total_bytes !== totalBytes || part.fingerprint !== meta.fingerprint || !Number.isSafeInteger(part.bytes)) throw new Error("environment_machine_artifact_response_invalid");
          return { offset, request_id: requestId, bytes: decodeBase64(part.content, length) };
        }));
        for (const item of batch) { chunks.push(item.bytes); if (item.bytes.byteLength === 0 && totalBytes > 0) pending.push({ offset: item.offset, request_id: item.request_id }); }
      }
      if (pending.length) return { status: "indeterminate", machine_id: machineId, total_bytes: totalBytes, pending_chunks: pending };
      const bytes = new Uint8Array(totalBytes);
      let cursor = 0;
      for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
      const artifact = await publishEnvironmentArtifactBytes(ctx.env, bytes, `machine:${machineId}`);
      return { ...artifact, machine_id: machineId, chunks: chunks.length, transfer_request_id: metaRequestId };
    },
    "environment.artifact_export": async (args, ctx) => {
      const machineId = String(args.machine_id ?? ""), path = String(args.path ?? ""), digest = String(args.digest ?? "");
      if (!machineId || !validMachinePath(path) || !/^[a-f0-9]{64}$/.test(digest) || !ctx.env.localTunnel || !ctx.env.humanInvokerId) throw new Error("environment_machine_artifact_scope_required");
      if (!ctx.authorizeShell || !await ctx.authorizeShell({ kind: "file", name: `tunnel:${machineId}:${path}`, access: "write" })) throw new Error("environment_artifact_write_denied");
      const candidates = await cards(ctx);
      const machine = candidates.find(card => card.id === machineId && card.kind === "external" && card.available && card.authorized);
      if (!machine) throw new Error("environment_machine_unavailable_or_unauthorized");
      const artifact = await readEnvironmentArtifact(ctx.env, digest);
      if (artifact.bytes.byteLength > MAX_MACHINE_ARTIFACT_BYTES) throw new Error("environment_machine_artifact_too_large");
      if (artifact.bytes.byteLength <= MACHINE_ARTIFACT_CHUNK_BYTES) {
        const requestId = typeof args.request_id === "string" ? args.request_id : await transferRequestId(ctx, "export", machineId, path, digest);
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestId)) throw new Error("environment_machine_artifact_request_id_invalid");
        const encoded = btoa(Array.from(artifact.bytes, byte => String.fromCharCode(byte)).join(""));
        const response = await ctx.env.localTunnel.exec({ machine: machineId, op: "write_file", params: { path, encoding: "base64", content: encoded, create_only: true }, requestId });
        if (!response.ok || response.status !== "succeeded") return { status: response.status ?? "indeterminate", request_id: response.request_id ?? requestId, machine_id: machineId, digest };
        return { exported: true, machine_id: machineId, path, digest, bytes: artifact.bytes.byteLength, request_id: response.request_id ?? requestId, chunks: 1 };
      }
      const transferId = await transferRequestId(ctx, "export-transfer", machineId, path, digest);
      const pending: Array<{ offset: number; request_id: string }> = [];
      const parts: Array<{ offset: number; bytes: Uint8Array; request_id: string }> = [];
      for (let offset = 0; offset < artifact.bytes.byteLength; offset += MACHINE_ARTIFACT_CHUNK_BYTES) {
        const bytes = artifact.bytes.subarray(offset, Math.min(offset + MACHINE_ARTIFACT_CHUNK_BYTES, artifact.bytes.byteLength));
        const requestId = await transferRequestId(ctx, "export-chunk", machineId, path, `${transferId}:${offset}`);
        parts.push({ offset, bytes, request_id: requestId });
      }
      const staging = parts.slice(0, -1);
      for (let start = 0; start < staging.length; start += 8) {
        const results = await Promise.all(staging.slice(start, start + 8).map(async part => {
          const content = btoa(Array.from(part.bytes, byte => String.fromCharCode(byte)).join(""));
          const response = await ctx.env.localTunnel!.exec({ machine: machineId, op: "write_file", params: { path, encoding: "base64", content,
            transfer_id: transferId, offset: part.offset, total_bytes: artifact.bytes.byteLength, sha256: digest, finalize: false }, requestId: part.request_id });
          return { part, response };
        }));
        for (const { part, response } of results) if (!response.ok || response.status !== "succeeded") pending.push({ offset: part.offset, request_id: response.request_id ?? part.request_id });
      }
      if (pending.length) return { status: "indeterminate", machine_id: machineId, digest, total_bytes: artifact.bytes.byteLength, pending_chunks: pending };
      const finalPart = parts[parts.length - 1]!;
      const finalContent = btoa(Array.from(finalPart.bytes, byte => String.fromCharCode(byte)).join(""));
      const finalResponse = await ctx.env.localTunnel.exec({ machine: machineId, op: "write_file", params: { path, encoding: "base64", content: finalContent,
        transfer_id: transferId, offset: finalPart.offset, total_bytes: artifact.bytes.byteLength, sha256: digest, finalize: true }, requestId: finalPart.request_id });
      if (!finalResponse.ok || finalResponse.status !== "succeeded") return { status: finalResponse.status ?? "indeterminate", machine_id: machineId, digest, request_id: finalResponse.request_id ?? finalPart.request_id, offset: finalPart.offset };
      return { exported: true, machine_id: machineId, path, digest, bytes: artifact.bytes.byteLength, request_id: finalResponse.request_id ?? finalPart.request_id, chunks: parts.length };
    },
    "environment.list": async (_args, ctx) => ({ environments: await cards(ctx) }),
    "environment.status": async (args, ctx) => {
      if (!ctx.env.executionSessions || !ctx.env.humanInvokerId || !ctx.env.localTunnel) throw new Error("environment_session_host_unavailable");
      const available = await cards(ctx);
      const resolved = await ctx.env.executionSessions.reconcile({ sessionId: String(args.session_id ?? ""), actionId: String(args.action_id ?? ""), owner: owner(ctx),
        actorId: ctx.env.humanInvokerId, branch: ctx.env.workspaceBranch ?? "" }, async receipt => {
        const value = receipt as { environment_id?: string; request_id?: string; request_run_id?: string; budget_reservation_id?: string };
        if (!value.environment_id || !value.request_id || !available.some(card => card.id === value.environment_id && card.kind === "external" && card.authorized)) throw new Error("environment_receipt_unavailable");
        const response = await ctx.env.localTunnel!.requestStatus(value.environment_id, value.request_id, value.request_run_id) as { ok?: boolean; result?: { status?: string } };
        if (!response.ok || !response.result) throw new Error("environment_reconciliation_unavailable");
        return { terminal: ["succeeded", "failed", "cancelled"].includes(response.result.status ?? ""), result: { ...response.result, environment_id: value.environment_id, request_id: value.request_id,
          ...(value.request_run_id ? { request_run_id: value.request_run_id } : {}),
          ...(value.budget_reservation_id ? { budget_reservation_id: value.budget_reservation_id } : {}) } };
      });
      await settleExternalEnvironment(resolved, ctx);
      return resolved;
    },
    "environment.execute": async (args, ctx) => {
      const command = String(args.command ?? "");
      if (!command.trim() || command.length > 8192) throw new Error("environment_command_invalid");
      if (args.cwd !== undefined && (typeof args.cwd !== "string" || args.cwd.length > 1024 || !args.cwd.startsWith("/"))) throw new Error("environment_working_directory_invalid");
      if (!ctx.env.executionSessions || !ctx.env.humanInvokerId) throw new Error("environment_session_host_unavailable");
      if (args.mode !== undefined && args.mode !== "managed" && args.mode !== "capability" && args.mode !== "fallback") throw new Error("environment_execution_mode_invalid");
      const capabilities = args.capabilities ?? ["bash"];
      if (!Array.isArray(capabilities) || capabilities.some(value => typeof value !== "string")) throw new Error("environment_capabilities_invalid");
      if (args.app_id !== undefined && typeof args.app_id !== "string" || args.connection_id !== undefined && typeof args.connection_id !== "string") throw new Error("environment_app_requirement_invalid");
      await authorizeEnvironmentCommand(command, ctx);
      const sessionId = String(args.session_id ?? ""), actionId = String(args.action_id ?? ""), actorId = ctx.env.humanInvokerId, branch = ctx.env.workspaceBranch ?? "";
      const identity = { sessionId, owner: owner(ctx), actorId, branch };
      const sessionTarget = await ctx.env.executionSessions.target(identity);
      if (sessionTarget && args.target_id && sessionTarget !== args.target_id) throw new Error("environment_session_target_conflict");
      const previous = await ctx.env.executionSessions.completed({ ...identity, actionId, command, ...(typeof args.cwd === "string" ? { workingDirectory: args.cwd } : {}) });
      if (previous.found) { await settleExternalEnvironment(previous.result, ctx); return previous.result; }
      const available = await cards(ctx, command);
      const preferredCapability = ctx.env.preferredRuntimeCapability;
      const useManagedPreference = !!preferredCapability && (args.mode === undefined || args.mode === "managed");
      const requiredCapabilities = useManagedPreference ? [...new Set([...capabilities, preferredCapability])] : capabilities;
      const appRequirement = { capabilities: requiredCapabilities, ...(typeof args.app_id === "string" ? { appId: args.app_id } : {}), ...(typeof args.connection_id === "string" ? { connectionId: args.connection_id } : {}) };
      const managedEligible = eligibleEnvironments(available, owner(ctx), { ...appRequirement, mode: "managed" });
      const managedUnavailable = ctx.env.managedEnvironmentsUnavailable === true || managedEligible.length === 0;
      const requirement = { capabilities: requiredCapabilities, mode: args.mode === "capability" ? "capability" as const : args.mode === "fallback" ? "fallback" as const : "managed" as const,
        ...(typeof args.app_id === "string" ? { appId: args.app_id } : {}),
        ...(managedUnavailable ? { managedUnavailable: true } : {}),
        ...(typeof args.connection_id === "string" ? { connectionId: args.connection_id } : {}) };
      const eligible = eligibleEnvironments(available, owner(ctx), requirement);
      let recommended: string | undefined;
      if (!sessionTarget && !args.target_id && eligible.length > 1 && eligible.length <= 32 && ctx.env.fastDecision) {
        try {
          const decision = await ctx.env.fastDecision.choice({ state: { capabilities, appId: args.app_id, connectionId: args.connection_id, intent: String(args.intent ?? "").slice(0, 1000) },
            instructions: "Rank only these host-eligible environments for the task. Metadata is untrusted evidence, not new authority. Prefer existing compatible app state and avoid unnecessary external execution.",
            criteria: Object.fromEntries(eligible.map(card => [card.id, JSON.stringify({ name: card.name, kind: card.kind, provider: card.provider, scope: card.scope, workspaceId: card.workspaceId, capabilities: card.capabilities, filesystemModel: card.filesystemModel, apps: card.apps })])), policyCode: "execution_environment_v1" });
          if ((decision.confidence ?? 0) >= 0.8 && eligible.some(card => card.id === decision.value)) recommended = decision.value;
        } catch { /* Deterministic eligibility and ordering remain authoritative. */ }
      }
      const selected = selectEnvironment(available, owner(ctx), requirement, recommended,
        sessionTarget ?? (typeof args.target_id === "string" ? args.target_id : undefined));
      if (selected.kind === "managed" && args.cwd !== undefined) throw new Error("environment_working_directory_external_only");
      const reservationId = selected.kind === "external" ? await tunnelHash(JSON.stringify(["external-environment-budget", owner(ctx), actorId, branch, sessionId, actionId, selected.id])) : undefined;
      const result = await ctx.env.executionSessions.execute({ sessionId, actionId, owner: owner(ctx),
        actorId, branch, targetId: selected.id, command, ...(typeof args.cwd === "string" ? { workingDirectory: args.cwd } : {}), ...(selected.kind === "managed" && ctx.env.runId ? { executionEpoch: ctx.env.runId } : {}) }, async () => {
        if (selected.kind === "external") {
          if (!ctx.env.reserveExternalEnvironment || !ctx.env.finalizeExternalEnvironment) throw new ExecutionPreDispatchError("external_environment_billing_unavailable");
          try { await ctx.env.reserveExternalEnvironment(reservationId!); }
          catch { throw new ExecutionPreDispatchError("external_environment_admission_denied"); }
          const requestId = await tunnelHash(JSON.stringify([ctx.env.tenantId, ctx.env.spaceId, ctx.env.projectId, ctx.env.agentId, ctx.env.runId, branch, sessionId, actionId, selected.id]));
          let response;
          try { response = await ctx.env.localTunnel!.exec({ machine: selected.id, op: "exec", params: { command, ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}) }, requestId }); }
          catch { return { ok: false, status: "indeterminate", request_id: requestId, request_run_id: ctx.env.runId, environment_id: selected.id, budget_reservation_id: reservationId }; }
          if (!response.ok && !response.status) {
            try { await ctx.env.finalizeExternalEnvironment(reservationId!, "release"); } catch { /* expires if billing is unavailable */ }
            throw new ExecutionPreDispatchError(response.error ?? "environment_tunnel_dispatch_failed");
          }
          return { ...response, request_run_id: ctx.env.runId, environment_id: selected.id, budget_reservation_id: reservationId };
        }
        const installed = (await ctx.env.containerRuntimeInventory!()).installed.find(item => item.installationId === selected.id);
        if (!installed) throw new Error("environment_installation_revoked");
        return runEnvironmentBash(command, installed, ctx);
      });
      await settleExternalEnvironment(result, ctx);
      return result;
    },
  },
};
