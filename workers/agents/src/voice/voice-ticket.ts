const encoder = new TextEncoder();

export interface OwnerVoiceTicket {
  tenantId: string;
  spaceId: string;
  sessionId: string;
  userId: string;
  role: string;
  callerRole: string;
  agentName: string;
  projectId?: string;
  phoneBindingId?: string;
  callSid?: string;
  expiresAt: number;
  nonce: string;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function sign(payload: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

export async function mintOwnerVoiceTicket(ticket: OwnerVoiceTicket, secret: string): Promise<string> {
  const payload = encode(encoder.encode(JSON.stringify(ticket)));
  return `${payload}.${encode(await sign(payload, secret))}`;
}

export async function verifyOwnerVoiceTicket(
  token: string,
  secret: string,
  expectedAgentName: string,
  now = Math.floor(Date.now() / 1000),
): Promise<OwnerVoiceTicket | null> {
  if (token.length > 4_096) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const expected = await sign(payload, secret);
    const supplied = decode(signature);
    if (expected.length !== supplied.length) return null;
    let diff = 0;
    for (let index = 0; index < expected.length; index++) diff |= expected[index]! ^ supplied[index]!;
    if (diff) return null;
    const parsed = JSON.parse(new TextDecoder().decode(decode(payload))) as Partial<OwnerVoiceTicket>;
    if (typeof parsed.tenantId !== "string" || !parsed.tenantId || typeof parsed.spaceId !== "string" || !parsed.spaceId
      || typeof parsed.sessionId !== "string" || !parsed.sessionId || typeof parsed.userId !== "string" || !parsed.userId
      || (parsed.role !== "owner" && parsed.role !== "admin")
      || (parsed.callerRole !== "owner" && parsed.callerRole !== "admin" && parsed.callerRole !== "product_end_user")
      || parsed.agentName !== expectedAgentName
      || !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt! <= now || parsed.expiresAt! > now + (parsed.phoneBindingId ? 15 * 60 : 5 * 60)
      || typeof parsed.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(parsed.nonce)) return null;
    if (parsed.projectId !== undefined && (typeof parsed.projectId !== "string" || !parsed.projectId)) return null;
    if ((parsed.phoneBindingId !== undefined || parsed.callSid !== undefined) &&
      (typeof parsed.phoneBindingId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(parsed.phoneBindingId) ||
       typeof parsed.callSid !== "string" || !/^CA[a-fA-F0-9]{32}$/.test(parsed.callSid))) return null;
    return parsed as OwnerVoiceTicket;
  } catch {
    return null;
  }
}
