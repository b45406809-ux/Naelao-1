import { describe, expect, it, vi } from "vitest";
import { searchTwilioLocalNumbers } from "./twilio-number-search.js";

const credentials = { accountSid: `AC${"a".repeat(32)}`, authToken: "a-secure-test-auth-token" };

describe("read-only Twilio number search", () => {
  it("requests at most 20 voice-enabled local results and returns only valid voice numbers", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/2010-04-01/Accounts/${credentials.accountSid}/AvailablePhoneNumbers/US/Local.json`);
      expect(url.searchParams.get("VoiceEnabled")).toBe("true");
      expect(url.searchParams.get("PageSize")).toBe("20");
      expect(url.searchParams.get("AreaCode")).toBe("415");
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /);
      expect(init?.redirect).toBe("error");
      return Response.json({ available_phone_numbers: [
        { phone_number: "+14155550100", locality: "San Francisco", region: "CA", capabilities: { voice: true, sms: true } },
        { phone_number: "+14155550101", capabilities: { voice: false } },
        { phone_number: "not-e164", capabilities: { voice: true } },
      ] });
    });
    await expect(searchTwilioLocalNumbers({ credentials, country: "us", areaCode: "415", fetcher })).resolves.toEqual({ ok: true, numbers: [
      { phone_number: "+14155550100", country_code: "US", locality: "San Francisco", region: "CA", capabilities: { voice: true, sms: true, mms: false } },
    ] });
  });

  it("validates country and area code before any provider request", async () => {
    const fetcher = vi.fn();
    await expect(searchTwilioLocalNumbers({ credentials, country: "../US", areaCode: "415", fetcher })).resolves.toMatchObject({ ok: false, error: "invalid_search_parameters" });
    await expect(searchTwilioLocalNumbers({ credentials, country: "US", areaCode: "415&VoiceEnabled=false", fetcher })).resolves.toMatchObject({ ok: false, error: "invalid_search_parameters" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps auth, availability, and malformed provider failures distinct without leaking response text", async () => {
    await expect(searchTwilioLocalNumbers({ credentials, country: "US", fetcher: async () => new Response("secret-error", { status: 401 }) })).resolves.toMatchObject({ ok: false, status: 409, error: "twilio_voice_credentials_rejected" });
    await expect(searchTwilioLocalNumbers({ credentials, country: "US", fetcher: async () => new Response("provider details", { status: 502 }) })).resolves.toMatchObject({ ok: false, status: 503, error: "twilio_number_search_unavailable" });
    await expect(searchTwilioLocalNumbers({ credentials, country: "US", fetcher: async () => new Response("not-json") })).resolves.toMatchObject({ ok: false, status: 502, error: "twilio_number_search_invalid_response" });
  });
});
