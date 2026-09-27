/** Outbound network policy. DNS failures are denied: an unverified destination is not safe. */
export interface SsrfCheckResult { blocked: boolean; reason?: string }

interface DnsAnswer { data?: string; type?: number }
interface DnsJson { Status?: number; Answer?: DnsAnswer[] }

function ipv4Value(input: string): number | null {
  const chunks = input.split(".");
  if (chunks.length !== 4) return null;
  const octets = chunks.map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
}

export function isPrivateNetworkAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) return true;
  if (host.startsWith("::ffff:")) return isPrivateNetworkAddress(host.slice(7));
  const ip = ipv4Value(host);
  if (ip === null) return false;
  const inCidr = (base: number, bits: number) => bits === 0 || ((ip >>> (32 - bits)) === (base >>> (32 - bits)));
  return inCidr(0x00000000, 8) || inCidr(0x0a000000, 8) || inCidr(0x64400000, 10) ||
    inCidr(0x7f000000, 8) || inCidr(0xa9fe0000, 16) || inCidr(0xac100000, 12) ||
    inCidr(0xc0a80000, 16) || inCidr(0xe0000000, 4);
}

export async function resolveHostnameIps(hostname: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const resolve = async (type: "A" | "AAAA") => {
    const response = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { accept: "application/dns-json" }, redirect: "error",
    });
    if (!response.ok) throw new Error(`DoH returned ${response.status}`);
    const result = await response.json<DnsJson>();
    if (result.Status !== undefined && result.Status !== 0) throw new Error(`DoH status ${result.Status}`);
    return (result.Answer ?? []).map((answer) => answer.data).filter((value): value is string => Boolean(value));
  };
  const [a, aaaa] = await Promise.all([resolve("A"), resolve("AAAA")]);
  return [...new Set([...a, ...aaaa])];
}

export async function checkSsrf(rawUrl: string, opts: { resolveDns?: boolean; fetchImpl?: typeof fetch } = {}): Promise<SsrfCheckResult> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { blocked: true, reason: "Invalid URL" }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { blocked: true, reason: `Protocol not allowed: ${url.protocol}` };
  if (url.username || url.password) return { blocked: true, reason: "URL credentials are not allowed" };
  if (isPrivateNetworkAddress(url.hostname)) return { blocked: true, reason: `Blocked host: ${url.hostname}` };
  if (opts.resolveDns === false || ipv4Value(url.hostname) !== null) return { blocked: false };
  try {
    const ips = await resolveHostnameIps(url.hostname, opts.fetchImpl ?? fetch);
    if (ips.length === 0) return { blocked: true, reason: "Destination has no verified DNS address" };
    const privateIp = ips.find(isPrivateNetworkAddress);
    return privateIp ? { blocked: true, reason: `Host resolves to blocked address: ${privateIp}` } : { blocked: false };
  } catch {
    return { blocked: true, reason: "Destination DNS could not be verified" };
  }
}
