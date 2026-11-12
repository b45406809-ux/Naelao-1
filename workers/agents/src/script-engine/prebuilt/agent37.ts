import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { PrebuiltOpContext, PrebuiltScript } from "./index.js";
import { tunnelHash } from "@naelao/agent-sdk";
import { authorizeEnvironmentCommand } from "./code-exec.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_COMMAND_BYTES = 64 * 1024;

function invocation(ctx: PrebuiltOpContext) {
  const env = ctx.env;
  if (!env.sandboxesWorker || !env.platformSecret || !env.humanInvokerId || !env.runId || !env.projectId || !env.spaceId
    || !env.nativeExecutionAllowed || env.airGappedOnly || env.workspaceFileScope !== undefined
    || !["owner", "editor"].includes(String(env.effectiveRole))) throw new Error("agent37_project_owner_tool_context_required");
  const resource = `project:${env.projectId}`;
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([env.tenantId, env.spaceId, resource])))
    .then(bytes => ({ agentPortAgentId: `naelao_${[...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("")}` }));
}

async function requestId(ctx: PrebuiltOpContext, action: string, computerId: string, data: unknown) {
  return `ag37_${await tunnelHash(JSON.stringify([ctx.env.tenantId, ctx.env.spaceId, ctx.env.projectId, ctx.env.humanInvokerId,
    ctx.env.agentId, ctx.env.runId, action, computerId, data]))}`.slice(0, 64);
}

