// Shared Env interface for agents worker (used by workflows and DOs)
import type { NaelaoAgentDO } from "./do/NaelaoAgentDO.js";
import type { HITLApprovalDO } from "./do/HITLApprovalDO.js";
import type { TaskDO } from "./do/TaskDO.js";

export interface Env {
  ENVIRONMENT: string;
  ANTHROPIC_API_KEY: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  NAELAO_AGENT_DO: DurableObjectNamespace<NaelaoAgentDO>;
  HITL_APPROVAL_DO: DurableObjectNamespace<HITLApprovalDO>;
  TASK_DO: DurableObjectNamespace<TaskDO>;
  KNOWLEDGE_WORKER: Fetcher;
  SPACES_WORKER: Fetcher;
  AGENTS_WORKER: Fetcher;
  AGENT_CACHE: KVNamespace;
  AGENT_TASK_WORKFLOW: { create(opts: { id?: string; params?: unknown }): Promise<void> };
  /** §A1.17 Phase J — durable dispatch for runtime:"workflow" scripts (ScriptRunWorkflow). */
  AGENT_SCRIPT_WORKFLOW?: {
    create(opts: { id?: string; params?: unknown }): Promise<{ id: string; status(): Promise<{ status: string; output?: unknown; error?: unknown }> }>;
    get(id: string): Promise<{ id: string; status(): Promise<{ status: string; output?: unknown; error?: unknown }> }>;
  };
}
