export function channelSessionStorageUsageEvent(input: {
  spaceId: string;
  projectId: string;
  installationId: string;
  messageId: string;
  kind: "default" | "named";
  bytesDelta: number;
}): Record<string, unknown> | null {
  if (!Number.isSafeInteger(input.bytesDelta) || input.bytesDelta === 0) return null;
  return {
    schema_version: 2,
    event_type: input.bytesDelta > 0 ? "storage_bytes_written" : "storage_bytes_deleted",
    quantity: Math.abs(input.bytesDelta),
    unit: "bytes",
    space_id: input.spaceId,
    project_id: input.projectId,
    installation_id: input.installationId,
    run_id: `channel:${input.messageId}`,
    idempotency_key: `channel-session-storage:${input.messageId}:${input.kind}`,
    payer_kind: "unknown",
    decision: input.bytesDelta > 0 ? "allowed" : "not_billable",
  };
}