async function call(ctx: PrebuiltOpContext, path: string, method = "GET", body?: unknown, key?: string) {
  const agent = await invocation(ctx);
  const headers = new Headers({
    "x-naelao-tenant-id": ctx.env.tenantId,
    "x-naelao-user-id": ctx.env.humanInvokerId!,
    "x-naelao-role": ctx.env.effectiveRole!,
    "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret!, ctx.env.tenantId),
    "x-naelao-agentport-agent-id": agent.agentPortAgentId,
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (key) headers.set("idempotency-key", key);
  const response = await ctx.env.sandboxesWorker!.fetch(new Request(`http://sandboxes${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const result = await readBoundedResponseJson<Record<string, unknown>>(response, 1024 * 1024);
  if (!response.ok) throw new Error(typeof result.error_code === "string" ? result.error_code : "agent37_request_failed");
  return result;
}

function computerId(args: Record<string, unknown>) {
  const value = String(args.computer_id ?? "");
  if (!ID.test(value)) throw new Error("agent37_computer_id_required");
  return value;
}

async function authorizeTransferPaths(ctx: PrebuiltOpContext, paths: string[], access: "read" | "write") {
  if (!ctx.authorizeShell) throw new Error("agent37_workspace_authorization_unavailable");
  for (const path of paths) {
    if (typeof path !== "string" || !path || path.length > 1024 || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("agent37_artifact_path_invalid");
    if (!await ctx.authorizeShell({ kind: "file", name: path, access })) throw new Error(`agent37_artifact_${access}_denied`);
  }
}

export const agent37: PrebuiltScript = {
  name: "agent37-computers",
  domain: "orchestration",
  requires_tier: 1,
  description: "Use a customer-owned Agent37 computer only after its owner shares exact actions with this project's assistant. Provider charges come from the customer's Agent37 account. Runtime rollout and live provider acceptance remain gated; never copy provider credentials.",
  paramHints: {
    "agent37.list": "{} — list this owner's project computer configurations and current provider gates.",
    "agent37.start": "computer_id. Start a shared Agent37 computer. Starting may spend the owner's Agent37 balance; the owner must have explicitly granted this action.",
    "agent37.sleep": "computer_id. Sleep a shared running Agent37 computer.",
    "agent37.execute": "computer_id, command, optional args, cwd, timeout_ms, environment and request_id. Run one bounded command on the shared computer.",
    "agent37.artifact_transfer": "computer_id, direction ('import' or 'stage_output'), selected project paths, optional publish and request_id. Transfers only selected files; no mount or automatic synchronization.",
    "agent37.reconcile_execution": "computer_id and execution_id. Reconcile one named execution without creating a new execution.",
    "agent37.reconcile_artifacts": "computer_id and transfer_id. Reconcile one journaled selected-file transfer.",
  },
  operations: {
    "agent37.list": async (_args, ctx) => {
      const result = await call(ctx, "/computers");
      const computers = Array.isArray(result.computers) ? result.computers as Array<Record<string, unknown>> : [];
      return { computers: computers.filter(item => {
        const scope = item.scope as Record<string, unknown> | undefined;
        return scope?.spaceId === ctx.env.spaceId && scope.projectId === ctx.env.projectId;
      }), providerGate: await call(ctx, "/providers") };
    },
    "agent37.start": async (args, ctx) => {
      const id = computerId(args), key = typeof args.request_id === "string" ? args.request_id : await requestId(ctx, "start", id, null);
      if (!ID.test(key)) throw new Error("agent37_request_id_invalid");
      return call(ctx, `/computers/${encodeURIComponent(id)}/start`, "POST", { providerBillingConsent: true }, key);
    },
    "agent37.sleep": async (args, ctx) => {
      const id = computerId(args), key = typeof args.request_id === "string" ? args.request_id : await requestId(ctx, "sleep", id, null);
      if (!ID.test(key)) throw new Error("agent37_request_id_invalid");
      return call(ctx, `/computers/${encodeURIComponent(id)}/sleep`, "POST", {}, key);
    },
    "agent37.execute": async (args, ctx) => {
      const id = computerId(args), command = args.command;
      if (typeof command !== "string" || !command.trim() || new TextEncoder().encode(command).byteLength > MAX_COMMAND_BYTES)
        throw new Error("agent37_command_invalid");
      const commandArgs = args.args ?? [];
      if (!Array.isArray(commandArgs) || commandArgs.length > 128 || commandArgs.some(value => typeof value !== "string")) throw new Error("agent37_command_args_invalid");
      const timeoutMs = args.timeout_ms ?? 30_000;
      if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 280_000) throw new Error("agent37_timeout_invalid");
      await authorizeEnvironmentCommand(command, ctx);
      const body = { command, args: commandArgs, timeoutMs: Number(timeoutMs),
        ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
        ...(args.environment && typeof args.environment === "object" && !Array.isArray(args.environment) ? { environment: args.environment } : {}) };
      const key = typeof args.request_id === "string" ? args.request_id : await requestId(ctx, "execute", id, body);
      if (!ID.test(key)) throw new Error("agent37_request_id_invalid");
      return call(ctx, `/computers/${encodeURIComponent(id)}/executions`, "POST", body, key);
    },
    "agent37.artifact_transfer": async (args, ctx) => {
      const id = computerId(args), direction = args.direction, paths = args.paths;
      if ((direction !== "import" && direction !== "stage_output") || !Array.isArray(paths) || !paths.length || paths.length > 100
        || paths.some(path => typeof path !== "string")) throw new Error("agent37_artifact_transfer_invalid");
      await authorizeTransferPaths(ctx, paths as string[], direction === "import" ? "read" : "write");
      const publish = args.publish === true;
      const body = { direction, paths, ...(publish ? { publish: true } : {}) };
      const key = typeof args.request_id === "string" ? args.request_id : await requestId(ctx, "artifact_transfer", id, body);
      if (!ID.test(key)) throw new Error("agent37_request_id_invalid");
      return call(ctx, `/computers/${encodeURIComponent(id)}/artifacts`, "POST", body, key);
    },
    "agent37.reconcile_execution": async (args, ctx) => {
      const id = computerId(args), executionId = String(args.execution_id ?? "");
      if (!ID.test(executionId)) throw new Error("agent37_execution_id_invalid");
      return call(ctx, `/computers/${encodeURIComponent(id)}/executions/${encodeURIComponent(executionId)}/reconcile`, "POST", {});
    },
    "agent37.reconcile_artifacts": async (args, ctx) => {
      const id = computerId(args), transferId = String(args.transfer_id ?? "");
      if (!ID.test(transferId)) throw new Error("agent37_transfer_id_invalid");
      return call(ctx, `/computers/${encodeURIComponent(id)}/artifact-transfers/${encodeURIComponent(transferId)}/reconcile`, "POST", {});
    },
  },
};
