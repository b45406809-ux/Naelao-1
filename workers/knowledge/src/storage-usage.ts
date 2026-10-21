import { mintInternalToken } from "@naelao/http";

export interface KnowledgeStorageUsageEnv {
  PLATFORM_SECRET: string;
  BILLING_WORKER?: Fetcher;
}

export async function reportKnowledgeStorageWrite(
  env: KnowledgeStorageUsageEnv,
  tenantId: string,
  spaceId: string,
  projectId: string | null,
  documentId: string,
  bytesWritten: number,
  succeeded: boolean,
  operationId = documentId,
): Promise<void> {
  if (!env.BILLING_WORKER || !Number.isSafeInteger(bytesWritten) || bytesWritten <= 0
    || typeof operationId !== "string" || !operationId || operationId.length > 160) return;
  try {
    const token = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
    await env.BILLING_WORKER.fetch(new Request("http://billing-worker/billing/usage", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token },
      body: JSON.stringify({
        schema_version: 2, event_type: "storage_bytes_written", quantity: bytesWritten, unit: "bytes",
        space_id: spaceId, ...(projectId ? { project_id: projectId } : {}),
        idempotency_key: `knowledge-storage:${operationId}`, payer_kind: "unknown",
        decision: succeeded ? "allowed" : "failed",
      }),
    }));
  } catch {
    /* storage accounting is best effort and never fails an already written Knowledge document */
  }
}
