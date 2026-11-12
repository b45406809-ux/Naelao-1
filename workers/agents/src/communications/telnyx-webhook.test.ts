import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import type { AgentsEnv } from "../index.js";
import { ensureIdentity } from "./core.js";
import { defaultPhonePolicy } from "./phones.js";
import { registerTelnyxWebhook } from "./telnyx-webhook.js";

afterEach(() => vi.unstubAllGlobals());

describe("Telnyx extension ingress", () => {
  it("stores an admitted signed call.cost event once with hash-only call references", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access")
      ? Response.json({ effective_role: "owner" })
      : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({
      apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100", callControlId: "1234567890",
    }) })) } as unknown as Fetcher;
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,
      provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'extension','byo','telnyx','account-ref','12345',?,?,'active')`)
      .bind("cost-binding", identity.id, "+14155550100", JSON.stringify(defaultPhonePolicy)).run();
    const now = Math.floor(Date.now() / 1000);
    await f.db.prepare(`INSERT INTO assistant_telnyx_extension_calls(call_control_id,binding_id,caller,state,turn_count,
      started_at,expires_at,created_at,updated_at) VALUES('v3:call-control','cost-binding','+14155550101','ended',1,?,?,?,?)`)
      .bind(now - 120, now + 3600, now - 120, now).run();

    const event = {
      data: { id: "cost-event-1", event_type: "call.cost", occurred_at: "2026-11-12T10:00:00.000Z", payload: {
        call_control_id: "v3:call-control", connection_id: "1234567890", call_leg_id: "leg-identity-raw",
        call_session_id: "session-identity-raw", status: "success", total_cost: "0.0106", billed_duration_secs: 120,
        occurred_at: "2026-11-12T10:00:00.000Z", cost_parts: [
          { call_part: "sip-trunking", cost: "0.0050", currency: "USD" },
          { call_part: "call-recording", cost: "0.0038", currency: "USD" },
          { call_part: "call-control", cost: "0.0018", currency: "USD" },
        ],
      } },
    };
    const raw = JSON.stringify(event);
    const timestamp = String(now);
    const signature = sign(null, Buffer.from(`${timestamp}|${raw}`), keys.privateKey).toString("base64");
    const app = new Hono<{ Bindings: AgentsEnv }>(); registerTelnyxWebhook(app);
    const request = () => app.request("http://example/assistant-phone/telnyx/cost-binding", {
      method: "POST", headers: { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp }, body: raw,
    }, f.env);

    const result = await request();
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ accepted: true });
    await f.db.prepare("UPDATE assistant_telnyx_ingress_receipts SET state='indeterminate' WHERE binding_id='cost-binding' AND event_id='cost-event-1'").run();
    const replayed = await request();
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual({ accepted: true });
    expect((await request()).status).toBe(200);
    expect((await f.db.prepare(`SELECT provider,service_id,usage_kind,quantity_unit,quantity_micros,
      provider_cost_micros,currency,source_api FROM managed_service_provider_cost_observations`).first())
    ).toMatchObject({ provider: "telnyx", service_id: "telnyx.voice.call", usage_kind: "voice", quantity_unit: "second",
      quantity_micros: 120_000_000, provider_cost_micros: 10_600, currency: "USD", source_api: "telnyx.call_cost.webhook" });
    const receipt = await f.db.prepare("SELECT call_leg_id_sha256,call_session_id_sha256,first_event_id_sha256 FROM assistant_telnyx_voice_cost_receipts").first<Record<string, string>>();
    expect(receipt?.call_leg_id_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt?.call_session_id_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt?.first_event_id_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(receipt ?? {}).join(" ")).not.toContain("leg-identity-raw");
    expect(Object.values(receipt ?? {}).join(" ")).not.toContain("session-identity-raw");
  });

  it("rejects unadmitted calls and conflicting cost totals without adding another observation", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access")
      ? Response.json({ effective_role: "owner" })
      : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({
      apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100", callControlId: "connection-1",
    }) })) } as unknown as Fetcher;
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,
      provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'extension','byo','telnyx','account-ref','12345',?,?,'active')`)
      .bind("cost-binding", identity.id, "+14155550100", JSON.stringify(defaultPhonePolicy)).run();
    const app = new Hono<{ Bindings: AgentsEnv }>(); registerTelnyxWebhook(app);
    const now = String(Math.floor(Date.now() / 1000));
    const send = async (callControlId: string, eventId: string, totalCost: string) => {
      const raw = JSON.stringify({ data: { id: eventId, event_type: "call.cost", occurred_at: new Date().toISOString(), payload: {
        call_control_id: callControlId, connection_id: "connection-1", call_leg_id: "shared-leg", status: "success", total_cost: totalCost,
        billed_duration_secs: 60, cost_parts: [{ call_part: "sip-trunking", cost: totalCost, currency: "USD" }],
      } } });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = sign(null, Buffer.from(`${timestamp}|${raw}`), keys.privateKey).toString("base64");
      return app.request("http://example/assistant-phone/telnyx/cost-binding", { method: "POST",
        headers: { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp }, body: raw }, f.env);
    };
    expect(now).toMatch(/^\d+$/);
    expect((await send("v3:unknown-call", "cost-event-unknown", "0.01")).status).toBe(503);
    await f.db.prepare(`INSERT INTO assistant_telnyx_extension_calls(call_control_id,binding_id,caller,state,turn_count,
      started_at,expires_at,created_at,updated_at) VALUES('v3:known-call','cost-binding','+14155550101','ended',1,?,?,?,?)`)
      .bind(Math.floor(Date.now() / 1000) - 120, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000) - 120, Math.floor(Date.now() / 1000)).run();
    expect((await send("v3:known-call", "cost-event-first", "0.01")).status).toBe(200);
    expect((await send("v3:known-call", "cost-event-correction", "0.02")).status).toBe(503);
    expect((await f.db.prepare("SELECT count(*) AS n FROM managed_service_provider_cost_observations").first<{ n: number }>())?.n).toBe(1);
  });

  it("authenticates destination and dispatches once under concurrent delivery", async () => {
    const f = fixture();
    f.db.db.exec(readFileSync(new URL("../../../../infra/migrations/0137_telnyx_ingress_receipts.sql", import.meta.url), "utf8"));
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({ apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100" }) })) } as unknown as Fetcher;
    const dispatch = vi.fn(async () => Response.json({ message: "" }));
    f.env.AGENTS_WORKER = { fetch: dispatch } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'extension','byo','telnyx','account','12345','+14155550100',?,'active')").bind("binding-1", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    await f.db.prepare("INSERT INTO assistant_phone_extension_handlers(binding_id,installation_id,handler_sha256,status) VALUES('binding-1','ext-1',?,'active')").bind("a".repeat(64)).run();
    const raw = JSON.stringify({ data: { id: "event-1", event_type: "message.received", occurred_at: new Date().toISOString(), payload: { direction: "inbound", from: { phone_number: "+14155550101" }, to: [{ phone_number: "+14155550100" }], text: "hello", media: [] } } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(`${timestamp}|${raw}`), keys.privateKey).toString("base64");
    const app = new Hono<{ Bindings: AgentsEnv }>(); registerTelnyxWebhook(app);
    const request = (body: string, signed = signature) => app.request("http://example/assistant-phone/telnyx/binding-1", { method: "POST", headers: { "telnyx-signature-ed25519": signed, "telnyx-timestamp": timestamp }, body }, f.env);
    expect((await request(raw + " ")).status).toBe(401);
    const wrongDestination = raw.replace("+14155550100", "+14155550102");
    const wrongSignature = sign(null, Buffer.from(`${timestamp}|${wrongDestination}`), keys.privateKey).toString("base64");
    expect((await request(wrongDestination, wrongSignature)).status).toBe(422);
    expect(dispatch).not.toHaveBeenCalled();
    const results = await Promise.all(Array.from({ length: 10 }, () => request(raw)));
    expect(results.filter(result => result.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await request(raw)).status).toBe(200);
    await f.db.prepare("UPDATE assistant_phone_bindings SET purpose='assistant' WHERE id='binding-1'").run();
    await f.db.prepare("INSERT INTO assistant_communication_controllers(identity_id,user_id,channel,address,verified_at,status) VALUES(?,'user','phone','+14155550101',datetime('now'),'active')").bind(identity.id).run();
    const pairedBody = raw.replace("event-1", "event-2");
    const pairedSignature = sign(null, Buffer.from(`${timestamp}|${pairedBody}`), keys.privateKey).toString("base64");
    expect((await request(pairedBody, pairedSignature)).status).toBe(200);
    const unpairedBody = raw.replace("event-1", "event-3").replace("+14155550101", "+14155550103");
    const unpairedSignature = sign(null, Buffer.from(`${timestamp}|${unpairedBody}`), keys.privateKey).toString("base64");
    expect((await request(unpairedBody, unpairedSignature)).status).toBe(200);
    const commands = await f.db.prepare("SELECT controller_user_id,status FROM assistant_communication_commands WHERE identity_id=?").bind(identity.id).all<{ controller_user_id: string; status: string }>();
    expect(commands.results).toEqual([{ controller_user_id: "user", status: "pending" }]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("admits public Telnyx extension calls without entering the owner voice bridge", async () => {
    const f = fixture();
    f.db.db.exec(readFileSync(new URL("../../../../infra/migrations/0137_telnyx_ingress_receipts.sql", import.meta.url), "utf8"));
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access")
      ? Response.json({ effective_role: "owner" })
      : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({ apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100" }) })) } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'extension','byo','telnyx','account','12345','+14155550100',?,'active')")
      .bind("public-extension", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    await f.db.prepare("INSERT INTO assistant_phone_extension_handlers(binding_id,installation_id,handler_sha256,status) VALUES('public-extension','ext-1',?,'active')")
      .bind("a".repeat(64)).run();

    const carrier = vi.fn(async () => Response.json({ data: { result: "ok" } }));
    vi.stubGlobal("fetch", carrier);
    const raw = JSON.stringify({ data: { id: "public-call-1", event_type: "call.initiated", occurred_at: new Date().toISOString(), payload: {
      call_control_id: "v3:public-call-control", direction: "incoming", from: { phone_number: "+14155550101" }, to: { phone_number: "+14155550100" },
    } } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(`${timestamp}|${raw}`), keys.privateKey).toString("base64");
    const app = new Hono<{ Bindings: AgentsEnv }>(); registerTelnyxWebhook(app);
    const result = await app.request("http://example/assistant-phone/telnyx/public-extension", {
      method: "POST", headers: { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp }, body: raw,
    }, f.env);

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ accepted: true });
    expect(carrier).toHaveBeenCalledTimes(1);
    const [url, init] = carrier.mock.calls[0]!;
    expect(String(url)).toContain("/calls/v3%3Apublic-call-control/actions/answer");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({ command_id: expect.stringContaining("extension_answer") });
    expect(await f.db.prepare("SELECT binding_id,state FROM assistant_telnyx_extension_calls WHERE call_control_id='v3:public-call-control'").first())
      .toMatchObject({ binding_id: "public-extension", state: "answering" });
    expect(await f.db.prepare("SELECT call_control_id FROM assistant_telnyx_live_calls").first()).toBeNull();
    expect(await f.db.prepare("SELECT id FROM assistant_live_calls WHERE status='connected'").first()).toBeNull();
  });
});
