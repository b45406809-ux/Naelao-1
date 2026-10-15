import { afterEach, describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "../index.js";

const secret = "voice-purchase-test-platform-secret";
const tenantId = "tenant-1";
const spaceId = "space-1";
const userId = "owner-1";
const accountSid = `AC${"a".repeat(32)}`;
const authToken = "twilio-owner-secret";
const phoneNumber = "+14155550100";
const numberSid = `PN${"b".repeat(32)}`;

function harness(configJson = "{}") {
  const storage = createDOStorage();
  storage.sql.exec("CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT,status TEXT,config_json TEXT)");
  storage.sql.exec("CREATE TABLE org_members(org_id TEXT,user_id TEXT,role TEXT,PRIMARY KEY(org_id,user_id))");
  storage.sql.exec("INSERT INTO spaces(id,tenant_id,status,config_json) VALUES(?,?,'active',?)", spaceId, tenantId, configJson);
  storage.sql.exec("INSERT INTO org_members(org_id,user_id,role) VALUES(?,?,'owner')", tenantId, userId);
  for (const migration of ["0097_customer_voice_telephony.sql", "0101_customer_voice_purchase_quotes.sql"]) {
    storage.sql.exec(readFileSync(join(__dirname, "../../../../infra/migrations", migration), "utf8"));
  }
  const db = {
    prepare(sql: string) {
      return { bind(...values: unknown[]) {
        return {
          first: async <T>() => storage.sql.exec<T>(sql, ...values).toArray()[0] ?? null,
          all: async <T>() => ({ results: storage.sql.exec<T>(sql, ...values).toArray() }),
          run: async () => ({ meta: { changes: storage.sql.exec(sql, ...values).rowsWritten } }),
        };
      } };
    },
    batch: async (statements: Array<{ run(): Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())),
  };
  let credentialReads = 0;
  const credentialsWorker = { async fetch() { credentialReads++; return Response.json({ value: JSON.stringify({ accountSid, authToken }) }); } };
  return { storage, credentialReads: () => credentialReads, env: { PLATFORM_SECRET: secret, PLATFORM_DB: db, CREDENTIALS_WORKER: credentialsWorker, PUBLIC_AGENTS_URL: "https://agents.example.test" } as never };
}

function provider(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, monthly: () => string = () => "1.25", failPurchase = false) {
  fetcher.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("AvailablePhoneNumbers")) {
      return Response.json({ available_phone_numbers: [{ phone_number: phoneNumber, iso_country: "US", region: "CA", locality: "San Francisco", capabilities: { voice: true, sms: true } }] });
    }
    if (url.pathname === `/v2/Voice/Numbers/${encodeURIComponent(phoneNumber)}`) {
      return Response.json({ iso_country: "US", price_unit: "USD", inbound_call_price: { number_type: "local", current_price: "0.015" } });
    }
    if (url.pathname === "/v1/PhoneNumbers/Countries/US") {
      return Response.json({ iso_country: "US", price_unit: "USD", phone_number_prices: [{ number_type: "local", current_price: monthly() }] });
    }
    if (url.pathname.endsWith("/IncomingPhoneNumbers.json") && init?.method === "POST") {
      expect(new URLSearchParams(String(init.body)).get("PhoneNumber")).toBe(phoneNumber);
      if (failPurchase) throw new Error("connection reset after provider received request");
      return Response.json({ sid: numberSid, account_sid: accountSid, phone_number: phoneNumber, iso_country: "US", region: "CA", capabilities: { voice: true, sms: true } }, { status: 201 });
    }
    throw new Error(`unexpected_test_provider_request:${url.href}`);
  });
}

async function request(env: never, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-user-id": userId,
      "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, tenantId) },
    body: JSON.stringify(body),
  }, env);
}

afterEach(() => vi.unstubAllGlobals());

