import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { NoCodeSubagentManifest } from "@naelao/agent-sdk";
import { mintInternalToken } from "@naelao/http";
import type { Env } from "../env.js";

export const NO_CODE_SUBAGENT_CONTEXT_CEILING = 2_000;

export interface GenericSubagentParams {
  manifest: NoCodeSubagentManifest;
  tenantId: string;
  spaceId: string;
  sessionId: string;
  goal: string;
  invokerId: string;
}

export interface GenericSubagentResult {
  status: "completed";
  /** JSON response body retained verbatim so workflow persistence is always serializable. */
  output: string;
  receiptCard: { kind: "subagent_receipt"; collapsed: true; lines: [string, string] };
}

/** Executes one ephemeral verb. It cannot create threads, delegate, or exceed its context. */
export async function executeGenericSubagent(env: Pick<Env, "AGENTS_WORKER" | "PLATFORM_SECRET">, params: GenericSubagentParams): Promise<GenericSubagentResult> {
  const token = await mintInternalToken(env.PLATFORM_SECRET, params.tenantId);
  const response = await env.AGENTS_WORKER.fetch("https://agents-worker/internal/subagents/execute", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": params.tenantId, "x-naelao-internal-token": token },
    body: JSON.stringify({
      ephemeral: true,
      createThread: false,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      sessionId: params.sessionId,
      invokerId: params.invokerId,
      goal: params.goal,
      subagent: { id: params.manifest.id, name: params.manifest.name, description: params.manifest.description },
      allowedTools: params.manifest.allowedTools,
      knowledgeBaseIds: params.manifest.knowledgeBaseIds,
      maxContextTokens: NO_CODE_SUBAGENT_CONTEXT_CEILING,
    }),
  });
  if (!response.ok) throw new Error(`generic_subagent_failed:${response.status}:${(await response.text()).slice(0, 300)}`);
  const output = await response.text();
  return { status: "completed", output, receiptCard: { kind: "subagent_receipt", collapsed: true, lines: [`${params.manifest.name} completed`, "Ephemeral run · 2,000-token ceiling"] } };
}

export class GenericSubagentWorkflow extends WorkflowEntrypoint<Env, GenericSubagentParams> {
  async run(event: WorkflowEvent<GenericSubagentParams>, step: WorkflowStep): Promise<GenericSubagentResult> {
    const result = await step.do("execute-ephemeral-subagent", async () => executeGenericSubagent(this.env, event.payload));
    if (!result) throw new Error("generic_subagent_empty_result");
    return result;
  }
}
