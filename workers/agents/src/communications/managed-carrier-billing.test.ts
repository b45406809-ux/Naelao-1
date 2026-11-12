import { describe, expect, it, vi } from "vitest";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity } from "./core.js";
import { defaultPhonePolicy, type AssistantPhoneBinding } from "./phones.js";
import { billManagedTelnyxRental, sweepManagedTelnyxCallReservations } from "./managed-carrier-billing.js";

describe("managed Telnyx rental price persistence", () => {
  it("bills and replays a rental using its accepted version after runtime repricing", async () => {
    const f = fixture(), identity = await ensureIdentity(f.env, scope);
    const billingBodies: Record<string, unknown>[] = [];
    f.env.BILLING_WORKER = { fetch: vi.fn(async (request: Request) => {
      const body = await request.json() as Record<string, unknown>;
      billingBodies.push(body);
      return Response.json(new URL(request.url).pathname.endsWith("/reserve")
        ? { reserved: true } : { settled: true });
    }) } as unknown as Fetcher;
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,
      phone_number,capabilities_json,previous_callbacks_json,policy_json,status,managed_price_version,managed_rental_credits_per_month,
      managed_sms_credits_per_segment,managed_call_credits_per_minute)
      VALUES('managed-rental-binding',?,'assistant','managed','telnyx','managed-account','12345','+14155550100','{"sms":true,"voice":true}','{}',?,'active','retail-v1',100,7,11)`)
      .bind(identity.id, JSON.stringify(defaultPhonePolicy)).run();
    const binding = (await f.db.prepare("SELECT * FROM assistant_phone_bindings WHERE id='managed-rental-binding'").first<AssistantPhoneBinding>())!;
    f.env.TELNYX_MANAGED_PRICE_VERSION = "retail-v2";
    f.env.TELNYX_MANAGED_RENTAL_CREDITS_PER_MONTH = "9000";
    const now = Math.floor(Date.UTC(2026, 10, 12, 12) / 1000);

    await expect(billManagedTelnyxRental(f.env, binding, identity, now)).resolves.toMatchObject({
      billed: true, credits: 100, period: "2026-11",
    });
    expect(await f.db.prepare("SELECT credits,price_version,status FROM assistant_managed_phone_rentals WHERE binding_id='managed-rental-binding'").first())
      .toEqual({ credits: 100, price_version: "retail-v1", status: "paid" });
    expect(billingBodies).toHaveLength(2);
    expect(billingBodies[0]).toMatchObject({ credits: 100, budget_key: "managed-phone:managed-rental-binding:retail-v1" });

    await expect(billManagedTelnyxRental(f.env, binding, identity, now)).resolves.toMatchObject({
      billed: true, deduplicated: true, credits: 100,
    });
    expect(billingBodies).toHaveLength(2);
  });

  it("releases expired one-time call holds and retries a lost Billing release", async () => {
    const f = fixture(), identity = await ensureIdentity(f.env, scope);
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,
      phone_number,capabilities_json,previous_callbacks_json,policy_json,status,managed_price_version,managed_rental_credits_per_month,
      managed_sms_credits_per_segment,managed_call_credits_per_minute)
      VALUES('managed-call-release-binding',?,'assistant','managed','telnyx','managed-account','12345','+14155550100','{"sms":true,"voice":true}','{}',?,'active','retail-v1',100,7,11)`)
      .bind(identity.id, JSON.stringify(defaultPhonePolicy)).run();
    const now = 1_800_000_000;
    await f.db.prepare(`INSERT INTO assistant_live_calls(id,binding_id,tenant_id,space_id,project_id,user_id,caller_role,session_id,code_hash,
      call_sid,status,expires_at,created_at,reserved_credits,managed_price_version,managed_reservation_status)
      VALUES('expired-code','managed-call-release-binding','tenant','space',NULL,'user','product_end_user','session','hash',
      NULL,'armed',?, ?,55,'retail-v1','held')`).bind(now - 1, now - 200).run();
    await f.db.prepare(`INSERT INTO assistant_live_calls(id,binding_id,tenant_id,space_id,project_id,user_id,caller_role,session_id,code_hash,
      call_sid,status,expires_at,created_at,reserved_credits,managed_price_version,managed_reservation_status)
      VALUES('connected-call','managed-call-release-binding','tenant','space',NULL,'user','product_end_user','session','hash-connected',
      'CA00000000000000000000000000000000','revoked',?, ?,55,'retail-v1','held')`).bind(now + 100, now - 200).run();
    let failRelease = true;
    const billingBodies: Record<string, unknown>[] = [];
    f.env.BILLING_WORKER = { fetch: vi.fn(async (request: Request) => {
      billingBodies.push(await request.json() as Record<string, unknown>);
      return failRelease ? Response.json({ error_code: "billing_unavailable" }, { status: 503 }) : Response.json({ released: false });
    }) } as unknown as Fetcher;

    await expect(sweepManagedTelnyxCallReservations(f.env, now)).resolves.toMatchObject({ checked: 1, released: 0, held: 1 });
    expect(await f.db.prepare("SELECT status,managed_reservation_status,managed_reservation_attempts FROM assistant_live_calls WHERE id='expired-code'").first())
      .toEqual({ status: "revoked", managed_reservation_status: "release_pending", managed_reservation_attempts: 1 });
    expect(await f.db.prepare("SELECT managed_reservation_status FROM assistant_live_calls WHERE id='connected-call'").first())
      .toEqual({ managed_reservation_status: "held" });

    failRelease = false;
    await expect(sweepManagedTelnyxCallReservations(f.env, now + 1)).resolves.toMatchObject({ checked: 1, released: 1, held: 0 });
    expect(await f.db.prepare("SELECT managed_reservation_status,managed_reservation_last_error FROM assistant_live_calls WHERE id='expired-code'").first())
      .toEqual({ managed_reservation_status: "released", managed_reservation_last_error: null });
    expect(billingBodies).toEqual([{ reservation_id: "expired-code" }, { reservation_id: "expired-code" }]);
  });
});
