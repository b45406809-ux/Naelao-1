import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { reconcileStaleCustomerVoiceCalls } from "./call-reconciliation.js";

const staleCall = {
  call_sid: `CA${"a".repeat(32)}`,
  number_binding_id: "binding-1",
  tenant_id: "tenant-1",
  space_id: "space-1",
  provider_account_sid: `AC${"b".repeat(32)}`,
  inbound_price_per_minute_minor: 3,
  max_call_duration_seconds: 300,
  status: "connected" as const,
  ticket_expires_at: "2026-10-15T00:01:00.000Z",
};

function database(rows = [staleCall]) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          statements.push({ sql, values });
          return {
            all: vi.fn(async () => ({ results: rows })),
            run: vi.fn(async () => ({ meta: { changes: sql.includes("status='issued'") ? 2 : 1 } })),
          };
        },
      };
    },
  };
  return { db: db as never, statements };
}

describe("customer voice call reconciliation", () => {
  it("settles a stale connected call only after Twilio confirms terminal status", async () => {
    const { db, statements } = database();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`https://api.twilio.com/2010-04-01/Accounts/${staleCall.provider_account_sid}/Calls/${staleCall.call_sid}.json`);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toContain("Basic ");
      return Response.json({ sid: staleCall.call_sid, status: "completed", duration: "61" });
    });
    const result = await reconcileStaleCustomerVoiceCalls({
      db,
      tenantId: "tenant-1",
      spaceId: "space-1",
      now: new Date("2026-10-15T01:00:00.000Z"),
      credentialsForSpace: async () => ({ accountSid: staleCall.provider_account_sid, authToken: "owner-secret-value" }),
      fetcher,
    });
    expect(result).toEqual({ expired: 2, reconciled: 1, pending: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const settlement = statements.at(-1)!;
    expect(settlement.sql).toContain("status='connected'");
    expect(settlement.values.slice(0, 5)).toEqual(["completed", "2026-10-15T01:00:00.000Z", 61, 6, "2026-10-15T01:00:00.000Z"]);
    expect(settlement.values).not.toContain("owner-secret-value");
  });

  it("retains a reservation while Twilio reports an active call", async () => {
    const { db, statements } = database();
    const fetcher = vi.fn(async () => Response.json({ sid: staleCall.call_sid, status: "in-progress", duration: "301" }));
    const result = await reconcileStaleCustomerVoiceCalls({
      db, tenantId: "tenant-1", spaceId: "space-1", now: new Date("2026-10-15T01:00:00.000Z"),
      credentialsForSpace: async () => ({ accountSid: staleCall.provider_account_sid, authToken: "owner-secret-value" }), fetcher,
    });
    expect(result).toEqual({ expired: 2, reconciled: 0, pending: 1 });
    expect(statements.some(({ sql }) => sql.includes("SET status=?,ended_at=?"))).toBe(false);
  });

  it("does not query a Twilio account that differs from the bound account", async () => {
    const { db } = database();
    const fetcher = vi.fn();
    const result = await reconcileStaleCustomerVoiceCalls({
      db, tenantId: "tenant-1", spaceId: "space-1", now: new Date("2026-10-15T01:00:00.000Z"),
      credentialsForSpace: async () => ({ accountSid: `AC${"c".repeat(32)}`, authToken: "owner-secret-value" }), fetcher,
    });
    expect(result).toEqual({ expired: 2, reconciled: 0, pending: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("replays stale-call selection and settlement against the real SQLite schema", async () => {
    const storage = createDOStorage();
    storage.sql.exec(readFileSync(join(__dirname, "../../../../infra/migrations/0097_customer_voice_telephony.sql"), "utf8"));
    storage.sql.exec(`INSERT INTO customer_voice_number_bindings(id,provider,provider_account_sid,provider_number_sid,tenant_id,space_id,agent_id,phone_number,country_code,monthly_cost_minor,currency,monthly_quote_at,inbound_price_per_minute_minor,max_call_duration_seconds,created_by,created_at,updated_at)
      VALUES('binding-1','twilio','${staleCall.provider_account_sid}','PN${"c".repeat(32)}','tenant-1','space-1','agent-1','+14155550199','US',0,'USD','now',3,300,'owner','now','now')`);
    const connectedSid = staleCall.call_sid;
    storage.sql.exec(`INSERT INTO customer_voice_call_admissions(call_sid,number_binding_id,tenant_id,space_id,agent_id,caller_number,called_number,status,ticket_nonce,ticket_token,issued_at,ticket_expires_at,connected_at,reserved_cost_minor,reserved_duration_seconds,updated_at)
      VALUES(?,?,? ,?,'agent-1','+14155550100','+14155550199','connected','nonce-1','opaque','2026-10-15T00:00:00.000Z','2026-10-15T00:01:00.000Z','2026-10-15T00:00:10.000Z',15,300,'2026-10-15T00:00:10.000Z')`, connectedSid, "binding-1", "tenant-1", "space-1");
    storage.sql.exec(`INSERT INTO customer_voice_call_admissions(call_sid,number_binding_id,tenant_id,space_id,agent_id,caller_number,called_number,status,ticket_nonce,ticket_token,issued_at,ticket_expires_at,reserved_cost_minor,reserved_duration_seconds,updated_at)
      VALUES(?,'binding-1','tenant-1','space-1','agent-1','+14155550100','+14155550199','issued','nonce-2','opaque','2026-10-15T00:00:00.000Z','2026-10-15T00:01:00.000Z',15,300,'2026-10-15T00:00:00.000Z')`, `CA${"d".repeat(32)}`);
    const db = {
      prepare(sql: string) {
        return { bind(...values: unknown[]) {
          return {
            all: async <T>() => ({ results: storage.sql.exec<T>(sql, ...values).toArray() }),
            run: async () => ({ meta: { changes: storage.sql.exec(sql, ...values).rowsWritten } }),
          };
        } };
      },
    };
    const result = await reconcileStaleCustomerVoiceCalls({
      db: db as never,
      tenantId: "tenant-1",
      spaceId: "space-1",
      now: new Date("2026-10-15T01:00:00.000Z"),
      credentialsForSpace: async () => ({ accountSid: staleCall.provider_account_sid, authToken: "secret-auth-token" }),
      fetcher: async () => Response.json({ sid: connectedSid, status: "completed", duration: "61" }),
    });
    expect(result).toEqual({ expired: 1, reconciled: 1, pending: 0 });
    expect(storage.sql.exec<{ status: string; duration_seconds: number; actual_cost_minor: number; reserved_cost_minor: number }>(
      "SELECT status,duration_seconds,actual_cost_minor,reserved_cost_minor FROM customer_voice_call_admissions WHERE call_sid=?", connectedSid,
    ).toArray()).toEqual([{ status: "completed", duration_seconds: 61, actual_cost_minor: 6, reserved_cost_minor: 0 }]);
  });
});
