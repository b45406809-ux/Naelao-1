import webpush from "web-push";

export interface BrowserPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

const ALLOWED_PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
  "notify.windows.com",
  "push.services.mozilla.com",
];

export function validatePushSubscription(value: unknown): BrowserPushSubscription | null {
  if (!value || typeof value !== "object") return null;
  const sub = value as Partial<BrowserPushSubscription>;
  if (typeof sub.endpoint !== "string" || sub.endpoint.length > 2048 ||
      !sub.keys || typeof sub.keys !== "object" || Array.isArray(sub.keys)) return null;
  let endpoint: URL;
  try { endpoint = new URL(sub.endpoint); } catch { return null; }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port) return null;
  const hostAllowed = ALLOWED_PUSH_HOSTS.includes(endpoint.hostname);
  if (!hostAllowed || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") return null;
  if (sub.keys.p256dh.length > 256 || sub.keys.auth.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(sub.keys.p256dh) || !/^[A-Za-z0-9_-]+$/.test(sub.keys.auth)) return null;
  if (sub.expirationTime !== undefined && sub.expirationTime !== null &&
      (typeof sub.expirationTime !== "number" || !Number.isFinite(sub.expirationTime) || sub.expirationTime < 0)) return null;
  return { endpoint: endpoint.toString(), keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, expirationTime: sub.expirationTime ?? null };
}

export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashEndpoint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSubscription(subscription: BrowserPushSubscription, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(subscription)));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(data))}`;
}

export async function decryptSubscription(ciphertext: string, secret: string): Promise<BrowserPushSubscription> {
  const [ivText, dataText] = ciphertext.split(".");
  if (!ivText || !dataText) throw new Error("Malformed encrypted push subscription");
  const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)), (c) => c.charCodeAt(0));
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(ivText) }, await encryptionKey(secret), decode(dataText));
  const parsed: unknown = JSON.parse(new TextDecoder().decode(clear));
  const validated = validatePushSubscription(parsed);
  if (!validated) throw new Error("Invalid encrypted push subscription");
  return validated;
}

export async function deliverWebPush(
  subscription: BrowserPushSubscription,
  payload: { title: string; body: string; url: string },
  config: { publicKey: string; privateKey: string; subject: string }
): Promise<number> {
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  try {
    const result = await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 60 * 60 });
    return result.statusCode;
  } catch (error) {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error
      ? Number((error as { statusCode: unknown }).statusCode)
      : 0;
    if (statusCode) return statusCode;
    throw error;
  }
}
