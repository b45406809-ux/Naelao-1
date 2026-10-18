import { mintInternalToken } from "@naelao/http";

export interface ExtensionStorageUsageEnv {
  PLATFORM_SECRET: string;
  BILLING_WORKER?: Fetcher;
}

/** Record bytes actually added to immutable extension artifact storage. Pricing remains unknown. */
export async function reportExtensionArtifactWrite(
  env: ExtensionStorageUsageEnv,
  input: { tenantId: string; spaceId: string; projectId: string; bundleId: string; version: string; path: string; bytes: number },
): Promise<void> {
  if (!env.BILLING_WORKER || !Number.isSafeInteger(input.bytes) || input.bytes <= 0) return;
  try {
    const idempotencyKey = `extension-artifact:${input.spaceId}:${input.bundleId}:${input.version}:${input.path}`;
    await env.BILLING_WORKER.fetch(new Request("http://billing-worker/billing/usage", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": input.tenantId,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, input.tenantId),
      },
      body: JSON.stringify({
        schema_version: 2,
        event_type: "storage_bytes_written",
        quantity: input.bytes,
        unit: "bytes",
        space_id: input.spaceId,
        project_id: input.projectId,
        run_id: `${input.bundleId}@${input.version}:${input.path}`,
        idempotency_key: idempotencyKey,
        payer_kind: "unknown",
        decision: "allowed",
      }),
    }));
  } catch {
    // Metering is best effort here; artifact installation must not be rolled back after an R2 put.
  }
}
