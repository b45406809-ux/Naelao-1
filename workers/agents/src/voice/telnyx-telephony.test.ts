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
  it("rejects resource injection without contacting the provider", () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new TelnyxTelephony({ apiKey: "test-api-key-123456", publicKey }, fetcher);
    expect(() => client.callAction("../other", "answer", "command-1")).toThrow();
    expect(() => client.inspectMessage("../../credentials")).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
