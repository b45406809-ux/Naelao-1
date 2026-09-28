export interface CustomerAnalyticsAlert {
  conversationId: string;
  channel: string;
  customerId: string;
  sentimentScore: number;
  unresolved: boolean;
}

export async function runCustomerAnalyticsScan(
  spaceId: string,
  services: {
    listUnalerted(spaceId: string): Promise<CustomerAnalyticsAlert[]>;
    alertOwner(spaceId: string, alert: CustomerAnalyticsAlert): Promise<void>;
    markAlerted(spaceId: string, ids: string[]): Promise<void>;
  }
): Promise<{ scanned: number; alerted: number }> {
  const rows = await services.listUnalerted(spaceId);
  const urgent = rows.filter(
    (row) => row.sentimentScore < -0.6 || row.unresolved
  );
  for (const row of urgent) await services.alertOwner(spaceId, row);
  if (urgent.length)
    await services.markAlerted(
      spaceId,
      urgent.map((row) => row.conversationId)
    );
  return { scanned: rows.length, alerted: urgent.length };
}
