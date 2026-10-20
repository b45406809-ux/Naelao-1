import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { readBoundedResponseText } from "../shared/bounded-response-text.js";

const MAX_AUTOMATION_RESULT_BYTES = 1024 * 1024;

export interface CompanyAutomationOperation { name: string; input?: Record<string, unknown>; semantic?: boolean }
export interface CompanyAutomationParams { tenantId: string; spaceId: string; automationId: string; operations: CompanyAutomationOperation[] }
export interface CompanyAutomationEnv {
  AGENTS_WORKER: Fetcher;
  NOTIFICATIONS_WORKER: Fetcher;
}

export function validateCompanyAutomationOperations(operations: readonly CompanyAutomationOperation[]): void {
  if (!operations.length) throw new Error("company_automation_operations_required");
  const deterministic = operations.filter(operation => operation.semantic !== true).length;
  if (deterministic / operations.length < 0.9) throw new Error("company_automation_deterministic_ratio_below_90_percent");
}

/** Class 1 operational pipeline: deterministic by default; AI is reserved for flagged anomalies. */
export class CompanyAutomationWorkflow extends WorkflowEntrypoint<CompanyAutomationEnv, CompanyAutomationParams> {
  async run(event: WorkflowEvent<CompanyAutomationParams>, step: WorkflowStep): Promise<void> {
    const p = event.payload;
    try {
      validateCompanyAutomationOperations(p.operations);
      for (const [index, operation] of p.operations.entries()) {
        await step.do(`operation-${index}-${operation.name}`, async () => {
          const response = await this.env.AGENTS_WORKER.fetch("https://agents-worker/internal/automations/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...p, operation, mode: operation.semantic ? "semantic_anomaly" : "deterministic" }) });
          if (!response.ok) throw new Error(`automation_operation_failed:${operation.name}:${response.status}`);
          try { return await readBoundedResponseText(response, MAX_AUTOMATION_RESULT_BYTES); }
          catch { throw new Error("automation_result_too_large"); }
        });
      }
    } catch (error) {
      await this.env.NOTIFICATIONS_WORKER.fetch("https://notifications-worker/internal/executive-alert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cabinetWorker: "comms_worker", tenantId: p.tenantId, spaceId: p.spaceId, automationId: p.automationId, channels: ["executive_channel", "founder_telegram"], severity: "critical", error: error instanceof Error ? error.message : String(error) }) });
      throw error;
    }
  }
}
