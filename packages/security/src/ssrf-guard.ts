// F10/F13: SSRF protection for outbound requests a Worker makes on a builder's/agent's
// behalf. Two layers: a literal hostname/IP blocklist (fast, catches the obvious cases) and a
// DNS resolution check (catches DNS-rebinding — e.g. a hostname that resolves to
// 169.254.169.254 — which a literal-only check cannot see).

const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^169\.254\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT range, also used by some cloud metadata services
  /^fc00:/i,
  /^fd00:/i,
  /^fe80:/i,
  /^0\./,
];

function isBlockedIpOrHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((re) => re.test(hostname));
}

function isBlockedDomainSuffix(hostname: string): boolean {
  return hostname.endsWith(".internal") || hostname.endsWith(".local") || hostname.endsWith(".localhost");
}

interface DohAnswer {
  data?: string;
}
interface DohResponse {
  Answer?: DohAnswer[];
}

/** Resolve a hostname's A/AAAA records via Cloudflare DNS-over-HTTPS (JSON API). */
export async function resolveHostnameIps(hostname: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const query = async (type: "A" | "AAAA"): Promise<DohResponse | null> => {
    try {
      const resp = await fetchImpl(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
        { headers: { accept: "application/dns-json" } }
      );
      if (!resp.ok) return null;
      return await resp.json<DohResponse>();
    } catch {
      return null;
    }
  };

  const [a, aaaa] = await Promise.all([query("A"), query("AAAA")]);
  const answers = [...(a?.Answer ?? []), ...(aaaa?.Answer ?? [])];
  return answers.map((x) => x.data).filter((d): d is string => !!d);
}

export interface SsrfCheckResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Full SSRF check: protocol allowlist, literal hostname/IP blocklist, and (if resolveDns is
 * not disabled) DNS resolution of the hostname to catch rebinding to a blocked address.
 */
export async function checkSsrf(
  rawUrl: string,
  opts: { resolveDns?: boolean; fetchImpl?: typeof fetch } = {}
): Promise<SsrfCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { blocked: true, reason: "Invalid URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { blocked: true, reason: `Protocol not allowed: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isBlockedIpOrHost(hostname) || isBlockedDomainSuffix(hostname)) {
    return { blocked: true, reason: `Blocked host: ${hostname}` };
  }

  if (opts.resolveDns !== false) {
    const resolved = await resolveHostnameIps(hostname, opts.fetchImpl ?? fetch);
    const blockedResolved = resolved.find((ip) => isBlockedIpOrHost(ip));
    if (blockedResolved) {
      return { blocked: true, reason: `Host ${hostname} resolves to a blocked address: ${blockedResolved}` };
    }
  }

  return { blocked: false };
}
