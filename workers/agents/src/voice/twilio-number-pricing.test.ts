import { describe, expect, it, vi } from "vitest";
import { fetchTwilioLocalMonthlyPrice, fetchTwilioNumberPrice, TwilioNumberPriceError } from "./twilio-number-pricing.js";

const credentials = { accountSid: "AC" + "a".repeat(32), authToken: "secret" };
const countryPrice = (overrides: Record<string, unknown> = {}) => Response.json({
  iso_country: "US", price_unit: "USD", phone_number_prices: [
    { number_type: "local", base_price: "2.00", current_price: "1.25" },
    { number_type: "toll free", base_price: "5.00", current_price: "4.00" },
  ], ...overrides,
});

describe("Twilio phone number pricing", () => {
  it("returns the account's current monthly local rate and labels its quote time", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(countryPrice());
    const result = await fetchTwilioLocalMonthlyPrice({ credentials, country: "us", fetcher });
    expect(result).toMatchObject({ monthlyCostMinor: 125, currency: "USD", numberType: "local" });
    expect(result.quotedAt).toMatch(/^\d{4}-/);
    expect(fetcher).toHaveBeenCalledWith("https://pricing.twilio.com/v1/PhoneNumbers/Countries/US", expect.objectContaining({ redirect: "error" }));
  });

  it("resolves an owned number's provider-declared type before reading its monthly rate", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ country: "United States", iso_country: "US", price_unit: "USD", inbound_call_price: { number_type: "toll-free", current_price: "0.027" } }))
      .mockResolvedValueOnce(countryPrice());
    const result = await fetchTwilioNumberPrice({ credentials, phoneNumber: "+18005551234", country: "US", fetcher });
    expect(result).toMatchObject({ numberType: "toll free", monthlyCostMinor: 400, inboundPricePerMinuteMinor: 3, currency: "USD" });
    expect(fetcher.mock.calls[0]![0]).toContain("%2B18005551234");
  });

  it("fails closed when the current country tariff does not include the provider's number type", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ price_unit: "USD", inbound_call_price: { number_type: "mobile", current_price: "0.02" } }))
      .mockResolvedValueOnce(countryPrice({ phone_number_prices: [{ number_type: "local", current_price: "1.00" }] }));
    await expect(fetchTwilioNumberPrice({ credentials, phoneNumber: "+15551234567", country: "US", fetcher })).rejects.toMatchObject({ code: "twilio_number_price_invalid" });
  });

  it("rejects non-USD, malformed, oversized, and unavailable provider pricing", async () => {
    await expect(fetchTwilioLocalMonthlyPrice({ credentials, country: "US", fetcher: vi.fn<typeof fetch>().mockResolvedValue(countryPrice({ price_unit: "EUR" })) })).rejects.toMatchObject({ code: "twilio_number_price_currency_unsupported" });
    await expect(fetchTwilioLocalMonthlyPrice({ credentials, country: "US", fetcher: vi.fn<typeof fetch>().mockResolvedValue(countryPrice({ phone_number_prices: [{ number_type: "local", current_price: "NaN" }] })) })).rejects.toBeInstanceOf(TwilioNumberPriceError);
    await expect(fetchTwilioLocalMonthlyPrice({ credentials, country: "US", fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(64 * 1024 + 1))) })).rejects.toMatchObject({ code: "twilio_number_pricing_unavailable" });
    await expect(fetchTwilioLocalMonthlyPrice({ credentials, country: "US", fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")) })).rejects.toBeTruthy();
  });
});
