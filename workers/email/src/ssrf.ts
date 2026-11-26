// Destination guard for outbound webhooks. Local copy: @naelao/security (packages/security) would need a new
// workspace dependency in this worker's lockfile importer, which MS-34 does not allow. It is a literal-host
// check (checkWebhookUrl) plus, since MS-48, a DNS-over-HTTPS resolution check (resolveDestination) that refuses
// hostnames whose A/AAAA answers are private. Both are used at create time and before every delivery attempt.
// The resolution is advisory against DNS rebinding (the runtime resolves again when it connects); it closes the
// "public name pointing at a private address" gap. The DoH fetch is injectable and never reached by tests.

const RESERVED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];
const IPV4_RE = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const MAX_URL_LENGTH = 2048;

function ipv4Octets(host: string): number[] | null {
  const m = IPV4_RE.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every(o => o >= 0 && o <= 255) ? octets : null;
}

/** Private, loopback, link-local, shared, documentation, benchmark, multicast and reserved IPv4 ranges. */
function isPrivateIPv4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 // this network, RFC 1918, loopback, multicast, reserved, broadcast
    || (a === 100 && b >= 64 && b <= 127) // shared address space (RFC 6598)
    || (a === 169 && b === 254) // link-local and cloud metadata
    || (a === 172 && b >= 16 && b <= 31) // RFC 1918
    || (a === 192 && b === 0 && (c === 0 || c === 2)) // IETF assignments and TEST-NET-1
    || (a === 192 && b === 168) // RFC 1918
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 198 && b === 51 && c === 100) // TEST-NET-2
    || (a === 203 && b === 0 && c === 113); // TEST-NET-3
}

/** Parses a canonical or compressed IPv6 literal (URL parsing already normalises the common forms). */
function ipv6Groups(host: string): number[] | null {
  let s = host;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const o = ipv4Octets(tail[1]!);
    if (!o) return null;
    s = `${s.slice(0, s.length - tail[1]!.length)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...rest];
  if (groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const values = groups.map(g => Number.parseInt(g, 16));
  if (halves.length === 1) return values.length === 8 ? values : null;
  if (values.length >= 8) return null;
  return [...head.map(g => Number.parseInt(g, 16)), ...Array<number>(8 - values.length).fill(0), ...rest.map(g => Number.parseInt(g, 16))];
}

function isPrivateIPv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every(v => v === 0)) return true; // ::
  if (g.slice(0, 7).every(v => v === 0) && g7 === 1) return true; // ::1
  if (g.slice(0, 6).every(v => v === 0)) return true; // deprecated IPv4-compatible ::/96
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return isPrivateIPv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]); // ::ffff:0:0/96
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIPv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]); // 64:ff9b::/96
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true; // link-local and site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 < 0x2000 || g0 > 0x3fff) return true; // outside global unicast 2000::/3
  if (g0 === 0x2001 && (g1 === 0x0db8 || g1 <= 0x01ff)) return true; // documentation and IETF protocol assignments
  if (g0 === 0x2002) return true; // 6to4 can embed a private IPv4
  if (g0 === 0x3fff && g1 <= 0x0fff) return true; // documentation 3fff::/20
  return false;
}

/** True when a destination host must never be contacted (literal IPs, reserved names, single-label names). */
export function isPrivateHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || RESERVED_SUFFIXES.some(s => host.endsWith(s))) return true;
  if (host.includes(":")) {
    const groups = ipv6Groups(host);
    return groups === null || isPrivateIPv6(groups);
  }
  const octets = ipv4Octets(host);
  if (octets) return isPrivateIPv4(octets);
  const labels = host.split(".");
  if (labels.length === 1) return true; // a single-label name resolves inside a private network
  if (/^\d+$/.test(labels[labels.length - 1]!)) return true; // numeric-looking host that is not a valid IPv4 literal
  return false;
}

export type WebhookUrlCheck = { ok: true; href: string } | { ok: false; reason: string };

/** Validates a webhook destination: https only, no credentials, default port only, no private host. */
export function checkWebhookUrl(raw: unknown): WebhookUrlCheck {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return { ok: false, reason: "the URL must be a string of at most 2048 characters" };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: "the URL is not valid" }; }
  if (url.protocol !== "https:") return { ok: false, reason: "only https URLs are allowed" };
  if (url.username || url.password) return { ok: false, reason: "credentials in the URL are not allowed" };
  if (url.port !== "") return { ok: false, reason: "only the default https port is allowed" };
  if (isPrivateHost(url.hostname)) return { ok: false, reason: "the destination host is not allowed" };
  return { ok: true, href: url.href };
}

export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 3_000;
const DOH_MAX_BYTES = 16 * 1024;

/** public: every answer is a public address. private: some answer is private (never contact). unknown: no usable answer. */
export type DestinationResolution = "public" | "private" | "unknown";

async function dohLookup(host: string, type: "A" | "AAAA", dohFetch: typeof fetch): Promise<string[] | null> {
  try {
    const res = await dohFetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: "application/dns-json" }, redirect: "manual", signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
    const text = await res.text();
    if (text.length > DOH_MAX_BYTES) return null;
    const json = JSON.parse(text) as { Status?: unknown; Answer?: Array<{ type?: unknown; data?: unknown }> };
    if (json.Status !== 0 && json.Status !== 3) return null; // NOERROR or NXDOMAIN; anything else (SERVFAIL...) is unusable
    const want = type === "A" ? 1 : 28;
    return (json.Answer ?? []).filter(a => a.type === want && typeof a.data === "string").map(a => a.data as string);
  } catch { return null; }
}

/** Resolves a webhook hostname through DoH (A and AAAA, CNAME chains arrive flattened) and classifies the answers. */
export async function resolveDestination(hostname: string, dohFetch: typeof fetch = fetch): Promise<DestinationResolution> {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.replace(/\.$/, "");
  if (isPrivateHost(host)) return "private";
  if (host.includes(":") || ipv4Octets(host)) return "public"; // a public literal needs no lookup
  const [a, aaaa] = await Promise.all([dohLookup(host, "A", dohFetch), dohLookup(host, "AAAA", dohFetch)]);
  const answers = [...(a ?? []), ...(aaaa ?? [])];
  if (answers.some(isPrivateHost)) return "private";
  if (a === null || aaaa === null || answers.length === 0) return "unknown";
  return "public";
}
