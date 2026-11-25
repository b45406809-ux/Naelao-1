/**
 * Identity-complete key for a semantic assistant-response cache (spec decision D7).
 *
 * This module only DEFINES the key. Serving a cached response also requires (a) the response to
 * have come from read-only effect classification and (b) live `memoryRevision` and
 * `grantRevision` values for the caller. Nothing calls this yet; the caches stay off.
 */

export interface ResponseCacheIdentityInput {
  tenantId?: string | null;
  spaceId?: string | null;
  /** Omit for a Space-level request; the literal "_space" is used. */
  projectId?: string | null;
  userId?: string | null;
  role?: string | null;
  memoryRevision?: string | number | null;
  grantRevision?: string | number | null;
  /** The response must come from read-only operations only. */
  readOnly?: boolean;
  query?: string | null;
}

export function normalizeResponseCacheQuery(query: string): string {
  return query.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function present(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.trim() === "" ? null : text;
}

export async function responseCacheIdentity(input: ResponseCacheIdentityInput): Promise<string | null> {
  if (input.readOnly !== true) return null;
  const tenantId = present(input.tenantId);
  const spaceId = present(input.spaceId);
  const userId = present(input.userId);
  const role = present(input.role);
  const memoryRevision = present(input.memoryRevision);
  const grantRevision = present(input.grantRevision);
  if (!tenantId || !spaceId || !userId || !role || !memoryRevision || !grantRevision) return null;
  const projectId = present(input.projectId) ?? "_space";
  const canonical = JSON.stringify({
    tenantId,
    spaceId,
    projectId,
    userId,
    role,
    memoryRevision,
    grantRevision,
    query: normalizeResponseCacheQuery(input.query ?? ""),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
