import { describe, expect, it } from "vitest";
import { createInbox, createWebhook, fakeFetch, fixture, publicDoh, seedTenant, sendMail } from "./test-helpers.js";
import { dispatchDue } from "./dispatch.js";
import { DOH_ENDPOINT, resolveDestination } from "./ssrf.js";

const HOOK = "https://hooks.partner.example/naelao";
const T0 = Date.parse("2026-11-26T12:00:00.000Z");

describe("MS-48 webhook destination DoH guard", () => {
  it("classifies DoH answers: public, private (A or AAAA), unusable", async () => {
    expect(await resolveDestination("hooks.partner.example", publicDoh({ A: ["93.184.216.34"], AAAA: ["2606:2800:220:1::1"] }))).toBe("public");
    expect(await resolveDestination("hooks.partner.example", publicDoh({ A: ["93.184.216.34", "10.0.0.7"] }))).toBe("private");
    expect(await resolveDestination("hooks.partner.example", publicDoh({ A: ["93.184.216.34"], AAAA: ["fd00::1"] }))).toBe("private");
    expect(await resolveDestination("hooks.partner.example", publicDoh({ A: ["169.254.169.254"] }))).toBe("private");
    expect(await resolveDestination("hooks.partner.example", publicDoh({ fail: true }))).toBe("unknown");
    expect(await resolveDestination("nothing.example", publicDoh({}))).toBe("unknown");
    expect(await resolveDestination("localhost", publicDoh())).toBe("private"); // literal rules still apply, no lookup
  });

  it("queries only the injected DoH endpoint with the hostname", async () => {
    const urls: string[] = [];
    const doh = (async (input: RequestInfo | URL) => { urls.push(String(input)); return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }); }) as typeof fetch;
    expect(await resolveDestination("Hooks.Partner.example.", doh)).toBe("public"); // an empty AAAA answer is a valid result
    expect(urls.sort()).toEqual([`${DOH_ENDPOINT}?name=hooks.partner.example&type=A`, `${DOH_ENDPOINT}?name=hooks.partner.example&type=AAAA`]);
  });

  it("refuses to create a webhook whose public-looking name resolves privately", async () => {
    const f = fixture({ DOH_FETCH: publicDoh({ A: ["10.1.2.3"] }) });
    const key = await seedTenant(f, "t1");
    const res = await createWebhook(f, key, HOOK, ["email.message.received"]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_code: string }).error_code).toBe("invalid_webhook_url");
    expect(f.db.prepare("SELECT count(*) AS n FROM nemail_webhooks").get()).toEqual({ n: 0 });
  });

  it("fails closed with 503 on create when the DoH lookup is unavailable", async () => {
    const f = fixture({ DOH_FETCH: publicDoh({ fail: true }) });
    const key = await seedTenant(f, "t1");
    const res = await createWebhook(f, key, HOOK, ["email.message.received"]);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error_code: string }).error_code).toBe("destination_unverifiable");
  });

  async function deliveryFixture(doh: typeof fetch) {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const inbox = await createInbox(f, key, "bot");
    expect((await createWebhook(f, key, HOOK, ["email.delivery.sent"])).status).toBe(201);
    await sendMail(f, key, inbox, { to: ["bob@example.com"], subject: "Hi", text: "body" });
    f.env.DOH_FETCH = doh; // DNS changes after creation (rebinding)
    return f;
  }
  const row = (f: Awaited<ReturnType<typeof deliveryFixture>>) => f.db.prepare("SELECT status, attempts, last_error FROM nemail_webhook_deliveries").get();

  it("dead-letters without a POST when the name now resolves to a private address", async () => {
    const f = await deliveryFixture(publicDoh({ A: ["127.0.0.1"] }));
    const fake = fakeFetch();
    await dispatchDue(f.env, { now: new Date(T0), fetchImpl: fake.impl });
    expect(fake.calls).toHaveLength(0);
    expect(row(f)).toMatchObject({ status: "dead_letter", last_error: "destination_refused" });
  });

  it("does not POST and retries when the DoH lookup is unavailable", async () => {
    const f = await deliveryFixture(publicDoh({ fail: true }));
    const fake = fakeFetch();
    await dispatchDue(f.env, { now: new Date(T0), fetchImpl: fake.impl });
    expect(fake.calls).toHaveLength(0);
    expect(row(f)).toMatchObject({ status: "pending", attempts: 1, last_error: "dns_unavailable" });
  });

  it("delivers when the name resolves publicly", async () => {
    const f = await deliveryFixture(publicDoh());
    const fake = fakeFetch();
    await dispatchDue(f.env, { now: new Date(T0), fetchImpl: fake.impl });
    expect(fake.calls).toHaveLength(1);
    expect(row(f)).toMatchObject({ status: "delivered" });
  });
});
