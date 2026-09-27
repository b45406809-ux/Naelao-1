const encoder = new TextEncoder();
const GRANT_TTL_MS = 15_000;

export interface EphemeralActionGrant {
  nonce: string; tool_name: string; params_hash: string; issued_at: number; expires_at: number; signature: string;
}

function hex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function sha256(value: string): Promise<string> { return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function sign(unsigned: Omit<EphemeralActionGrant, "signature">, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical(unsigned))));
}
export async function mintEphemeralActionGrant(toolName: string, params: Record<string, unknown>, secret: string, now = Date.now()): Promise<EphemeralActionGrant> {
  if (!toolName || !secret) throw new Error("toolName and signing secret are required");
  const unsigned = { nonce: crypto.randomUUID(), tool_name: toolName, params_hash: await sha256(canonical(params)), issued_at: now, expires_at: now + GRANT_TTL_MS };
  return { ...unsigned, signature: await sign(unsigned, secret) };
}
export async function verifyEphemeralActionGrant(grant: EphemeralActionGrant, toolName: string, params: Record<string, unknown>, secret: string, now = Date.now()): Promise<boolean> {
  if (now > grant.expires_at || grant.expires_at - grant.issued_at !== GRANT_TTL_MS || grant.tool_name !== toolName) return false;
  if (grant.params_hash !== await sha256(canonical(params))) return false;
  const { signature, ...unsigned } = grant;
  const expected = await sign(unsigned, secret);
  if (signature.length !== expected.length) return false;
  let diff = 0; for (let i = 0; i < signature.length; i++) diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export interface SqlGrantStore { exec(query: string, ...bindings: unknown[]): unknown }
export async function consumeEphemeralActionGrant(store: SqlGrantStore, grant: EphemeralActionGrant, toolName: string, params: Record<string, unknown>, secret: string, now = Date.now()): Promise<boolean> {
  if (!await verifyEphemeralActionGrant(grant, toolName, params, secret, now)) return false;
  try {
    store.exec("INSERT INTO ephemeral_grants_consumed (nonce, tool_name, consumed_at) VALUES (?, ?, datetime('now'))", grant.nonce, grant.tool_name);
    return true;
  } catch { return false; }
}
