// MS-40: the platform's usage-by-period route (HMAC, Managed `naelao-` tenants only).
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { call, createInbox, fixture, seedTenant, SECRET, type Fixture } from "./test-helpers.js";

const START = Date.parse("2026-11-26T12:00:00Z");
const END = Date.parse("2026-12-26T12:00:00Z");

async function usage(f: Fixture, tenant: string, body: unknown, token?: string) {
  return call(f, "POST", "/internal/v1/usage/period", undefined, body, { "x-naelao-tenant-id": tenant, "x-naelao-internal-token": token ?? await mintInternalToken(SECRET, tenant) });
}
function sends(f: Fixture, tenant: string, inbox: string, count: number, at: string, tag: string) {
  for (let i = 0; i < count; i++) {
    f.db.prepare("INSERT INTO nemail_messages(id,nemail_tenant_id,inbox_id,direction) VALUES(?,?,?, 'outbound')").run(`msg_${tag}${i}`, tenant, inbox);
    f.db.prepare("INSERT INTO nemail_usage(id,nemail_tenant_id,meter,quantity,message_id,outcome,period,created_at) VALUES(?,?, 'email.message.sent', 1, ?, 'sent', ?, ?)").run(`use_${tag}${i}`, tenant, `msg_${tag}${i}`, at.slice(0, 7), at);
  }
}

describe("POST /internal/v1/usage/period", () => {
  it("counts one inbox's sent messages in [start, end) for a Managed tenant", async () => {
    const f = fixture();
    const key = await seedTenant(f, "naelao-t1");
    const a = await createInbox(f, key, "a-box");
    const b = await createInbox(f, key, "b-box");
    sends(f, "naelao-t1", a, 3, "2026-12-01 10:00:00", "a");
    sends(f, "naelao-t1", a, 2, "2026-11-26 11:59:59", "before");
    sends(f, "naelao-t1", a, 2, "2026-12-26 12:00:00", "after");
    sends(f, "naelao-t1", b, 5, "2026-12-01 10:00:00", "b");
    const res = await usage(f, "naelao-t1", { inbox_id: a, start_ms: START, end_ms: END });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { inbox_id: a, meter: "email.message.sent", start_ms: START, end_ms: END, sent_count: 3 } });
  });

  it("answers 404 for direct and AgentPort tenants, another tenant's inbox and unknown inboxes", async () => {
    const f = fixture();
    const direct = await seedTenant(f, "direct-t");
    const directInbox = await createInbox(f, direct, "d-box");
    const managedKey = await seedTenant(f, "naelao-t1");
    const managedInbox = await createInbox(f, managedKey, "m-box");
    expect((await usage(f, "direct-t", { inbox_id: directInbox, start_ms: START, end_ms: END })).status).toBe(404);
    expect((await usage(f, "agentport-t", { inbox_id: directInbox, start_ms: START, end_ms: END })).status).toBe(404);
    await seedTenant(f, "naelao-t2");
    expect((await usage(f, "naelao-t2", { inbox_id: managedInbox, start_ms: START, end_ms: END })).status).toBe(404);
    expect((await usage(f, "naelao-t1", { inbox_id: "inb_missing", start_ms: START, end_ms: END })).status).toBe(404);
  });

  it("requires a valid platform token and a valid body", async () => {
    const f = fixture();
    const key = await seedTenant(f, "naelao-t1");
    const inbox = await createInbox(f, key, "a-box");
    expect((await usage(f, "naelao-t1", { inbox_id: inbox, start_ms: START, end_ms: END }, "bad")).status).toBe(403);
    expect((await usage(f, "naelao-t2", { inbox_id: inbox, start_ms: START, end_ms: END }, await mintInternalToken(SECRET, "naelao-t1"))).status).toBe(403);
    expect((await call(f, "POST", "/internal/v1/usage/period", key, { inbox_id: inbox, start_ms: START, end_ms: END })).status).toBe(403);
    for (const body of [{}, { inbox_id: "x", start_ms: START, end_ms: END }, { inbox_id: inbox, start_ms: END, end_ms: START }, { inbox_id: inbox, start_ms: 0, end_ms: 200 * 86_400_000 }, { inbox_id: inbox, start_ms: 1.5, end_ms: 9 }]) {
      expect((await usage(f, "naelao-t1", body)).status).toBe(400);
    }
  });

  it("is a 404 with the worker flag off", async () => {
    const f = fixture({ NAELAO_EMAIL_ENABLED: "false" });
    expect((await usage(f, "naelao-t1", { inbox_id: "inb_x", start_ms: START, end_ms: END })).status).toBe(404);
  });
});
