// Shared Env interface for agents worker (used by workflows and DOs)
import type { NaelaoAgentDO } from "./do/NaelaoAgentDO.js";
import type { HITLApprovalDO } from "./do/HITLApprovalDO.js";
import type { TaskDO } from "./do/TaskDO.js";
import type { DurableWorkflowHostEnv } from "./workflows/workflow-host.js";

export interface Env extends DurableWorkflowHostEnv, Cloudflare.Env {
  ENVIRONMENT: string;
  /** Deployment must supply the actual immutable bundle SHA-256, not a mutable version name. */
  WORKFLOW_BUILD_ID?: string;
  DATA_JURISDICTION?: "eu";
  OPENROUTER_API_KEY?: string;
  SYSTEM_ONE_MODEL?: string;
  SYSTEM_ONE_PROVIDER?: "jev" | "laya" | "clef" | "openrouter";
  ANTHROPIC_API_KEY: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  NAELAO_AGENT_DO: DurableObjectNamespace<NaelaoAgentDO>;
  HITL_APPROVAL_DO: DurableObjectNamespace<HITLApprovalDO>;
  TASK_DO: DurableObjectNamespace<TaskDO>;
  KNOWLEDGE_WORKER: Fetcher;
  SPACES_WORKER: Fetcher;
  AGENTS_WORKER: Fetcher;
  /** Already bound in wrangler.toml (naelao-billing); added here so Workflow classes (which
   *  share this Env, not AgentDOEnv) can report §A1.26 infra-credit usage for their own steps. */
  BILLING_WORKER?: Fetcher;
  AGENT_CACHE: KVNamespace;
  AGENT_TASK_WORKFLOW: { create(opts: { id?: string; params?: unknown }): Promise<void> };
  GENERIC_SUBAGENT_WORKFLOW?: { create(opts: { id?: string; params: unknown }): Promise<{ id: string }> };
  /** §A1.17 Phase J — durable dispatch for runtime:"workflow" scripts (ScriptRunWorkflow). */
  SCHEDULED_REMINDER_WORKFLOW?: { create(opts: { id?: string; params: unknown }): Promise<{ id: string }> };
  VOICE_CALLS?: Fetcher;
}
