import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type NotificationsEnv } from "./index.js";

type Outcome = {
  outcome: string;
  last_http_status: number | null;
  provider_receipt_id: string | null;
  failure_code: string | null;
};

function env() {
  const rows = new Map<string, Outcome>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const key = args.slice(0, 4).join("\u0000");
          return {
            async first<T>() {
              if (sql.includes("FROM orgs")) return { status: "active" } as T;
              if (sql.includes("FROM spaces")) return { id: args[0], config_json: "{}" } as T;
              if (sql.includes("SELECT outcome,last_http_status,provider_receipt_id,failure_code")) {
                return (rows.get(key) ?? null) as T | null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO notification_delivery_attempts")) {
                if (rows.has(key)) return { success: true, meta: { changes: 0 } };
                rows.set(key, { outcome: "attempt_ambiguous", last_http_status: null,
                  provider_receipt_id: null, failure_code: "dispatch_in_progress" });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE notification_delivery_attempts")) {
                const [status, httpStatus, receipt, failure, , , , tenant, notificationId, channel, provider] = args;
                const rowKey = [tenant, notificationId, channel, provider].join("\u0000");
                const row = rows.get(rowKey);
                if (!row || row.failure_code !== "dispatch_in_progress") return { success: true, meta: { changes: 0 } };
                rows.set(rowKey, { outcome: String(status), last_http_status: (httpStatus as number | null) ?? null,
                  provider_receipt_id: (receipt as string | null) ?? row.provider_receipt_id,
                  failure_code: (failure as string | null) ?? null });
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const notificationsEnv: NotificationsEnv = {
    ENVIRONMENT: "test", RESEND_API_KEY: "test-key", RESEND_API_URL: "https://resend.test",
    WEBHOOK_SIGNING_SECRET: "test-secret", PLATFORM_DB: db as unknown as D1Database,
  };
  return { notificationsEnv, rows };
}

function request(notificationId: string) {
  return new Request("https://notifications/internal/notify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" },
    body: JSON.stringify({ channel: "email", notification_id: notificationId,
      to: "private-recipient@example.test", subject: "private subject", body: "private body" }),
  });
}

describe("synchronous notification outcome ledger", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists provider acceptance and returns the stored result on duplicate calls", async () => {
    const fixture = env();
    const egress = vi.fn(async () => Response.json({ id: "receipt_123" }));
    vi.stubGlobal("fetch", egress);

    const first = await worker.fetch!(request("approval:op-1"), fixture.notificationsEnv, {} as ExecutionContext);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: "provider_accepted", accepted: true,
      notification_id: "approval:op-1", provider_receipt_id: "receipt_123", outcome_recorded: true });
    const retry = await worker.fetch!(request("approval:op-1"), fixture.notificationsEnv, {} as ExecutionContext);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ outcome: "provider_accepted", accepted: true, idempotent_replay: true });
    expect(egress).toHaveBeenCalledOnce();
    const stored = [...fixture.rows.values()];
    expect(stored).toEqual([expect.objectContaining({ outcome: "provider_accepted", provider_receipt_id: "receipt_123" })]);
    expect(JSON.stringify(stored)).not.toContain("private-");
    expect(JSON.stringify(stored)).not.toContain("example.test");
  });

  it("holds a lost provider response as ambiguous and does not automatically resend", async () => {
    const fixture = env();
    const egress = vi.fn(async () => { throw new Error("socket closed"); });
    vi.stubGlobal("fetch", egress);

    const first = await worker.fetch!(request("foundry:event-1:reply:0"), fixture.notificationsEnv, {} as ExecutionContext);
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({ outcome: "attempt_ambiguous", reconcile_required: true,
      notification_id: "foundry:event-1:reply:0", outcome_recorded: true });
    const retry = await worker.fetch!(request("foundry:event-1:reply:0"), fixture.notificationsEnv, {} as ExecutionContext);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ outcome: "attempt_ambiguous", reconcile_required: true, idempotent_replay: true });
    expect(egress).toHaveBeenCalledOnce();
    expect([...fixture.rows.values()]).toEqual([expect.objectContaining({ outcome: "attempt_ambiguous", failure_code: "provider_request_ambiguous" })]);
  });

  it("records provider rejection without retaining message or recipient fields", async () => {
    const fixture = env();
    const egress = vi.fn(async () => new Response("rejected", { status: 400 }));
    vi.stubGlobal("fetch", egress);
    const response = await worker.fetch!(request("approval:op-2"), fixture.notificationsEnv, {} as ExecutionContext);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ outcome: "provider_rejected", outcome_recorded: true,
      notification_id: "approval:op-2" });
    expect([...fixture.rows.values()]).toEqual([expect.objectContaining({ outcome: "provider_rejected", last_http_status: 400 })]);
  });

  it("records a known preflight denial as not sent without provider egress", async () => {
    const fixture = env();
    const egress = vi.fn();
    vi.stubGlobal("fetch", egress);
    const response = await worker.fetch!(new Request("https://notifications/internal/notify", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" },
      body: JSON.stringify({ channel: "email", notification_id: "digest:missing-recipient", subject: "private subject" }),
    }), fixture.notificationsEnv, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ outcome: "not_sent", reason: "email_recipient_missing", outcome_recorded: true });
    expect(egress).not.toHaveBeenCalled();
    expect([...fixture.rows.values()]).toEqual([expect.objectContaining({ outcome: "not_sent", failure_code: "email_recipient_missing" })]);
  });
});
