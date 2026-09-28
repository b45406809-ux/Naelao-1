export type WorkflowReceiptStatus = "succeeded" | "failed" | "cancelled";
export interface WorkflowRunReceiptInput {
  runId: string; workflowName: string; status: WorkflowReceiptStatus; durationMs: number;
  summary: string; stdout?: string; stderr?: string; compilerOutput?: string;
}
export interface WorkflowReceiptCard {
  kind: "workflow_receipt"; runId: string; workflowName: string; status: WorkflowReceiptStatus;
  durationMs: number; logUrl: string; summary: string; collapsed: true; lines: [string, string];
}
export interface ReceiptCardTransport {
  logs: { put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown> };
  emit(card: WorkflowReceiptCard): Promise<void>;
  logUrl?(key: string): string;
}

export async function emitWorkflowReceiptCard(input: WorkflowRunReceiptInput, transport: ReceiptCardTransport): Promise<WorkflowReceiptCard> {
  const key = `runs/${encodeURIComponent(input.runId)}/logs.txt`;
  const logs = [`# ${input.workflowName}`, input.stdout ?? "", input.stderr ?? "", input.compilerOutput ?? ""].join("\n");
  await transport.logs.put(key, logs, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  const icon = input.status === "succeeded" ? "🟢 Succeeded" : input.status === "failed" ? "🔴 Failed" : "🟡 Cancelled";
  const card: WorkflowReceiptCard = {
    kind: "workflow_receipt", runId: input.runId, workflowName: input.workflowName, status: input.status,
    durationMs: input.durationMs, logUrl: transport.logUrl?.(key) ?? `r2://${key}`, summary: input.summary,
    collapsed: true,
    lines: [`⏰ Workflow Completed: ${input.workflowName} | Status: ${icon} | Duration: ${input.durationMs}ms`, "Inspect Full Logs"],
  };
  await transport.emit(card);
  return card;
}
