/**
 * Scan-to-connect: how a business owner attaches a channel without opening a developer console.
 *
 * The setup we had was BYO-app-per-space. To put a business on Telegram the owner had to talk to
 * BotFather, create a bot, find its token, come back, paste a signing secret, then copy a webhook
 * URL into a form. Slack and Discord were worse. Every one of those steps is a place a
 * non-technical owner stops, and none of them is work they should ever have been asked to do —
 * it exists only because the platform had no app of its own.
 *
 * So: ONE Naelao app per channel, registered once by us, plus a short-lived pairing token. The
 * owner gets a link (and a QR of it, because the app is already open on their phone), taps it,
 * and the channel is bound to their business. Sixty seconds, no console, no secret to copy.
 *
 * Mechanically it is the same shape as the connector Connect Link flow: mint a single-use ticket,
 * hand the user a URL carrying it, and let the provider bring them back — except Telegram and
 * WhatsApp bring them back through an inbound MESSAGE rather than a redirect, which is why the
 * platform inbound route has to recognise a pairing message before treating it as conversation.
 *
 * The per-space BYO path is deliberately NOT removed. A business that wants its own branded bot,
 * or one on a Slack workspace we're not installed in, still has it — this is the default, not the
 * only way.
 */

export type PairableChannel = "telegram" | "slack" | "discord" | "whatsapp";

export function isPairableChannel(c: string): c is PairableChannel {
  return c === "telegram" || c === "slack" || c === "discord" || c === "whatsapp";
}

/** What a pairing token stands for. Resolved server-side; never trusted from the client. */
export interface PairingTicket {
  spaceId: string;
  tenantId: string;
  channel: PairableChannel;
  /** Bind the channel to a specific customer-bot project rather than the Space Assistant. */
  projectId?: string | undefined;
  /** Who started the pairing — recorded so a binding is attributable. */
  userId: string;
}

/**
 * Fifteen minutes. Long enough to walk to your phone and find the app; short enough that a link
 * left in a screenshot or a shared screen recording is dead by the time anyone else sees it.
 */
export const PAIRING_TTL_SECONDS = 900;

export function pairingKey(token: string): string {
  return `channel-pairing:${token}`;
}

/**
 * Tokens are `cp_` + 32 hex characters. The prefix makes them recognisable in a log or an inbound
 * message; the length keeps them inside Telegram's 64-character `start` payload limit, which is
 * the tightest constraint any of these channels imposes.
 */
export function mintPairingToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return "cp_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Telegram's start payload allows only these characters, so nothing else may appear in a token. */
export const PAIRING_TOKEN_PATTERN = /^cp_[0-9a-f]{32}$/;

export async function issuePairingToken(kv: KVNamespace, ticket: PairingTicket): Promise<string> {
  const token = mintPairingToken();
  await kv.put(pairingKey(token), JSON.stringify(ticket), { expirationTtl: PAIRING_TTL_SECONDS });
  return token;
}

/** Single-use: a link that ends up in a screenshot can never be redeemed twice. */
export async function consumePairingToken(kv: KVNamespace, token: string): Promise<PairingTicket | null> {
  if (!PAIRING_TOKEN_PATTERN.test(token)) return null;
  const raw = await kv.get(pairingKey(token));
  if (!raw) return null;
  await kv.delete(pairingKey(token));
  try {
    return JSON.parse(raw) as PairingTicket;
  } catch {
    return null;
  }
}

/** The platform-app identifiers a channel needs before anyone can pair with it. */
export interface PairingEnv {
  /** Telegram bot username, WITHOUT the @ — e.g. "naelao_bot". */
  TELEGRAM_BOT_USERNAME?: string | undefined;
  SLACK_CLIENT_ID?: string | undefined;
  DISCORD_CLIENT_ID?: string | undefined;
  /** The platform's WhatsApp Business number in international format, digits only (Meta Cloud
   *  API transport). */
  WHATSAPP_PHONE_NUMBER?: string | undefined;
  /**
   * Twilio as an alternative WhatsApp transport. Same channel, same pairing, same inbox — the
   * difference is what the operator has to obtain. Meta's Cloud API needs a verified Business
   * account; Twilio's sandbox is free and instant, which is the difference between a platform
   * offering WhatsApp at all and not.
   *
   * The sandbox is SHARED, so joining it requires its own code alongside our pairing token —
   * hence TWILIO_WHATSAPP_JOIN_CODE. A production Twilio sender needs no join code and that
   * field is simply left unset.
   */
  TWILIO_WHATSAPP_NUMBER?: string | undefined;
  TWILIO_WHATSAPP_JOIN_CODE?: string | undefined;
  /** Public origin of this worker, used as the OAuth redirect target. */
  PUBLIC_AGENTS_URL?: string | undefined;
}

export interface PairingInstructions {
  /** Where the owner is sent. Also what the QR encodes. */
  url: string;
  /** Whether the owner finishes on their phone (scan) or in a browser tab (click). */
  mode: "scan" | "redirect";
  /** Plain-language steps. Written for someone who has never seen a webhook. */
  steps: string[];
  /** How we learn it worked: an inbound message, or the provider redirecting back. */
  completion: "message" | "callback";
}

