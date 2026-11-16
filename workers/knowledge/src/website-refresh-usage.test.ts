import { describe, expect, it, vi } from "vitest";
import { flushWebsiteRefreshUsageOutbox } from "./website-refresh-usage.js";

const receipt = { run_id: "scheduled_" + "a".repeat(48), tenant_id: "tenant-a", space_id: "space-a",
  project_id: "project-a", idempotency_key: "knowledge-website-refresh:scheduled_" + "a".repeat(48) };

function fixture(responseStatus = 201) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db = { prepare: vi.fn((sql: string) => {
    const execute = (args: unknown[]) => ({
      all: async () => { calls.push({ sql, args }); return { results: [receipt] }; },
      run: async () => { calls.push({ sql, args }); return { meta: { changes: 1 } }; },
    });
    return { ...execute([]), bind: (...args: unknown[]) => execute(args) };
  }) };
  const requests: Request[] = [];
  const env = { PLATFORM_DB: db, PLATFORM_SECRET: "usage-receipt-test-secret",
    BILLING_WORKER: { fetch: vi.fn(async (request: Request) => {
      requests.push(request.clone());
      return new Response(JSON.stringify({ recorded: responseStatus === 201 }), { status: responseStatus });
    }) } };
  return { env, db, calls, requests };
}

describe("scheduled website refresh usage receipts", () => {
  it("sends an authenticated, stable unpriced receipt without a payer or metering decision", async () => {
    const f = fixture();
    await expect(flushWebsiteRefreshUsageOutbox(f.env as never, new Date("2026-11-16T12:00:00.000Z"))).resolves.toBe(1);
    const request = f.requests[0]!;
    expect(request.url).toBe("http://billing-worker/billing/usage");
    expect(request.headers.get("x-naelao-tenant-id")).toBe("tenant-a");
    expect(request.headers.get("x-naelao-internal-token")).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    await expect(request.json()).resolves.toEqual({ schema_version: 2, event_type: "knowledge_website_refresh_invocation",
      quantity: 1, unit: "invocations", space_id: "space-a", project_id: "project-a", run_id: receipt.run_id,
      idempotency_key: receipt.idempotency_key });
    expect(f.calls.at(-1)?.sql).toContain("status='sent'");
  });

  it("retains a failed delivery for retry with the exact same idempotency key", async () => {
    const f = fixture(503);
    await expect(flushWebsiteRefreshUsageOutbox(f.env as never)).resolves.toBe(0);
    expect(f.calls.at(-1)?.sql).toContain("status='pending'");
    expect(f.calls.at(-1)?.args).toContain("billing_usage_rejected");
    await expect(flushWebsiteRefreshUsageOutbox(f.env as never)).resolves.toBe(0);
    expect(f.requests).toHaveLength(2);
    await expect(f.requests[0]!.clone().json()).resolves.toMatchObject({ idempotency_key: receipt.idempotency_key,
      run_id: receipt.run_id });
    await expect(f.requests[1]!.clone().json()).resolves.toMatchObject({ idempotency_key: receipt.idempotency_key,
      run_id: receipt.run_id });
  });

  it("leaves pending receipts untouched when the Billing binding is absent", async () => {
    const f = fixture();
    delete (f.env as { BILLING_WORKER?: unknown }).BILLING_WORKER;
    await expect(flushWebsiteRefreshUsageOutbox(f.env as never)).resolves.toBe(0);
    expect(f.db.prepare).not.toHaveBeenCalled();
  });
});
