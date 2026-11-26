// MS-41: the platform's inbox sending pause route (HMAC, Managed `naelao-` tenants only).
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { call, createInbox, fixture, seedTenant, sendMail, SECRET, type Fixture } from "./test-helpers.js";

const ok = { to: ["bob@example.com"], subject: "Hi", text: "hello" };
async function pause(f: Fixture, tenant: string, body: unknown, token?: string) {
  return call(f, "POST", "/internal/v1/inboxes/sending", undefined, body, { "x-naelao-tenant-id": tenant, "x-naelao-internal-token": token ?? await mintInternalToken(SECRET, tenant) });
}
const code = async (r: Response) => (await r.json() as { error_code?: string }).error_code;

describe("POST /internal/v1/inboxes/sending", () => {
  it("pauses one inbox, blocks its sends only, and resumes", async () => {
    const f = fixture();
    const key = await seedTenant(f, "naelao-t1");
    const a = await createInbox(f, key, "a-box");
    const b = await createInbox(f, key, "b-box");
    expect((await sendMail(f, key, a, ok)).status).toBe(201);
    const paused = await pause(f, "naelao-t1", { inbox_id: a, paused: true });
    expect(await paused.json()).toEqual({ data: { inbox_id: a, sending_paused: true, pause_reason: "subscription_suspended" } });
    expect(await code(await sendMail(f, key, a, ok))).toBe("sending_paused");
    expect((await sendMail(f, key, b, ok)).status).toBe(201);
    const resumed = await pause(f, "naelao-t1", { inbox_id: a, paused: false });
    expect(await resumed.json()).toEqual({ data: { inbox_id: a, sending_paused: false, pause_reason: null } });
    expect((await sendMail(f, key, a, ok)).status).toBe(201);
  });

  it("never overwrites or lifts a pause it does not own", async () => {
    const f = fixture();
    const key = await seedTenant(f, "naelao-t1");
    const a = await createInbox(f, key, "a-box");
    f.db.prepare("UPDATE nemail_inboxes SET sending_paused=1 WHERE id=?").run(a);
    await pause(f, "naelao-t1", { inbox_id: a, paused: true });
    expect(f.db.prepare("SELECT sending_pause_reason AS r FROM nemail_inboxes WHERE id=?").get(a)).toEqual({ r: null });
    const res = await pause(f, "naelao-t1", { inbox_id: a, paused: false });
    expect(await res.json()).toMatchObject({ data: { sending_paused: true } });
  });

  it("answers 404 for direct, AgentPort, other-tenant and unknown inboxes, 403 for a bad token, 400 for a bad body", async () => {
    const f = fixture();
    const direct = await seedTenant(f, "direct-t");
    const directInbox = await createInbox(f, direct, "d-box");
    const key = await seedTenant(f, "naelao-t1");
    const inbox = await createInbox(f, key, "m-box");
    await seedTenant(f, "naelao-t2");
    expect((await pause(f, "direct-t", { inbox_id: directInbox, paused: true })).status).toBe(404);
    expect((await pause(f, "agentport-t", { inbox_id: directInbox, paused: true })).status).toBe(404);
    expect((await pause(f, "naelao-t2", { inbox_id: inbox, paused: true })).status).toBe(404);
    expect((await pause(f, "naelao-t1", { inbox_id: "inb_missing", paused: true })).status).toBe(404);
    expect((await pause(f, "naelao-t1", { inbox_id: inbox, paused: true }, "bad")).status).toBe(403);
    expect((await call(f, "POST", "/internal/v1/inboxes/sending", key, { inbox_id: inbox, paused: true })).status).toBe(403);
    for (const body of [{}, { inbox_id: "x", paused: true }, { inbox_id: inbox }, { inbox_id: inbox, paused: "yes" }]) expect((await pause(f, "naelao-t1", body)).status).toBe(400);
    expect(f.db.prepare("SELECT sending_paused FROM nemail_inboxes WHERE id=?").get(directInbox)).toEqual({ sending_paused: 0 });
  });

  it("is a 404 with the worker flag off", async () => {
    const f = fixture({ NAELAO_EMAIL_ENABLED: "false" });
    expect((await pause(f, "naelao-t1", { inbox_id: "inb_x", paused: true })).status).toBe(404);
  });
});
