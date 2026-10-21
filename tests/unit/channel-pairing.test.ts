/**
 * Scan-to-connect.
 *
 * The behaviour that matters is not "a URL was produced" — it's that a non-technical owner can
 * finish, and that nothing goes wrong in the ways this flow makes newly possible: a pairing token
 * being reusable, a pairing message being answered by the assistant as if it were a customer, or
 * a message from an unpaired chat reaching someone else's business.
 */

import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { twilioWhatsappAdapter } from "../../workers/agents/src/launchpad/channels.js";
import {
  buildPairing,
  issuePairingToken,
  consumePairingToken,
  extractPairingToken,
  mintPairingToken,
  PAIRING_TOKEN_PATTERN,
} from "../../workers/agents/src/launchpad/channel-pairing.js";

const SECRET = "test-platform-secret";
const TELEGRAM_SECRET = "tg-webhook-secret";

class FakeKv {
  store = new Map<string, string>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async put(k: string, v: string) { this.store.set(k, v); }
  async delete(k: string) { this.store.delete(k); }
}

/** A D1 double that keeps the two tables this flow actually touches. */
function makeDb(airGapped = false) {
  const pairings = new Map<string, { space_id: string; tenant_id: string; project_id: string | null }>();
  const links: Array<{ space_id: string; channel: string }> = [];
  const spaces = new Map<string, { tenant_id: string; status: string; config_json: string }>([
    ["space-a", { tenant_id: "tenant-a", status: "active", config_json: airGapped ? '{"compliance":{"airGappedOnly":true}}' : "{}" }],
    ["space-b", { tenant_id: "tenant-b", status: "active", config_json: airGapped ? '{"compliance":{"airGappedOnly":true}}' : "{}" }],
  ]);

  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first<T>() {
          if (sql.includes("FROM channel_pairings")) {
            const row = pairings.get(`${args[0]}:${args[1]}`);
            return (row ? { ...row } : null) as T | null;
          }
          if (sql.includes("FROM spaces")) {
            const sp = spaces.get(String(args[0]));
            return (sp ? { ...sp } : null) as T | null;
          }
          if (sql.includes("FROM channel_links")) return { project_id: null } as T;
          return null as T | null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (sql.includes("INTO channel_pairings")) {
            pairings.set(`${args[0]}:${args[1]}`, {
              space_id: String(args[2]), tenant_id: String(args[3]),
              project_id: args[4] === null ? null : String(args[4]),
            });
          } else if (sql.includes("INTO channel_links")) {
            links.push({ space_id: String(args[0]), channel: String(args[2]) });
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { db, pairings, links };
}

function makeEnv(over: Partial<AgentsEnv> = {}, airGapped = false) {
  const { db, pairings, links } = makeDb(airGapped);
  const forwarded: Array<{ url: string; body: unknown }> = [];
  const kv = new FakeKv();
  const env = {
    PLATFORM_SECRET: SECRET,
    PUBLIC_AGENTS_URL: "https://agents.naelao.com",
    AGENT_CACHE: kv as unknown as KVNamespace,
    PLATFORM_DB: db as unknown as D1Database,
    TELEGRAM_BOT_USERNAME: "naelao_bot",
    TELEGRAM_WEBHOOK_SECRET: TELEGRAM_SECRET,
    SLACK_CLIENT_ID: "slack-client",
    DISCORD_CLIENT_ID: "discord-client",
    WHATSAPP_PHONE_NUMBER: "15551234567",
    NAELAO_AGENT_DO: {
      idFromName: (n: string) => ({ name: n }),
      get: () => ({
        async fetch(req: Request) {
          forwarded.push({ url: req.url, body: await req.json() });
          return new Response("{}");
        },
      }),
    },
    ANALYTICS: { writeDataPoint() {} },
    ...over,
  } as unknown as AgentsEnv;
  return { env, kv, pairings, links, forwarded };
}

function telegramUpdate(chatId: number, text: string) {
  return { message: { message_id: 1, date: 1700000000, chat: { id: chatId }, from: { id: chatId }, text } };
}

async function postInbound(env: AgentsEnv, channel: string, payload: unknown, secret = TELEGRAM_SECRET) {
  return app.fetch(
    new Request(`https://agents.naelao.com/channels/platform-inbound/${channel}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify(payload),
    }),
    env as never
  );
}

describe("pairing tokens", () => {
  it("fits inside Telegram's start-payload limit and character set", () => {
    // The tightest constraint any channel imposes. A token that overflows it produces a deep link
    // Telegram silently drops the payload from, which looks like the user did something wrong.
    const token = mintPairingToken();
    expect(token.length).toBeLessThanOrEqual(64);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(PAIRING_TOKEN_PATTERN.test(token)).toBe(true);
  });

  it("is single use", async () => {
    const kv = new FakeKv() as unknown as KVNamespace;
    const ticket = { spaceId: "space-a", tenantId: "tenant-a", channel: "telegram" as const, userId: "u1" };
    const token = await issuePairingToken(kv, ticket);
    expect(await consumePairingToken(kv, token)).toMatchObject({ spaceId: "space-a" });
    expect(await consumePairingToken(kv, token)).toBeNull();
  });

  it("rejects a malformed token without touching storage", async () => {
    const kv = new FakeKv();
    expect(await consumePairingToken(kv as unknown as KVNamespace, "not-a-token")).toBeNull();
    expect(await consumePairingToken(kv as unknown as KVNamespace, "cp_short")).toBeNull();
  });
});

describe("buildPairing", () => {
  it("builds a Telegram deep link the owner can just tap", () => {
    const r = buildPairing({ TELEGRAM_BOT_USERNAME: "naelao_bot" }, "telegram", "cp_" + "a".repeat(32));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toBe(`https://t.me/naelao_bot?start=cp_${"a".repeat(32)}`);
    expect(r.mode).toBe("scan");
    expect(r.completion).toBe("message");
  });

  it("puts the token in WhatsApp's prefilled message, so the OWNER sends the first message", () => {
    // That direction is the point: a person starting the conversation is what Meta's policy
    // treats as opt-in, which is why this needs no application.
    const r = buildPairing({ WHATSAPP_PHONE_NUMBER: "15551234567" }, "whatsapp", "cp_" + "b".repeat(32));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toContain("https://wa.me/15551234567?text=cp_");
  });

  it("asks Slack and Discord for the narrowest useful permissions", () => {
    const slack = buildPairing({ SLACK_CLIENT_ID: "x", PUBLIC_AGENTS_URL: "https://a.example" }, "slack", "cp_" + "c".repeat(32));
    expect(slack.ok && slack.url).toContain("chat%3Awrite");
    // An install prompt asking for administrator is the fastest way to lose a non-technical
    // owner at exactly the moment they're deciding whether to trust this.
    const discord = buildPairing({ DISCORD_CLIENT_ID: "x", PUBLIC_AGENTS_URL: "https://a.example" }, "discord", "cp_" + "d".repeat(32));
    expect(discord.ok && discord.url).not.toContain("permissions=8");
  });

  it("says a channel isn't set up rather than producing a link that goes nowhere", () => {
    const r = buildPairing({}, "telegram", "cp_" + "e".repeat(32));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/isn't set up/i);
    // And points at the escape hatch, since the BYO path still exists.
    expect(r.message).toMatch(/your own/i);
  });
});

describe("extractPairingToken", () => {
  it("finds the token in Telegram's /start and in a typed-around WhatsApp message", () => {
    const t = "cp_" + "f".repeat(32);
    expect(extractPairingToken(`/start ${t}`)).toBe(t);
    // People type things before they send. Requiring an exact match would strand them.
    expect(extractPairingToken(`hi ${t} thanks`)).toBe(t);
    expect(extractPairingToken("just a normal question")).toBeNull();
  });
});

describe("POST /channels/platform-inbound/:channel", () => {
  it("binds the chat on a pairing message and does NOT hand it to the assistant", async () => {
    // A pairing message looks exactly like a customer message. Forwarding it would have the
    // assistant answer a random token as though it were a question.
    const { env, kv, pairings, forwarded } = makeEnv();
    const token = await issuePairingToken(kv as unknown as KVNamespace, {
      spaceId: "space-a", tenantId: "tenant-a", channel: "telegram", userId: "u1",
    });
    const res = await postInbound(env, "telegram", telegramUpdate(999, `/start ${token}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ paired: true });
    expect(pairings.get("telegram:999")).toMatchObject({ space_id: "space-a" });
    expect(forwarded).toHaveLength(0);
  });

  it("routes a later message from that chat to the business it was paired to", async () => {
    const { env, kv, forwarded } = makeEnv();
    const token = await issuePairingToken(kv as unknown as KVNamespace, {
      spaceId: "space-a", tenantId: "tenant-a", channel: "telegram", userId: "u1",
    });
    await postInbound(env, "telegram", telegramUpdate(999, `/start ${token}`));
    await postInbound(env, "telegram", telegramUpdate(999, "do you ship to Ireland?"));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.body).toMatchObject({ spaceId: "space-a", tenantId: "tenant-a" });
  });

  it("never routes a message from an unpaired chat into someone else's business", async () => {
    const { env, kv, forwarded } = makeEnv();
    await issuePairingToken(kv as unknown as KVNamespace, {
      spaceId: "space-a", tenantId: "tenant-a", channel: "telegram", userId: "u1",
    });
    const res = await postInbound(env, "telegram", telegramUpdate(1234, "hello?"));
    expect(await res.json()).toMatchObject({ skipped: "unpaired" });
    expect(forwarded).toHaveLength(0);
  });

  it("refuses a message whose signature doesn't check out", async () => {
    const { env, forwarded } = makeEnv();
    const res = await postInbound(env, "telegram", telegramUpdate(999, "hi"), "wrong-secret");
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("does not pair on a token that was already used", async () => {
    const { env, kv, pairings } = makeEnv();
    const token = await issuePairingToken(kv as unknown as KVNamespace, {
      spaceId: "space-a", tenantId: "tenant-a", channel: "telegram", userId: "u1",
    });
    await postInbound(env, "telegram", telegramUpdate(999, `/start ${token}`));
    // A second chat replaying the same link out of a screenshot must not attach itself.
    const res = await postInbound(env, "telegram", telegramUpdate(555, `/start ${token}`));
    expect(await res.json()).toMatchObject({ paired: false });
    expect(pairings.get("telegram:555")).toBeUndefined();
  });

  it("stays quiet when the channel has no platform app configured", async () => {
    const { env } = makeEnv({ TELEGRAM_WEBHOOK_SECRET: undefined });
    const res = await postInbound(env, "telegram", telegramUpdate(999, "hi"));
    expect(await res.json()).toMatchObject({ skipped: "channel_not_configured" });
  });
});


describe("WhatsApp over Twilio", () => {
  // Meta's Cloud API needs a verified Business account; Twilio's sandbox is free and instant. Both
  // are "WhatsApp" to the rest of the platform — the transport is chosen by which credentials the
  // operator actually has, which is the difference between offering WhatsApp at all and not.
  it("carries the sandbox join code alongside the pairing token", () => {
    // The sandbox number is SHARED. A message with only our token reaches a number that has no
    // idea who is talking to it.
    const r = buildPairing(
      { TWILIO_WHATSAPP_NUMBER: "14155238886", TWILIO_WHATSAPP_JOIN_CODE: "swift-cat" },
      "whatsapp",
      "cp_" + "a".repeat(32)
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = decodeURIComponent(new URL(r.url).searchParams.get("text") ?? "");
    expect(text).toBe(`join swift-cat cp_${"a".repeat(32)}`);
    // And the token is still findable in it, which is what the inbound route relies on.
    expect(extractPairingToken(text)).toBe("cp_" + "a".repeat(32));
  });

  it("omits the join code on a production sender, which doesn't use one", () => {
    const r = buildPairing({ TWILIO_WHATSAPP_NUMBER: "15551230000" }, "whatsapp", "cp_" + "b".repeat(32));
    expect(r.ok && decodeURIComponent(new URL(r.url).searchParams.get("text") ?? "")).toBe("cp_" + "b".repeat(32));
  });

  it("prefers Twilio over a Meta number when both are configured", () => {
    const r = buildPairing(
      { TWILIO_WHATSAPP_NUMBER: "14155238886", WHATSAPP_PHONE_NUMBER: "15559999999" },
      "whatsapp",
      "cp_" + "c".repeat(32)
    );
    expect(r.ok && r.url).toContain("wa.me/14155238886");
  });

  it("normalizes Twilio's form-encoded inbound, stripping the whatsapp: scheme", () => {
    // The conversation id has to look the same whichever transport delivered it, or a business
    // paired over one couldn't be found by the other.
    const inbound = twilioWhatsappAdapter.normalizeInbound({
      From: "whatsapp:+15551234567",
      To: "whatsapp:+14155238886",
      Body: "do you ship to Ireland?",
      MessageSid: "SM123",
    });
    expect(inbound).toMatchObject({
      channel: "whatsapp",
      channel_user_id: "+15551234567",
      text: "do you ship to Ireland?",
      external_id: "SM123",
    });
  });

  it("ignores a status callback, which carries no body", () => {
    expect(twilioWhatsappAdapter.normalizeInbound({ MessageSid: "SM1", MessageStatus: "delivered" })).toBeNull();
  });

  it("verifies Twilio's signature over the URL AND the sorted parameters", async () => {
    // Signing the URL is why this can't be checked against the request the worker received —
    // naelao-router rewrites the path before forwarding.
    const url = "https://agents.naelao.com/channels/platform-inbound/whatsapp";
    const token = "twilio-auth-token";
    const params = new URLSearchParams({ From: "whatsapp:+1555", Body: "hi", MessageSid: "SM1" });
    const rawBody = params.toString();

    let payload = url;
    for (const k of [...params.keys()].sort()) payload += k + params.get(k)!;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const valid = btoa(String.fromCharCode(...new Uint8Array(sig)));

    expect(await twilioWhatsappAdapter.verifySignature({
      rawBody, headers: { "x-twilio-signature": valid }, secret: token, url,
    })).toBe(true);

    // A signature computed for a different URL must not pass — that is the whole point of the
    // URL being part of the payload.
    expect(await twilioWhatsappAdapter.verifySignature({
      rawBody, headers: { "x-twilio-signature": valid }, secret: token, url: url + "x",
    })).toBe(false);

    expect(await twilioWhatsappAdapter.verifySignature({
      rawBody, headers: { "x-twilio-signature": "wrong" }, secret: token, url,
    })).toBe(false);

    // No URL supplied means we cannot check it — fail closed rather than skip verification.
    expect(await twilioWhatsappAdapter.verifySignature({
      rawBody, headers: { "x-twilio-signature": valid }, secret: token,
    })).toBe(false);
  });
});

describe("GET /channels/pair-callback/:channel", () => {
  it("explains an expired link in plain language instead of showing an error code", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(
      new Request("https://agents.naelao.com/channels/pair-callback/slack?state=cp_" + "0".repeat(32) + "&code=x"),
      env as never
    );
    const html = await res.text();
    expect(html).toMatch(/expired or was already used/i);
    expect(html).not.toMatch(/error_code/);
  });

  it("records nothing when the owner backs out of the consent screen", async () => {
    // Discord/Slack send the browser back with no code. A binding written here would claim an
    // install that never happened.
    const { env, kv, pairings } = makeEnv();
    const token = await issuePairingToken(kv as unknown as KVNamespace, {
      spaceId: "space-a", tenantId: "tenant-a", channel: "slack", userId: "u1",
    });
    const res = await app.fetch(
      new Request(`https://agents.naelao.com/channels/pair-callback/slack?state=${token}`),
      env as never
    );
    expect(await res.text()).toMatch(/cancelled/i);
    expect([...pairings.keys()]).toHaveLength(0);
  });

  it("does not exchange an OAuth code or bind a channel after the Space becomes air-gapped", async () => {
    const { env, kv, pairings } = makeEnv({}, true);
    const token = await issuePairingToken(kv as unknown as KVNamespace, {
      spaceId: "space-a", tenantId: "tenant-a", channel: "slack", userId: "u1",
    });
    const res = await app.fetch(new Request(`https://agents.naelao.com/channels/pair-callback/slack?state=${token}&code=provider-code`), env as never);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/blocked/i);
    expect(pairings.size).toBe(0);
  });
});

describe("POST /spaces/:spaceId/assistant/channels with action:pair", () => {
  async function pair(env: AgentsEnv, channel: string) {
    const token = await mintInternalToken(SECRET, "tenant-a");
    return app.fetch(
      new Request("https://agents.naelao.com/spaces/space-a/assistant/channels", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-user-id": "u1",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify({ action: "pair", channel }),
      }),
      env as never
    );
  }

  it("hands back a link and human steps, not a webhook URL to copy", async () => {
    const { env } = makeEnv();
    const res = await pair(env, "telegram");
    expect(res.status).toBe(200);
    const body = await res.json<{ pair_url: string; steps: string[]; mode: string }>();
    expect(body.pair_url).toContain("https://t.me/naelao_bot?start=cp_");
    expect(body.mode).toBe("scan");
    expect(body.steps.length).toBeGreaterThan(0);
    expect(body.steps.join(" ")).not.toMatch(/webhook|signing secret|API key/i);
  });

  it("says email has nothing to pair rather than failing obscurely", async () => {
    // Email is provisioned automatically (AgentMail) — offering a QR for it would be a lie.
    const { env } = makeEnv();
    const res = await pair(env, "email");
    expect(res.status).toBe(400);
    expect((await res.json<{ error_code: string }>()).error_code).toBe("not_pairable");
  });

  it("mints no token when the channel can't be paired on this platform", async () => {
    // Otherwise every attempt would leave a dead entry in KV and hand back a link to nowhere.
    const { env, kv } = makeEnv({ TELEGRAM_BOT_USERNAME: undefined });
    const res = await pair(env, "telegram");
    expect(res.status).toBe(503);
    expect(kv.store.size).toBe(0);
  });

  it("does not mint pairing links for air-gapped Spaces", async () => {
    const { env, kv } = makeEnv({}, true);
    const res = await pair(env, "telegram");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error_code: "air_gap_egress_denied" });
    expect(kv.store.size).toBe(0);
  });
});
