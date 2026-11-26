export const SCOPES = ["inboxes:read", "inboxes:write", "messages:read", "messages:send", "webhooks:write", "usage:read"] as const;
export type Scope = (typeof SCOPES)[number];
const KEY_RE = /^nem_[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

function b64url(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export async function sha256Hex(value: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(d, b => b.toString(16).padStart(2, "0")).join("");
}
/** `nem_` + 32 random bytes base64url. The plaintext is returned once and never stored. */
export function generateApiKey() {
  return `nem_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}
export function isApiKeyShape(key: string) { return KEY_RE.test(key); }
export function keyPrefix(key: string) { return key.slice(0, 8); }
export function isScope(value: unknown): value is Scope { return typeof value === "string" && (SCOPES as readonly string[]).includes(value); }

export interface AuthContext { tenantId: string; keyId: string; scopes: Scope[] }

/** Lookup by SHA-256 hash (no secret comparison happens in application code). Tenant comes only from the key row. */
export async function authenticate(db: D1Database, authorization: string | undefined): Promise<AuthContext | null> {
  const match = /^Bearer (\S+)$/.exec(authorization ?? "");
  if (!match || !isApiKeyShape(match[1]!)) return null;
  const row = await db.prepare(
    `SELECT k.id, k.nemail_tenant_id, k.scopes_json FROM nemail_api_keys k JOIN nemail_tenants t ON t.id = k.nemail_tenant_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR julianday(k.expires_at) > julianday('now')) AND t.status = 'active'`
  ).bind(await sha256Hex(match[1]!)).first<{ id: string; nemail_tenant_id: string; scopes_json: string }>();
  if (!row) return null;
  let scopes: Scope[] = [];
  try { scopes = (JSON.parse(row.scopes_json) as unknown[]).filter(isScope); } catch { /* no scopes */ }
  return { tenantId: row.nemail_tenant_id, keyId: row.id, scopes };
}
