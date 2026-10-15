import { describe, expect, it } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CUSTOMER_VOICE_ADMISSION_SQL,
  CUSTOMER_VOICE_TICKET_TTL_MS,
  customerVoiceAdmissionBindings,
  decodeCustomerVoiceTicketPayload,
  isE164,
  mintCustomerVoiceTicket,
  parseTwilioVoiceCredentials,
  twilioFormParameters,
  twimlStreamResponse,
  twimlConsentResponse,
  validateTwilioFormWebhook,
  validateTwilioMediaStream,
  verifyCustomerVoiceTicket,
} from "./customer-telephony.js";

const secret = "twilio-auth-token-for-tests";
const ticketInput = {
  tenantId: "tenant-1", spaceId: "space-1", bindingId: "binding-1", agentId: "agent-1",
  callSid: "CA0123456789abcdef0123456789abcdef", caller: "+14155550100", called: "+14155550199",
};

describe("customer telephony authorization primitives", () => {
  it("issues call-bound, expiring tickets and rejects changes, wrong calls, and expiry", async () => {
    const now = 1_800_000_000_000;
    const { token, ticket } = await mintCustomerVoiceTicket(ticketInput, secret, now);
    expect(ticket.expiresAt - ticket.issuedAt).toBe(CUSTOMER_VOICE_TICKET_TTL_MS);
    expect(await verifyCustomerVoiceTicket(token, secret, ticketInput.callSid, now + 1)).toMatchObject(ticket);
    expect(decodeCustomerVoiceTicketPayload(token)).toMatchObject(ticket);
    expect(decodeCustomerVoiceTicketPayload("tampered")).toBeNull();
    expect(await verifyCustomerVoiceTicket(token, secret, "CAffffffffffffffffffffffffffffffff", now + 1)).toBeNull();
    expect(await verifyCustomerVoiceTicket(token, "wrong-secret", ticketInput.callSid, now + 1)).toBeNull();
    expect(await verifyCustomerVoiceTicket(token, secret, ticketInput.callSid, ticket.expiresAt)).toBeNull();
  });

  it("parses Twilio duplicate form fields without losing values and validates the official signature", () => {
    const rawBody = "CallSid=CA0123456789abcdef0123456789abcdef&To=%2B14155550199&Tag=first&Tag=second";
    const url = "https://api.example.test/customer-voice/twilio/answer/binding-1";
    const params = twilioFormParameters(rawBody);
    expect(params).toMatchObject({ Tag: ["first", "second"] });
    const signature = getExpectedTwilioSignature(secret, url, params);
    expect(validateTwilioFormWebhook({ authToken: secret, signature, canonicalUrl: url, rawBody })).toBe(true);
    expect(validateTwilioFormWebhook({ authToken: secret, signature, canonicalUrl: `${url}/other`, rawBody })).toBe(false);
  });

  it("validates signed WebSocket URLs and rejects a URL with a query string", () => {
    const url = "wss://api.example.test/customer-voice/twilio/stream/ticket-token";
    const signature = getExpectedTwilioSignature(secret, url, {});
    expect(validateTwilioMediaStream({ authToken: secret, signature, canonicalUrl: url })).toBe(true);
    expect(validateTwilioMediaStream({ authToken: secret, signature, canonicalUrl: `${url}/tampered` })).toBe(false);
    expect(() => twimlStreamResponse(`${url}?ticket=unsafe`)).toThrow("invalid_customer_voice_stream_url");
    expect(twimlStreamResponse(url)).toContain(url);
  });

  it("validates account credentials and E.164 values without logging or returning secrets", () => {
    const accountSid = `AC${"a".repeat(32)}`;
    expect(parseTwilioVoiceCredentials(JSON.stringify({ accountSid, authToken: secret }))).toEqual({ accountSid, authToken: secret });
    expect(parseTwilioVoiceCredentials(JSON.stringify({ accountSid: "not-an-account", authToken: secret }))).toBeNull();
    expect(isE164("+14155550100")).toBe(true);
    expect(isE164("14155550100")).toBe(false);
    expect(isE164("+0123")).toBe(false);
  });

  it("requires an HTTPS consent callback and does not expose a recording path", () => {
    const response = twimlConsentResponse("https://api.example.test/customer-voice/twilio/consent/ticket");
    expect(response).toContain("Press 1 to continue");
    expect(response).toContain("not recorded");
    expect(response).not.toContain("<Record");
    expect(() => twimlConsentResponse("https://api.example.test/consent?redirect=unsafe")).toThrow("invalid_customer_voice_consent_url");
  });

  it("atomically reserves per-Space spend, duration, and concurrency before admitting calls", () => {
    const storage = createDOStorage();
    storage.sql.exec(readFileSync(join(__dirname, "../../../../infra/migrations/0097_customer_voice_telephony.sql"), "utf8"));
    storage.sql.exec("INSERT INTO customer_voice_space_policies(tenant_id,space_id,max_concurrent_calls,max_calls_per_hour,max_daily_minutes,monthly_spend_limit_minor,updated_by,updated_at) VALUES('tenant-1','space-1',1,10,1,2,'owner','now')");
    storage.sql.exec(`INSERT INTO customer_voice_number_bindings(id,provider,provider_account_sid,provider_number_sid,tenant_id,space_id,agent_id,phone_number,country_code,monthly_cost_minor,currency,monthly_quote_at,inbound_price_per_minute_minor,created_by,created_at,updated_at)
      VALUES('binding-1','twilio','AC${"a".repeat(32)}','PN${"b".repeat(32)}','tenant-1','space-1','agent-1','+14155550199','US',0,'USD','now',2,'owner','now','now')`);
    const values = (callSid: string) => customerVoiceAdmissionBindings({
      callSid, bindingId: "binding-1", tenantId: "tenant-1", spaceId: "space-1", agentId: "agent-1",
      caller: "+14155550100", called: "+14155550199", nonce: `nonce-${callSid}`, token: `ticket-${callSid}`,
      now: "2026-10-15T13:00:00.000Z", expiresAt: "2026-10-15T13:01:00.000Z", reserveCostMinor: 2,
      reserveDurationSeconds: 60, spaceMaxConcurrent: 1, numberMaxConcurrent: 1,
      hourStart: "2026-10-15T12:00:00.000Z", maxCallsPerHour: 10, dayStart: "2026-10-15T00:00:00.000Z",
      maxDailyMinutes: 1, monthStart: "2026-10-15T00:00:00.000Z", monthlySpendLimitMinor: 2,
    });
    expect(storage.sql.exec(CUSTOMER_VOICE_ADMISSION_SQL, ...values("CA" + "1".repeat(32))).rowsWritten).toBe(1);
    expect(storage.sql.exec(CUSTOMER_VOICE_ADMISSION_SQL, ...values("CA" + "2".repeat(32))).rowsWritten).toBe(0);
    expect(storage.sql.exec<{ call_sid: string; reserved_cost_minor: number }>("SELECT call_sid,reserved_cost_minor FROM customer_voice_call_admissions").toArray()).toEqual([{ call_sid: "CA" + "1".repeat(32), reserved_cost_minor: 2 }]);
    storage.sql.exec("UPDATE customer_voice_call_admissions SET status='completed',duration_seconds=60,actual_cost_minor=2 WHERE call_sid=?", "CA" + "1".repeat(32));
    expect(storage.sql.exec(CUSTOMER_VOICE_ADMISSION_SQL, ...values("CA" + "3".repeat(32))).rowsWritten).toBe(0);
  });
});