export type PairingResult =
  | ({ ok: true } & PairingInstructions)
  | { ok: false; reason: "not_configured"; message: string };

/** Scopes the Slack app asks for: read what it's mentioned in, and reply. Nothing more. */
const SLACK_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
].join(",");

/**
 * Discord permissions bitfield: View Channels (1<<10), Send Messages (1<<11), Read Message
 * History (1<<16). Deliberately minimal — an install prompt asking for administrator is the
 * fastest way to lose a non-technical owner's trust at exactly the moment they're deciding.
 */
const DISCORD_PERMISSIONS = String((1 << 10) | (1 << 11) | (1 << 16));

export function buildPairing(env: PairingEnv, channel: PairableChannel, token: string): PairingResult {
  const redirectBase = (env.PUBLIC_AGENTS_URL ?? "").replace(/\/$/, "");
  const callbackUrl = `${redirectBase}/channels/pair-callback/${channel}`;

  switch (channel) {
    case "telegram": {
      if (!env.TELEGRAM_BOT_USERNAME) return notConfigured("Telegram");
      // A deep link with a start payload: Telegram opens the chat, the owner taps Start, and the
      // payload arrives as the first message. No token, no webhook, nothing to copy.
      return {
        ok: true,
        url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${token}`,
        mode: "scan",
        completion: "message",
        steps: [
          "Scan this with your phone's camera, or tap the link if you're already on your phone.",
          "Telegram opens a chat with the Naelao assistant.",
          "Tap Start. That's it — messages sent here now reach your business.",
        ],
      };
    }

    case "slack": {
      if (!env.SLACK_CLIENT_ID || !redirectBase) return notConfigured("Slack");
      const url =
        `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(env.SLACK_CLIENT_ID)}` +
        `&scope=${encodeURIComponent(SLACK_SCOPES)}` +
        `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
        `&state=${encodeURIComponent(token)}`;
      return {
        ok: true,
        url,
        mode: "redirect",
        completion: "callback",
        steps: [
          "Click to open Slack's own install page.",
          "Choose the workspace you want your assistant in, and click Allow.",
          "Slack sends you straight back here. Then invite the assistant to a channel.",
        ],
      };
    }

    case "discord": {
      if (!env.DISCORD_CLIENT_ID || !redirectBase) return notConfigured("Discord");
      const url =
        `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(env.DISCORD_CLIENT_ID)}` +
        `&permissions=${DISCORD_PERMISSIONS}` +
        `&scope=${encodeURIComponent("bot applications.commands")}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
        `&state=${encodeURIComponent(token)}`;
      return {
        ok: true,
        url,
        mode: "redirect",
        completion: "callback",
        steps: [
          "Click to open Discord's own install page.",
          "Pick the server you want the assistant in, and click Authorise.",
          "Discord sends you straight back here.",
        ],
      };
    }

    case "whatsapp": {
      // Twilio first when configured: it is the transport a platform can actually have today.
      const number = env.TWILIO_WHATSAPP_NUMBER ?? env.WHATSAPP_PHONE_NUMBER;
      if (!number) {
        return {
          ok: false,
          reason: "not_configured",
          message:
            "WhatsApp isn't set up on this platform yet, so there's nothing to scan. " +
            "You can still connect your own WhatsApp app from the advanced setup.",
        };
      }
      // The owner messages US. That direction matters beyond convenience: a person starting the
      // conversation is what Meta's policy treats as opt-in, so there is nothing to apply for.
      // On Twilio's shared sandbox the message also has to carry its join code — the token alone
      // would reach a number that has no idea who is talking to it.
      const body = env.TWILIO_WHATSAPP_NUMBER && env.TWILIO_WHATSAPP_JOIN_CODE
        ? `join ${env.TWILIO_WHATSAPP_JOIN_CODE} ${token}`
        : token;
      return {
        ok: true,
        url: `https://wa.me/${number}?text=${encodeURIComponent(body)}`,
        mode: "scan",
        completion: "message",
        steps: [
          "Scan this with your phone's camera, or tap the link if you're already on your phone.",
          "WhatsApp opens with a message already typed out.",
          "Send it as-is. Your business is connected — replies come back to this same chat.",
        ],
      };
    }
  }
}

function notConfigured(name: string): PairingResult {
  return {
    ok: false,
    reason: "not_configured",
    message:
      `${name} isn't set up on this platform yet, so there's nothing to scan. ` +
      `You can still connect your own ${name} app from the advanced setup.`,
  };
}

/**
 * Pull a pairing token out of an inbound message.
 *
 * Telegram sends `/start <token>`; WhatsApp sends whatever the owner's prefilled message said, so
 * we look for the token anywhere in the text rather than requiring an exact match — a person can
 * and will type "hi" before sending it.
 */
export function extractPairingToken(text: string): string | null {
  const match = text.match(/cp_[0-9a-f]{32}/);
  return match ? match[0] : null;
}
