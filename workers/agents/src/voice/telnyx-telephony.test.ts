import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authenticatedTelnyxEvent, TelnyxTelephony, verifyTelnyxWebhook } from "./telnyx-telephony.js";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
const rawBody = JSON.stringify({ data: { id: "event-1", event_type: "call.initiated", occurred_at: "2026-10-26T12:00:00Z", payload: { call_control_id: "v3:call-1" } } });
function signed(body = rawBody, timestamp = "1000") {
  return { publicKey, rawBody: body, timestamp, nowSeconds: 1000, signature: sign(null, Buffer.from(`${timestamp}|${body}`), keys.privateKey).toString("base64") };
}
describe("Telnyx transport boundary", () => {
  it("authenticates exact bytes and rejects forged, expired and future events", async () => {
    await expect(authenticatedTelnyxEvent(signed())).resolves.toMatchObject({ provider: "telnyx", eventId: "event-1", eventType: "call.initiated" });
    for (const input of [{ ...signed(), rawBody: rawBody + " " }, signed(rawBody, "699"), signed(rawBody, "1301"), { ...signed(), publicKey: "invalid" }, { ...signed(), signature: null }]) {
      await expect(verifyTelnyxWebhook(input)).resolves.toBe(false);
    }
  });
  it("rejects signed malformed events before dispatch", async () => {
    await expect(authenticatedTelnyxEvent(signed('{"data":null}'))).rejects.toThrow("telnyx_webhook_invalid");
  });
  it("preserves command identity and never retries an uncertain mutation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection lost"));
    const client = new TelnyxTelephony({ apiKey: "test-api-key-123456", publicKey }, fetcher);
    await expect(client.callAction("v3:call-1", "answer", "command-1")).rejects.toMatchObject({ uncertain: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.telnyx.com/v2/calls/v3%3Acall-1/actions/answer");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ command_id: "command-1" });
  });
  it("treats a successful response with a missing receipt as uncertain", async () => {
    const client = new TelnyxTelephony({ apiKey: "test-api-key-123456", publicKey }, vi.fn<typeof fetch>().mockResolvedValue(Response.json({})));
    await expect(client.sendSms("+14155550100", "+14155550101", "hello", "profile-1")).rejects.toMatchObject({ uncertain: true });
  });
  it("searches the documented account inventory and returns only voice/SMS matches with bounded USD cost", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [
      { phone_number: "+14155550123", phone_number_type: "local", features: [{ name: "voice" }, { name: "sms" }],
        region_information: [{ region_type: "location", region_name: "San Francisco" }, { region_type: "state", region_name: "CA" }],
        cost_information: { upfront_cost: "1.25", monthly_cost: "2.00", currency: "USD" } },
      { phone_number: "+14155550124", features: [{ name: "voice" }], cost_information: { upfront_cost: "0", monthly_cost: "1", currency: "USD" } },
      { phone_number: "+14155550125", features: [{ name: "voice" }, { name: "sms" }], cost_information: { upfront_cost: "0", monthly_cost: "1.001", currency: "USD" } },
    ] }));
    const client = new TelnyxTelephony({ apiKey: "test-api-key-123456", publicKey }, fetcher);
    await expect(client.searchAvailablePhoneNumbers({ countryCode: "us", numberType: "local", startsWith: "14155550123", limit: 5 }))
      .resolves.toEqual([{ phoneNumber: "+14155550123", countryCode: "US", numberType: "local", features: ["voice", "sms"],
        locality: "San Francisco", region: "CA", upfrontCostMinor: 125, monthlyCostMinor: 200, currency: "USD" }]);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/v2/available_phone_numbers?");
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("filter%5Bcountry_code%5D=US");
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("filter%5Bphone_number%5D%5Bstarts_with%5D=14155550123");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
  });
  it("creates one number order with a stable customer reference and lists it without replaying a mutation", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: { id: "123e4567-e89b-12d3-a456-426614174000", status: "pending", customer_reference: "naelao_order_1" } }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "123e4567-e89b-12d3-a456-426614174000", status: "pending", customer_reference: "naelao_order_1" }] }));
    const client = new TelnyxTelephony({ apiKey: "test-api-key-123456", publicKey }, fetcher);
    await expect(client.createNumberOrder({ phoneNumber: "+14155550123", customerReference: "naelao_order_1", connectionId: "connection-1", messagingProfileId: "profile-1" }))
      .resolves.toMatchObject({ status: "pending", customer_reference: "naelao_order_1" });
    await expect(client.listNumberOrders("naelao_order_1")).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.telnyx.com/v2/number_orders");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      phone_numbers: [{ phone_number: "+14155550123" }], customer_reference: "naelao_order_1",
      connection_id: "connection-1", messaging_profile_id: "profile-1",
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.telnyx.com/v2/number_orders?filter%5Bcustomer_reference%5D=naelao_order_1");
  });
  it("rejects resource injection without contacting the provider", () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new TelnyxTelephony({ apiKey: "test-api-key-123456", publicKey }, fetcher);
    expect(() => client.callAction("../other", "answer", "command-1")).toThrow();
    expect(() => client.inspectMessage("../../credentials")).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
