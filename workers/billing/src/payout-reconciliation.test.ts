import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileDeveloperPayouts } from "./payout-reconciliation.js";

function databaseStub() {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const rowsFor = (sql: string) => {
    if (sql.includes("developer_partner_profiles")) return { results: [{ user_id: "developer-1" }] };
    if (sql.includes("FROM developer_payouts WHERE status")) return { results: [{ id: "payout-1" }] };
    return { results: [] };
  };
  const db = {
    prepare(sql: string) {
      return {
        async all() { return rowsFor(sql); },
        bind(...values: unknown[]) {
          return {
            async all() { return rowsFor(sql); },
            async first() {
              if (sql.includes("RETURNING id, amount_cents")) return {
                id: "payout-1", amount_cents: 1250, destination_snapshot: "acct_123",
                attempt_started_at: Date.now() - 1_000, status: "processing",
              };
              return { id: "payout-1", amount_cents: 1250 };
            },
            async run() {
              writes.push({ sql, values });
              return { success: true };
            },
          };
        },
      };
    },
    async batch() { return []; },
  };
  return { db: db as unknown as D1Database, writes };
}

function oversizedTransferResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"tr_1","amount":1250,"currency":"usd","destination":"acct_123","extra":"'));
      controller.enqueue(new Uint8Array(64 * 1024 + 1).fill(0x61));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  }));
}

describe("Stripe payout provider response boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps an oversized transfer response deferred instead of marking the payout paid", async () => {
    const { db, writes } = databaseStub();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ capabilities: { transfers: "active" } }))
      .mockResolvedValueOnce(oversizedTransferResponse()));

    const result = await reconcileDeveloperPayouts({ PLATFORM_DB: db, STRIPE_CONNECT_SECRET_KEY: "stripe-secret" }, Date.now(), false);
    expect(result).toEqual({ queued: 0, paid: 0, deferred: 1 });
    expect(writes.some((write) => write.sql.includes("status = 'paid'"))).toBe(false);
    expect(writes.some((write) => write.values.includes("response_too_large"))).toBe(true);
  });
});