describe("explicit Twilio number purchase", () => {
  it("requires a short-lived quote and owner confirmation, binds the purchased number, and prevents quote replay", async () => {
    const test = harness();
    const fetcher = vi.fn<typeof fetch>(); provider(fetcher);
    vi.stubGlobal("fetch", fetcher);
    const quoteResponse = await request(test.env, `/spaces/${spaceId}/customer-voice/numbers/purchase/quote`, { phone_number: phoneNumber, country_code: "US" });
    expect(quoteResponse.status).toBe(200);
    const quote = await quoteResponse.json<{ quote_id: string; monthly_cost_minor: number; inbound_price_per_minute_minor: number }>();
    expect(quote).toMatchObject({ monthly_cost_minor: 125, inbound_price_per_minute_minor: 2 });
    expect(fetcher).toHaveBeenCalledTimes(3);

    const purchaseResponse = await request(test.env, `/spaces/${spaceId}/customer-voice/numbers/purchase`, {
      quote_id: quote.quote_id, confirm_monthly_cost_minor: quote.monthly_cost_minor, confirm_purchase: true, agent_id: "customer-agent-1", owner_prompt: "Use the approved FAQ.",
    });
    expect(purchaseResponse.status).toBe(201);
    expect(await purchaseResponse.json()).toMatchObject({ phone_number: phoneNumber, monthly_cost_minor: 125, status: "active" });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(test.storage.sql.exec<{ status: string }>("SELECT status FROM customer_voice_purchase_quotes WHERE id=?", quote.quote_id).toArray()).toEqual([{ status: "completed" }]);
    expect(test.storage.sql.exec<{ phone_number: string; agent_id: string }>("SELECT phone_number,agent_id FROM customer_voice_number_bindings").toArray()).toEqual([{ phone_number: phoneNumber, agent_id: "customer-agent-1" }]);

    const replay = await request(test.env, `/spaces/${spaceId}/customer-voice/numbers/purchase`, {
      quote_id: quote.quote_id, confirm_monthly_cost_minor: quote.monthly_cost_minor, confirm_purchase: true, agent_id: "customer-agent-1",
    });
    expect(replay.status).toBe(409);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("rejects a price change after the quote without purchasing", async () => {
    const test = harness();
    let current = "1.25";
    const fetcher = vi.fn<typeof fetch>(); provider(fetcher, () => current);
    vi.stubGlobal("fetch", fetcher);
    const quoteResponse = await request(test.env, `/spaces/${spaceId}/customer-voice/numbers/purchase/quote`, { phone_number: phoneNumber, country_code: "US" });
    const quote = await quoteResponse.json<{ quote_id: string; monthly_cost_minor: number }>();
    current = "2.00";
    const purchase = await request(test.env, `/spaces/${spaceId}/customer-voice/numbers/purchase`, {
      quote_id: quote.quote_id, confirm_monthly_cost_minor: quote.monthly_cost_minor, confirm_purchase: true, agent_id: "customer-agent-1",
    });
    expect(purchase.status).toBe(409);
    expect(await purchase.json()).toMatchObject({ error_code: "twilio_purchase_price_changed" });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("denies provider egress for an air-gapped Space before reading credentials or calling Twilio", async () => {
    const test = harness('{"compliance":{"airGappedOnly":true}}');
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
    const response = await request(test.env, `/spaces/${spaceId}/customer-voice/numbers/purchase/quote`, { phone_number: phoneNumber, country_code: "US" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "space_egress_denied" });
    expect(test.credentialReads()).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains an ambiguous provider result as a budget hold until the owner resolves it", async () => {
    const test = harness();
    const fetcher = vi.fn<typeof fetch>(); provider(fetcher, () => "1.25", true);
    vi.stubGlobal("fetch", fetcher);
    const quoteResponse = await request(test.env, `/spaces/${spaceId}/customer-voice/numbers/purchase/quote`, { phone_number: phoneNumber, country_code: "US" });
    const quote = await quoteResponse.json<{ quote_id: string; monthly_cost_minor: number }>();
    const purchase = await request(test.env, `/spaces/${spaceId}/customer-voice/numbers/purchase`, {
      quote_id: quote.quote_id, confirm_monthly_cost_minor: quote.monthly_cost_minor, confirm_purchase: true, agent_id: "customer-agent-1",
    });
    expect(purchase.status).toBe(502);
    expect(await purchase.json()).toMatchObject({ error_code: "twilio_purchase_status_unknown", quote_id: quote.quote_id });
    expect(test.storage.sql.exec<{ status: string }>("SELECT status FROM customer_voice_purchase_quotes WHERE id=?", quote.quote_id).toArray()).toEqual([{ status: "processing" }]);
    test.storage.sql.exec("UPDATE customer_voice_purchase_quotes SET created_at='2026-10-15T00:00:00.000Z' WHERE id=?", quote.quote_id);
    const resolved = await request(test.env, `/spaces/${spaceId}/customer-voice/numbers/purchase/quotes/${quote.quote_id}/resolve`, { resolution: "not_purchased", confirm_account_checked: true });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ resolved: true, status: "failed" });
    expect(test.storage.sql.exec<{ status: string }>("SELECT status FROM customer_voice_purchase_quotes WHERE id=?", quote.quote_id).toArray()).toEqual([{ status: "failed" }]);
  });
});
