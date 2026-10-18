const encoder = new TextEncoder();
const GRANT_TTL_MS = 15_000;
const MAX_GRANT_PARAMS_CHARS = 1_000_000;
const MAX_GRANT_PARAMS_DEPTH = 64;

export interface EphemeralActionGrant {
  nonce: string;
  tool_name: string;
  params_hash: string;
  issued_at: number;
  expires_at: number;
  signature: string;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
function canonical(
  value: unknown,
  active = new WeakSet<object>(),
  depth = 0
): string {
  if (depth > MAX_GRANT_PARAMS_DEPTH)
    throw new RangeError("ephemeral_grant_params_too_deep");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value) || (value && typeof value === "object")) {
    if (active.has(value))
      throw new TypeError("ephemeral_grant_params_circular");
    active.add(value);
    try {
      if (Array.isArray(value))
        return `[${value.map((item) => canonical(item, active, depth + 1)).join(",")}]`;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError("ephemeral_grant_params_not_json");
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([key, item]) =>
            `${JSON.stringify(key)}:${canonical(item, active, depth + 1)}`
        )
        .join(",")}}`;
    } finally {
      active.delete(value);
    }
  }
  throw new TypeError("ephemeral_grant_params_not_json");
}
async function sign(
  unsigned: Omit<EphemeralActionGrant, "signature">,
  secret: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(canonical(unsigned)))
  );
}
export async function mintEphemeralActionGrant(
  toolName: string,
  params: Record<string, unknown>,
  secret: string,
  now = Date.now()
): Promise<EphemeralActionGrant> {
  if (
    !toolName ||
    !secret ||
    toolName.length > 256 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !params ||
    typeof params !== "object" ||
    Array.isArray(params)
  )
    throw new Error(
      "toolName, object params, signing secret, and valid time are required"
    );
  const canonicalParams = canonical(params);
  if (canonicalParams.length > MAX_GRANT_PARAMS_CHARS)
    throw new RangeError("ephemeral_grant_params_too_large");
  const unsigned = {
    nonce: crypto.randomUUID(),
    tool_name: toolName,
    params_hash: await sha256(canonicalParams),
    issued_at: now,
    expires_at: now + GRANT_TTL_MS,
  };
  return { ...unsigned, signature: await sign(unsigned, secret) };
}
export async function verifyEphemeralActionGrant(
  grant: EphemeralActionGrant,
  toolName: string,
  params: Record<string, unknown>,
  secret: string,
  now = Date.now()
): Promise<boolean> {
  if (
    !grant ||
    typeof grant !== "object" ||
    !secret ||
    !toolName ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    typeof grant.signature !== "string" ||
    grant.signature.length !== 64 ||
    typeof grant.nonce !== "string" ||
    typeof grant.params_hash !== "string" ||
    grant.params_hash.length !== 64 ||
    !Number.isSafeInteger(grant.issued_at) ||
    !Number.isSafeInteger(grant.expires_at)
  )
    return false;
  let canonicalParams: string;
  try {
    canonicalParams = canonical(params);
  } catch {
    return false;
  }
  if (canonicalParams.length > MAX_GRANT_PARAMS_CHARS) return false;
  if (
    now > grant.expires_at ||
    grant.expires_at - grant.issued_at !== GRANT_TTL_MS ||
    grant.tool_name !== toolName
  )
    return false;
  if (grant.params_hash !== (await sha256(canonicalParams))) return false;
  const { signature, ...unsigned } = grant;
  const expected = await sign(unsigned, secret);
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < signature.length; i++)
    diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export interface SqlGrantStore {
  exec(query: string, ...bindings: unknown[]): unknown;
}
export async function consumeEphemeralActionGrant(
  store: SqlGrantStore,
  grant: EphemeralActionGrant,
  toolName: string,
  params: Record<string, unknown>,
  secret: string,
  now = Date.now()
): Promise<boolean> {
  if (!(await verifyEphemeralActionGrant(grant, toolName, params, secret, now)))
    return false;
  try {
    store.exec(
      "INSERT INTO ephemeral_grants_consumed (nonce, tool_name, consumed_at) VALUES (?, ?, datetime('now'))",
      grant.nonce,
      grant.tool_name
    );
    return true;
  } catch {
    return false;
  }
}
