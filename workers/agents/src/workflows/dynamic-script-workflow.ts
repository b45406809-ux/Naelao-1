import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { dispatchWorkflow, type WorkflowRunner } from "@cloudflare/dynamic-workflows";
import type { Env } from "../env.js";
import type { WorkflowControl, WorkflowControlProps } from "./workflow-control.js";
import { workflowHash, workflowRunStub } from "./workflow-host.js";
import { validateDurableWorkflowIdentity } from "@naelao/agent-sdk";

export interface ScriptRunWorkflowParams { runId: string }
export interface ScriptRunWorkflowResult { schema: 1; r2_key: string; sha256: string; bytes: number }

/** Cloudflare's real dynamic-workflows dispatcher carries the native durable step handle. */
export class ScriptRunWorkflow extends WorkflowEntrypoint<Env, unknown> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<unknown> {
    return dispatchWorkflow({ env: this.env, ctx: this.ctx }, event, step as Parameters<typeof dispatchWorkflow>[2], async ({ env, ctx, metadata }) => {
      const scope: WorkflowControlProps = { tenantId: String(metadata.tenantId ?? ""), spaceId: String(metadata.spaceId ?? ""), runId: String(metadata.runId ?? "") };
      if (![scope.tenantId, scope.spaceId, scope.runId].every((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value))) throw new Error("workflow_dispatch_scope_invalid");
      const journal = workflowRunStub(env, scope);
      const identity = await journal.authorize(scope.runId);
      validateDurableWorkflowIdentity(identity);
      if (!env.LOADER || !env.SCRIPTS_R2) throw new Error("workflow_dynamic_loader_unavailable");
      const object = await env.SCRIPTS_R2.get(identity.codeKey);
      if (!object || object.size > 524288) throw new Error("workflow_pinned_code_missing");
      const code = await object.text();
      if (await workflowHash(code) !== identity.codeDigest) throw new Error("workflow_pinned_code_digest_mismatch");
      const exports = (ctx as unknown as { exports?: { WorkflowControl?: (init: { props: WorkflowControlProps }) => WorkflowControl } }).exports;
      if (!exports?.WorkflowControl) throw new Error("workflow_loopback_binding_unavailable");
      const config = { compatibilityDate: "2026-09-10", mainModule: "workflow.js", modules: { "workflow.js": code },
        globalOutbound: null, limits: { cpuMs: 30000, subRequests: 128 }, env: { CONTROL: exports.WorkflowControl({ props: scope }) } };
      // Cache keys contain run identity and code digest; guest bindings cannot cross scopes.
      const worker = env.LOADER.load ? env.LOADER.load(config) : env.LOADER.get(identity.runId + ":" + identity.codeDigest, () => config);
      return worker.getEntrypoint("CompiledWorkflow") as unknown as WorkflowRunner;
    });
  }
}
