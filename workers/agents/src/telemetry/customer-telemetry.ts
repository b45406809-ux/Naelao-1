export interface CustomerConversationRecord {
  id: string;
  spaceId: string;
  channel: string;
  customerId: string;
  transcript: unknown[];
  sentimentScore: number;
  unresolved: boolean;
  escalated: boolean;
}

export function clampSentiment(score: number): number {
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
}

export async function persistCustomerConversation(
  spacesWorker: Fetcher,
  tenantId: string,
  record: CustomerConversationRecord,
  headers: Record<string, string>
): Promise<void> {
  const response = await spacesWorker.fetch(
    new Request(
      `http://spaces-worker/internal/spaces/${encodeURIComponent(record.spaceId)}/customer-conversations`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "x-naelao-tenant-id": tenantId,
        },
        body: JSON.stringify({
          id: record.id,
          space_id: record.spaceId,
          channel: record.channel,
          customer_id: record.customerId,
          transcript_json: record.transcript,
          sentiment_score: clampSentiment(record.sentimentScore),
          unresolved: record.unresolved,
          escalated: record.escalated,
        }),
      }
    )
  );
  if (!response.ok)
    throw new Error(`customer_telemetry_write_failed:${response.status}`);
}
