import { WorkerEntrypoint } from "cloudflare:workers";
import { workflowRunStub, type DurableWorkflowHostEnv } from "./workflow-host.js";
import type { WorkflowCheckpointPointer } from "@naelao/agent-sdk";

export interface WorkflowControlProps { tenantId: string; spaceId: string; runId: string }
/** Persistable loopback binding reconstructed on every resume, bound to exactly one run. */
export class WorkflowControl extends WorkerEntrypoint<DurableWorkflowHostEnv, WorkflowControlProps> {
  private stub(runId: string) { if (runId !== this.ctx.props.runId) throw new Error("workflow_control_scope_mismatch"); return workflowRunStub(this.env, this.ctx.props); }
  authorize(runId: string) { return this.stub(runId).authorize(runId); }
  state(runId: string, state: "running" | "sleeping" | "waiting") { return this.stub(runId).state(runId, state); }
  input(runId: string) { return this.stub(runId).input(runId); }
  effect(runId: string, key: string, operation: string, params: Record<string, unknown>) { return this.stub(runId).effect(runId, key, operation, params); }
  putArtifact(runId: string, value: unknown) { return this.stub(runId).putArtifact(runId, value); }
  readArtifact(runId: string, pointer: WorkflowCheckpointPointer) { return this.stub(runId).readArtifact(runId, pointer); }
  finish(runId: string, status: "succeeded" | "failed", value: WorkflowCheckpointPointer | string) { return this.stub(runId).finish(runId, status, value); }
}
