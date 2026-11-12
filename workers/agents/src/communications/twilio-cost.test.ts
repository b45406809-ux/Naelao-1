import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentsEnv } from "../index.js";
import { observeTwilioSmsCost } from "./twilio-cost.js";
import { phoneProvider } from "./phone-provider.js";
import { recordProviderApiCostObservation } from "./managed-service-cost-observations.js";
import type { CommunicationIdentity } from "./core.js";
import type { AssistantPhoneBinding } from "./phones.js";

vi.mock("./phone-provider.js", () => ({ phoneProvider: vi.fn() }));
vi.mock("./managed-service-cost-observations.js", () => ({ recordProviderApiCostObservation: vi.fn() }));

const phoneProviderMock = vi.mocked(phoneProvider);
const recordCostMock = vi.mocked(recordProviderApiCostObservation);
const sid = `SM${"a".repeat(32)}`;
const credentials = { accountSid: `AC${"b".repeat(32)}`, authToken: "t".repeat(32) };
const identity = { tenant_id: "tenant_1", space_id: "space_1", project_id: "project_1" } as CommunicationIdentity;
const binding = { id: "binding_1", provider: "twilio", payer: "byo", status: "active",
  provider_account_sid: credentials.accountSid, phone_number: "+15550000001" } as AssistantPhoneBinding;

function env(action = { id: "action_1", kind: "sms", recipient: "+15550000002", status: "sent", provider_sid: sid }) {
  const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue(action) })) }));
  return { PLATFORM_DB: { prepare } } as unknown as AgentsEnv;
}

describe("Twilio SMS cost observation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordCostMock.mockResolvedValue({ inserted: true, replayed: false, provenance: "provider_api_observed", providerCostMicros: 7500, currency: "USD" });
  });

  it("stores only an exact finalized outbound message's billed amount", async () => {
    phoneProviderMock.mockResolvedValue({ account_sid: credentials.accountSid, sid, from: binding.phone_number,
      to: "+15550000002", direction: "outbound-api", status: "delivered", price: "-0.00750", price_unit: "usd",
      date_sent: "2026-11-11T12:00:00Z" });
    await expect(observeTwilioSmsCost(env(), identity, binding, credentials, "action_1"))
      .resolves.toEqual({ status: "observed", amount: "0.00750", currency: "USD", provenance: "provider_api_observed" });
    expect(phoneProviderMock).toHaveBeenCalledWith(credentials, `Messages/${sid}.json`);
    expect(recordCostMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: "twilio", operationRef: sid, accountRef: credentials.accountSid,
      providerCost: "0.00750", currency: "USD", sourceApi: "twilio.messages.get",
    }));
  });

  it("rejects receipts from another account or action", async () => {
    phoneProviderMock.mockResolvedValue({ account_sid: "AC" + "c".repeat(32), sid, from: binding.phone_number,
      to: "+15550000002", direction: "outbound-api", status: "delivered", price: "0.01", price_unit: "USD",
      date_sent: "2026-11-11T12:00:00Z" });
    await expect(observeTwilioSmsCost(env(), identity, binding, credentials, "action_1"))
      .rejects.toThrow("twilio_cost_receipt_mismatch");
    expect(recordCostMock).not.toHaveBeenCalled();
    await expect(observeTwilioSmsCost(env({ id: "a", kind: "sms", recipient: "+15550000002", status: "indeterminate", provider_sid: sid }),
      identity, binding, credentials, "action_1")).rejects.toThrow("twilio_cost_action_unavailable");
  });

  it("waits until a final provider price is available", async () => {
    phoneProviderMock.mockResolvedValue({ account_sid: credentials.accountSid, sid, from: binding.phone_number,
      to: "+15550000002", direction: "outbound-api", status: "sent", price: null, price_unit: null,
      date_sent: "2026-11-11T12:00:00Z" });
    await expect(observeTwilioSmsCost(env(), identity, binding, credentials, "action_1"))
      .resolves.toEqual({ status: "pending" });
    expect(recordCostMock).not.toHaveBeenCalled();
  });

  it("records the exact outbound call price and duration as a voice observation", async () => {
    const callSid = `CA${"c".repeat(32)}`;
    phoneProviderMock.mockResolvedValue({ account_sid: credentials.accountSid, sid: callSid, from: binding.phone_number,
      to: "+15550000002", direction: "outbound-api", status: "completed", price: "-0.03000", price_unit: "USD",
      start_time: "2026-11-11T12:00:00Z", duration: "180" });
    await expect(observeTwilioSmsCost(env({ id: "action_2", kind: "call", recipient: "+15550000002", status: "sent", provider_sid: callSid }), identity, binding, credentials, "action_2"))
      .resolves.toEqual({ status: "observed", amount: "0.03000", currency: "USD", provenance: "provider_api_observed" });
    expect(recordCostMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      usageKind: "voice", quantityUnit: "second", quantityMicros: 180_000_000,
      sourceApi: "twilio.calls.get", providerCost: "0.03000",
    }));
  });
});
