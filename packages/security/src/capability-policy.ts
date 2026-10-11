export interface CapabilityScope { tenantId: string; spaceId: string; projectId?: string; installationId?: string; }
export interface CapabilityClaims extends CapabilityScope {
  issuer: string;
  audience: string;
  actorId: string;
  operation: string;
  resource: string;
  issuedAt: number;
  expiresAt: number;
  revocationEpoch: number;
  tokenId: string;
}
export interface CapabilityVerificationContext extends CapabilityScope {
  issuer: string;
  audience: string;
  actorId: string;
  operation: string;
  resource: string;
  revocationEpoch: number;
  now?: number;
}

export class CapabilityDeniedError extends Error {
  constructor(readonly reason: string) { super(`capability_denied:${reason}`); this.name = "CapabilityDeniedError"; }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const encoder = new TextEncoder();
function encode(value: string): string { return btoa(String.fromCharCode(...encoder.encode(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function decode(value: string): string { const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4); return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))); }
async function sign(input: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encode(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(input)))));
}
function validateScope(scope: CapabilityScope): void {
  for (const label of ["tenantId", "spaceId", "projectId", "installationId"] as const) {
    const value = scope[label];
    if (value !== undefined && (!value || !IDENTIFIER.test(value))) throw new CapabilityDeniedError(`invalid_${label}`);
  }
  if (!scope.tenantId || !scope.spaceId) throw new CapabilityDeniedError("scope_required");
}

export async function issueScopedCapabilityToken(input: Omit<CapabilityClaims, "issuedAt" | "tokenId"> & { ttlSeconds: number }, secret: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!secret) throw new CapabilityDeniedError("issuer_secret_required");
  validateScope(input);
  if (!input.issuer || !input.audience || !input.actorId || !input.operation || !input.resource || !Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 900) throw new CapabilityDeniedError("invalid_claims");
  const header = encode(JSON.stringify({ alg: "HS256", typ: "NAELAO-CAP" }));
  const claims: CapabilityClaims = { ...input, issuedAt: now, expiresAt: now + input.ttlSeconds, tokenId: crypto.randomUUID() };
  const payload = encode(JSON.stringify(claims));
  return `${header}.${payload}.${await sign(`${header}.${payload}`, secret)}`;
}

export async function verifyScopedCapabilityToken(token: string, secret: string, context: CapabilityVerificationContext): Promise<CapabilityClaims> {
  if (!token || !secret) throw new CapabilityDeniedError("token_required");
  const parts = token.split(".");
  if (parts.length !== 3) throw new CapabilityDeniedError("malformed_token");
  const header = parts[0]!;
  const payload = parts[1]!;
  const signature = parts[2]!;
  try {
    const parsedHeader = JSON.parse(decode(header)) as { alg?: string; typ?: string };
    if (parsedHeader.alg !== "HS256" || parsedHeader.typ !== "NAELAO-CAP") throw new CapabilityDeniedError("invalid_header");
    const expected = await sign(`${header}.${payload}`, secret);
    if (expected !== signature) throw new CapabilityDeniedError("invalid_signature");
    const claims = JSON.parse(decode(payload)) as CapabilityClaims;
    validateScope(claims);
    const now = context.now ?? Math.floor(Date.now() / 1000);
    if (claims.issuer !== context.issuer || claims.audience !== context.audience) throw new CapabilityDeniedError("issuer_or_audience_mismatch");
    if (claims.issuedAt > now + 30 || claims.expiresAt <= now) throw new CapabilityDeniedError("expired_token");
    if (claims.revocationEpoch < context.revocationEpoch) throw new CapabilityDeniedError("revoked_token");
    for (const key of ["tenantId", "spaceId", "projectId", "installationId", "actorId", "operation", "resource"] as const) {
      const expectedValue = context[key];
      if (expectedValue !== undefined && claims[key] !== expectedValue) throw new CapabilityDeniedError(`scope_mismatch:${key}`);
    }
    return Object.freeze(claims);
  } catch (error) {
    if (error instanceof CapabilityDeniedError) throw error;
    throw new CapabilityDeniedError("unparseable_token");
  }
}

export interface RetrievalRecord { tenantId: string; spaceId: string; projectId: string; requiredRoleRank: number; allowedUserIds?: readonly string[]; content: string; [key: string]: unknown; }
export interface RetrievalPrincipal { tenantId: string; spaceId: string; projectId: string; userId: string; roleRank: number; }
export interface RetrievalPredicate { sql: string; binds: readonly (string | number)[]; }
export function buildRetrievalPredicate(alias: string, principal: RetrievalPrincipal): RetrievalPredicate {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(alias)) throw new CapabilityDeniedError("invalid_retrieval_alias");
  return { sql: `${alias}.tenant_id = ? AND ${alias}.space_id = ? AND ${alias}.project_id = ? AND ${alias}.required_role_rank <= ?`, binds: [principal.tenantId, principal.spaceId, principal.projectId, principal.roleRank] };
}
export function isRetrievalRecordAllowed(record: RetrievalRecord, principal: RetrievalPrincipal): boolean {
  return record.tenantId === principal.tenantId && record.spaceId === principal.spaceId && record.projectId === principal.projectId && record.requiredRoleRank <= principal.roleRank && (!record.allowedUserIds || record.allowedUserIds.length === 0 || record.allowedUserIds.includes(principal.userId));
}
export function escapeUntrustedContext(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;"); }
export function wrapUntrustedContext(input: { id: string; source: string; content: string; clearance?: string }): string {
  return `<context_chunk id="${escapeUntrustedContext(input.id)}" source="${escapeUntrustedContext(input.source)}"${input.clearance ? ` clearance="${escapeUntrustedContext(input.clearance)}"` : ""}>${escapeUntrustedContext(input.content)}</context_chunk>`;
}
