import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import type { AgentsEnv } from "../index.js";
import {
  fixture,
  scope,
} from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity, readBody } from "./core.js";
import {
  handlePhoneAction,
  defaultPhonePolicy,
  validatePhonePolicy,
} from "./phones.js";
import { phoneProvider, PhoneProviderError } from "./phone-provider.js";
import { registerPhoneWebhooks } from "./phone-webhooks.js";
import { registerCommunicationRoutes } from "./routes.js";
import { detachAssistantPhonesForErasure } from "./phone-lifecycle.js";
const account = "AC" + "a".repeat(32),
  token = "b".repeat(32),
  pn = "PN" + "c".repeat(32),
  number = "+14155550100",
  other = "+14155550101";
const creds = { accountSid: account, authToken: token };
async function phoneFixture() {
  const f = fixture();
  f.env.PUBLIC_AGENTS_URL = "https://phone.example.com";
  f.fetch.mockImplementation(async (r: Request) =>
    r.url.includes("assistant-access")
      ? Response.json({
          effective_role: r.url.includes("other") ? "editor" : "owner",
        })
      : Response.json({
          preferences: { enabled: { email: true, phone: true } },
        })
  );
  f.env.CREDENTIALS_WORKER = {
    fetch: vi.fn(async () => Response.json({ value: JSON.stringify(creds) })),
  } as unknown as Fetcher;
  const identity = await ensureIdentity(f.env, scope);
  const provider = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({
          sid: pn,
          account_sid: account,
          phone_number: number,
          capabilities: { voice: true, sms: true, mms: true },
          voice_url: "https://old.example.com/voice",
          sms_url: "https://old.example.com/sms",
          voice_method: "POST",
          sms_method: "POST",
        })
  );
  vi.stubGlobal("fetch", provider);
  const act = (
    action: string,
    body: Record<string, unknown> = {},
    manager = true,
    agent = false
  ) => handlePhoneAction(f.env, scope, identity, action, body, manager, agent);
  await act("phone-import", { number_sid: pn, confirm: true });
  const binding = (await f.db
    .prepare("SELECT * FROM assistant_phone_bindings")
    .first<{ id: string }>())!;
  return { ...f, identity, provider, act, binding };
}
afterEach(() => vi.unstubAllGlobals());
describe("assistant telephone safety and lifecycle", () => {
  it("keeps numbers optional and rejects invalid limits and transfer addresses", () => {
    expect(defaultPhonePolicy.voicemail).toBe(false);
    for (const patch of [
      { maxCallSeconds: 0 },
      { maxDailyActions: 0 },
      { maxDailyInboundMessages: 1001 },
      { transferTo: "http://evil" },
      { voicemail: "yes" },
    ])
      expect(() =>
        validatePhonePolicy({ ...defaultPhonePolicy, ...patch })
      ).toThrow("invalid_phone_policy");
  });
  it("separates a provider failure from an unknown mutation and bounds responses", async () => {
    const fail = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(
      phoneProvider(creds, "Messages.json", "POST", new URLSearchParams(), fail)
    ).rejects.toMatchObject({ uncertain: true });
    await expect(
      phoneProvider(creds, "Messages.json", "GET", undefined, fail)
    ).rejects.toMatchObject({ uncertain: false });
    await expect(
      phoneProvider(
        creds,
        "Messages.json",
        "POST",
        new URLSearchParams(),
        async () => new Response("bad", { status: 400 })
      )
    ).rejects.toMatchObject({ uncertain: false });
    await expect(
      phoneProvider(
        creds,
        "Messages.json",
        "POST",
        new URLSearchParams(),
        async () => new Response("bad", { status: 503 })
      )
    ).rejects.toMatchObject({ uncertain: true });
    await expect(
      phoneProvider(
        creds,
        "Messages.json",
        "POST",
        new URLSearchParams(),
        async () => new Response("x".repeat(70000))
      )
    ).rejects.toMatchObject({ uncertain: true });
    await expect(
      phoneProvider(creds, "https://evil.example/", "GET")
    ).rejects.toThrow("invalid_phone_resource");
  });
  it("requires human approval and deduplicates concurrent sends", async () => {
    const f = await phoneFixture();
    const draft = (await f.act("phone-draft", {
      kind: "sms",
      to: other,
      text: "hello",
    })) as { id: string };
    await expect(
      f.act("phone-send", { id: draft.id }, true, true)
    ).rejects.toThrow("approval_required");
    await expect(
      f.act("phone-approve", { id: draft.id }, true, true)
    ).rejects.toThrow("human_control_required");
    await f.act("phone-approve", { id: draft.id });
    f.provider.mockImplementation(async () =>
      Response.json({ sid: "SM" + "d".repeat(32), account_sid: account })
    );
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        f.act("phone-send", { id: draft.id }, false, true)
      )
    );
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(f.provider).toHaveBeenCalledTimes(3); // import read + attach + one send
    await f.act("phone-send", { id: draft.id }, false, true);
    expect(f.provider).toHaveBeenCalledTimes(3);
    expect([...f.objects.values()].join("")).not.toContain("hello");
  });
  it("holds uncertain actions and requires carrier reconciliation before another attempt", async () => {
    const f = await phoneFixture(),
      draft = (await f.act("phone-draft", {
        kind: "call",
        to: other,
        text: "test",
      })) as { id: string };
    await f.act("phone-approve", { id: draft.id });
    f.provider.mockRejectedValue(new Error("timeout"));
    await expect(f.act("phone-send", { id: draft.id })).rejects.toBeInstanceOf(
      PhoneProviderError
    );
    await expect(f.act("phone-send", { id: draft.id })).rejects.toThrow(
      "approval_required"
    );
    expect(
      (await f.db
        .prepare("SELECT status FROM assistant_phone_actions WHERE id=?")
        .bind(draft.id)
        .first<{ status: string }>())!.status
    ).toBe("indeterminate");
    await f.act("phone-reconcile", {
      id: draft.id,
      provider_checked: true,
      outcome: "not_sent",
    });
    await expect(f.act("phone-send", { id: draft.id })).rejects.toThrow(
      "approval_required"
    );
  });
  it("restores callbacks before detaching, keeps billing visible, permits reattach with old history", async () => {
    const f = await phoneFixture();
    await f.act("phone-draft", {
      kind: "sms",
      to: other,
      text: "retained history",
    });
    const detached = await f.act("phone-detach", { confirm: true });
    expect(detached).toMatchObject({
      status: "detached",
      rental_continues: true,
    });
    const form = f.provider.mock.calls.at(-1)![1]!.body as URLSearchParams;
    expect(form.get("VoiceUrl")).toBe("https://old.example.com/voice");
    await f.act("phone-import", { number_sid: pn, confirm: true });
    expect(
      (await f.db
        .prepare("SELECT COUNT(*) n FROM assistant_phone_bindings")
        .first<{ n: number }>())!.n
    ).toBe(2);
  });
  it("deletes phone references only after provider detachment on account erasure", async () => {
    const f = await phoneFixture();
    await f.act("phone-draft", { kind: "sms", to: other, text: "to erase" });
    await detachAssistantPhonesForErasure(f.env, f.identity.id);
    expect(
      (await f.db
        .prepare("SELECT COUNT(*) n FROM assistant_phone_bindings")
        .first<{ n: number }>())!.n
    ).toBe(0);
    expect(f.provider.mock.calls.at(-1)![1]!.method).toBe("POST"); // never release BYO on erase
  });
  it("rejects other assistant scopes and GET mutations through the authenticated route", async () => {
    const f = await phoneFixture(),
      app = new Hono<{ Bindings: AgentsEnv }>();
    registerCommunicationRoutes(app);
    const headers = {
      "x-naelao-tenant-id": "tenant",
      "x-naelao-user-id": "user",
      "x-naelao-role": "product_end_user",
      "x-naelao-internal-token": await mintInternalToken("secret", "tenant"),
    };
    expect(
      (
        await app.request(
          "/spaces/space/assistant-communications?action=phone-send&id=x",
          { headers },
          f.env
        )
      ).status
    ).toBe(405);
    const r = await app.request(
      "/internal/assistant-communications",
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          spaceId: "space",
          action: "phone-policy",
          policy: defaultPhonePolicy,
        }),
      },
      f.env
    );
    expect(r.status).toBe(403);
    const stranger = await app.request(
      "/spaces/space/assistant-communications?action=phone-status",
      { headers: { ...headers, "x-naelao-user-id": "other" } },
      f.env
    );
    expect(((await stranger.json()) as { phone: unknown }).phone).toBeNull();
  });
  it("fails closed when channel, membership or egress policy changes", async () => {
    const f = await phoneFixture(),
      draft = (await f.act("phone-draft", {
        kind: "sms",
        to: other,
        text: "test",
      })) as { id: string };
    await f.act("phone-approve", { id: draft.id });
    f.fetch.mockResolvedValue(
      Response.json({ preferences: { enabled: { phone: false } } })
    );
    await expect(f.act("phone-send", { id: draft.id })).rejects.toThrow(
      "disabled_or_forbidden"
    );
    expect(f.provider).toHaveBeenCalledTimes(2);
  });
  it("authenticates callbacks, bounds ingress, deduplicates SMS, never trusts caller ID as owner authority", async () => {
    const f = await phoneFixture(),
      app = new Hono<{ Bindings: AgentsEnv }>();
    registerPhoneWebhooks(app);
    await f.db
      .prepare(
        "INSERT INTO assistant_communication_controllers(identity_id,user_id,channel,address,verified_at) VALUES(?,'user','phone',?,datetime('now'))"
      )
      .bind(f.identity.id, other)
      .run();
    const sid = "SM" + "e".repeat(32),
      path = `/assistant-phone/twilio/${f.binding.id}/sms`;
    const params = {
      AccountSid: account,
      MessageSid: sid,
      From: other,
      To: number,
      Body: "owner task",
      NumMedia: "0",
    };
    const body = new URLSearchParams(params).toString(),
      signature = getExpectedTwilioSignature(
        token,
        "https://phone.example.com" + path,
        params
      );
    const invoke = (sig = signature) =>
      app.request(
        path,
        {
          method: "POST",
          headers: {
            "x-twilio-signature": sig,
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        },
        f.env
      );
    expect((await invoke("wrong")).status).toBe(403);
    await Promise.all(Array.from({ length: 20 }, () => invoke()));
    expect(
      (await f.db
        .prepare("SELECT COUNT(*) n FROM assistant_phone_events")
        .first<{ n: number }>())!.n
    ).toBe(1);
    expect(
      (await f.db
        .prepare("SELECT COUNT(*) n FROM assistant_communication_commands")
        .first<{ n: number }>())!.n
    ).toBe(1);
    expect(f.env.AGENTS_WORKER.fetch).not.toHaveBeenCalled();
    const event = await f.db
      .prepare("SELECT body_key FROM assistant_phone_events WHERE id=?")
      .bind(sid)
      .first<{ body_key: string }>();
    expect(
      await readBody(f.env, f.identity, sid, event!.body_key)
    ).toMatchObject({ text: "owner task", untrusted: true });
  });
  it("only buys a number after an exact current quote is confirmed, under racing requests", async () => {
    const f = await phoneFixture();
    await f.act("phone-detach", { confirm: true });
    f.provider.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("AvailablePhoneNumbers"))
        return Response.json({
          available_phone_numbers: [
            {
              phone_number: number,
              capabilities: { voice: true, sms: true, mms: true },
            },
          ],
        });
      if (u.includes("/v2/Voice/Numbers/"))
        return Response.json({
          price_unit: "USD",
          inbound_call_price: { number_type: "local", current_price: "0.0085" },
        });
      if (u.includes("/v1/PhoneNumbers/"))
        return Response.json({
          price_unit: "USD",
          phone_number_prices: [
            { number_type: "local", current_price: "1.15" },
          ],
        });
      return Response.json({
        sid: pn,
        account_sid: account,
        phone_number: number,
        capabilities: { voice: true, sms: true, mms: true },
      });
    });
    const q = (await f.act("phone-quote", {
      phone_number: number,
      country: "US",
    })) as { quote_id: string; monthly_cost_minor: number };
    await expect(
      f.act("phone-purchase", {
        quote_id: q.quote_id,
        confirm: true,
        confirm_monthly_cost_minor: q.monthly_cost_minor + 1,
      })
    ).rejects.toThrow("price_not_confirmed");
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        f.act("phone-purchase", {
          quote_id: q.quote_id,
          confirm: true,
          confirm_monthly_cost_minor: q.monthly_cost_minor,
        })
      )
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const buys = f.provider.mock.calls.filter(
      ([u, i]) =>
        String(u).endsWith("/IncomingPhoneNumbers.json") && i?.method === "POST"
    );
    expect(buys).toHaveLength(1);
  });
  it("paginates tied timestamps without dropping or repeating incoming events", async () => {
    const f = await phoneFixture();
    for (let i = 0; i < 130; i++)
      await f.db
        .prepare(
          "INSERT INTO assistant_phone_events(id,binding_id,kind,sender,status,created_at) VALUES(?,?,'sms','caller','received','2026-10-01 12:00:00')"
        )
        .bind(String(i).padStart(3, "0"), f.binding.id)
        .run();
    const ids: string[] = [];
    let before: string | undefined;
    do {
      const p = (await f.act("phone-events", before ? { before } : {})) as {
        data: Array<{ id: string }>;
        next_cursor: string | null;
      };
      ids.push(...p.data.map((x) => x.id));
      before = p.next_cursor ?? undefined;
    } while (before);
    expect(new Set(ids).size).toBe(130);
    expect(ids).toHaveLength(130);
  });
});
