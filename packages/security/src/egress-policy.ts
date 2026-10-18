import { checkSsrf } from "./ssrf.js";

export interface SpaceEgressPolicy {
  /** Exact normalized hostnames approved by a space owner. Wildcards are deliberately unsupported. */
  allowedHosts: string[];
  allowHttp?: boolean;
}

export type EgressDenialCode =
  | "invalid_url"
  | "scheme_denied"
  | "port_denied"
  | "host_not_granted"
  | "network_denied";

export class EgressPolicyError extends Error {
  constructor(
    readonly code: EgressDenialCode,
    message: string
  ) {
    super(message);
    this.name = "EgressPolicyError";
  }
}

function normalizeGrantHost(host: string): string | null {
  const value = host.trim();
  if (
    !value ||
    value.length > 253 ||
    value.includes("*") ||
    value.includes("/") ||
    value.includes("@")
  )
    return null;
  try {
    const url = new URL(`https://${value}`);
    if (
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

export function normalizeAllowedHosts(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 1000) return [];
  return [
    ...new Set(
      input
        .filter((value): value is string => typeof value === "string")
        .map(normalizeGrantHost)
        .filter((value): value is string => value !== null)
    ),
  ];
}

/** Read owner-authored egress grants from the authoritative space record; malformed policy denies. */
export async function readSpaceEgressPolicy(
  db: D1Database,
  spaceId: string
): Promise<SpaceEgressPolicy> {
  try {
    const row = await db
      .prepare(
        "SELECT config_json FROM spaces WHERE id = ? AND status != 'deleted'"
      )
      .bind(spaceId)
      .first<{ config_json: string | null }>();
    if (!row) throw new Error("space_missing");
    const config = JSON.parse(row.config_json || "{}") as {
      security?: { egress?: { allowedHosts?: unknown; allowHttp?: unknown } };
    };
    const egress = config.security?.egress;
    return {
      allowedHosts: normalizeAllowedHosts(egress?.allowedHosts),
      allowHttp: egress?.allowHttp === true,
    };
  } catch {
    return { allowedHosts: [] };
  }
}

/** Normalize and authorize a URL before any credential is resolved or injected. */
export async function authorizeEgressUrl(
  rawUrl: string,
  policy: SpaceEgressPolicy,
  dnsFetch: typeof fetch = fetch
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressPolicyError("invalid_url", "Destination URL is invalid");
  }
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  url.hash = "";
  if (url.username || url.password)
    throw new EgressPolicyError(
      "invalid_url",
      "Destination URL credentials are not allowed"
    );
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && policy.allowHttp === true)
  ) {
    throw new EgressPolicyError(
      "scheme_denied",
      "Only approved HTTPS destinations are allowed"
    );
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (
    (url.protocol === "https:" && port !== "443") ||
    (url.protocol === "http:" && port !== "80")
  ) {
    throw new EgressPolicyError(
      "port_denied",
      "Destination port is not allowed"
    );
  }
  const granted = new Set(normalizeAllowedHosts(policy.allowedHosts));
  if (!granted.has(url.hostname))
    throw new EgressPolicyError(
      "host_not_granted",
      "Destination host is not approved for this space"
    );
  const ssrf = await checkSsrf(url.toString(), { fetchImpl: dnsFetch });
  if (ssrf.blocked)
    throw new EgressPolicyError(
      "network_denied",
      "Destination resolves to a prohibited or unverified network"
    );
  return url;
}

/** Redirect destinations are re-authorized at every hop and authenticated redirects stay same-origin. */
export async function authorizeEgressRedirect(
  currentUrl: string | URL,
  location: string,
  policy: SpaceEgressPolicy,
  dnsFetch: typeof fetch = fetch
): Promise<URL> {
  let next: URL;
  try {
    next = await authorizeEgressUrl(
      new URL(location, currentUrl).toString(),
      policy,
      dnsFetch
    );
  } catch (error) {
    if (error instanceof EgressPolicyError) throw error;
    throw new EgressPolicyError(
      "invalid_url",
      "Redirect destination is invalid"
    );
  }
  const current = new URL(currentUrl);
  if (next.origin !== current.origin) {
    throw new EgressPolicyError(
      "host_not_granted",
      "Cross-origin redirects are not allowed for authenticated requests"
    );
  }
  return next;
}
