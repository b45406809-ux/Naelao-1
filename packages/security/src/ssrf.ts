/** Outbound network policy. DNS failures are denied: an unverified destination is not safe. */
export interface SsrfCheckResult {
  blocked: boolean;
  reason?: string;
}

interface DnsAnswer {
  data?: string;
  type?: number;
}
interface DnsJson {
  Status?: number;
  Answer?: DnsAnswer[];
}
type IPv6Words = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

function ipv4Value(input: string): number | null {
  const chunks = input.split(".");
  if (chunks.length !== 4) return null;
  if (chunks.some((chunk) => !/^\d{1,3}$/.test(chunk))) return null;
  const octets = chunks.map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined)
    return null;
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

function ipv6Words(input: string): IPv6Words | null {
  let host = input.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(":")) return null;
  if (host.includes("%")) return null;
  const lastColon = host.lastIndexOf(":");
  const dotted = host.slice(lastColon + 1);
  if (dotted.includes(".")) {
    const ipv4 = ipv4Value(dotted);
    if (ipv4 === null) return null;
    host = `${host.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  if ((host.match(/::/g) ?? []).length > 1) return null;
  const hasCompression = host.includes("::");
  const halves = hasCompression ? host.split("::") : [host];
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = [...left, ...right];
  if (groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return null;
  if (hasCompression ? groups.length >= 8 : groups.length !== 8) return null;
  const zeros = hasCompression ? 8 - groups.length : 0;
  return [
    ...left.map((group) => Number.parseInt(group, 16)),
    ...Array<number>(zeros).fill(0),
    ...right.map((group) => Number.parseInt(group, 16)),
  ] as IPv6Words;
}

function ipv4FromIpv6(words: IPv6Words): string {
  const value = ((words[6] << 16) | words[7]) >>> 0;
  return `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

function hasPrefix(
  words: readonly number[],
  prefix: readonly number[]
): boolean {
  return prefix.every((word, index) => words[index] === word);
}

export function isPrivateNetworkAddress(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return true;
  const ip = ipv4Value(host);
  if (ip !== null) {
    const inCidr = (base: number, bits: number) =>
      bits === 0 || ip >>> (32 - bits) === base >>> (32 - bits);
    return (
      inCidr(0x00000000, 8) ||
      inCidr(0x0a000000, 8) ||
      inCidr(0x64400000, 10) ||
      inCidr(0x7f000000, 8) ||
      inCidr(0xa9fe0000, 16) ||
      inCidr(0xac100000, 12) ||
      inCidr(0xc0000000, 24) ||
      inCidr(0xc0000200, 24) ||
      inCidr(0xc0586300, 24) ||
      inCidr(0xc0a80000, 16) ||
      inCidr(0xc6120000, 15) ||
      inCidr(0xc6336400, 24) ||
      inCidr(0xcb007100, 24) ||
      inCidr(0xe0000000, 4) ||
      inCidr(0xf0000000, 4)
    );
  }

  if (!host.includes(":")) return false;
  const words = ipv6Words(host);
  // A colon-containing invalid address must not reach DNS/fetch as if it were a hostname.
  if (!words) return true;
  if (
    words.every((word) => word === 0) ||
    (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)
  )
    return true;

  // IPv4-mapped and well-known NAT64 addresses inherit the embedded IPv4 policy.
  if (hasPrefix(words, [0, 0, 0, 0, 0, 0xffff]))
    return isPrivateNetworkAddress(ipv4FromIpv6(words));
  if (hasPrefix(words, [0x0064, 0xff9b, 0, 0, 0, 0]))
    return isPrivateNetworkAddress(ipv4FromIpv6(words));

  const first = words[0];
  if (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  )
    return true;
  // Only global-unicast space is eligible. Reject protocol assignments, documentation,
  // 6to4 tunneling, and documentation prefixes that are inside 2000::/3.
  if (first < 0x2000 || first > 0x3fff) return true;
  if (first === 0x2001 && (words[1] === 0x0db8 || words[1] <= 0x01ff))
    return true;
  if (first === 0x2002) return true;
  if (first === 0x3fff && words[1] <= 0x0fff) return true;
  return false;
}

export async function resolveHostnameIps(
  hostname: string,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const resolve = async (type: "A" | "AAAA") => {
    const response = await fetchImpl(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      {
        headers: { accept: "application/dns-json" },
        redirect: "error",
      }
    );
    if (!response.ok) throw new Error(`DoH returned ${response.status}`);
    const result = await response.json<DnsJson>();
    if (result.Status !== undefined && result.Status !== 0)
      throw new Error(`DoH status ${result.Status}`);
    return (result.Answer ?? [])
      .map((answer) => answer.data)
      .filter((value): value is string => {
        if (!value) return false;
        const unwrapped = value.replace(/^\[|\]$/g, "");
        return ipv4Value(unwrapped) !== null || ipv6Words(unwrapped) !== null;
      });
  };
  const [a, aaaa] = await Promise.all([resolve("A"), resolve("AAAA")]);
  return [...new Set([...a, ...aaaa])];
}

export async function checkSsrf(
  rawUrl: string,
  opts: { resolveDns?: boolean; fetchImpl?: typeof fetch } = {}
): Promise<SsrfCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { blocked: true, reason: "Invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { blocked: true, reason: `Protocol not allowed: ${url.protocol}` };
  if (url.username || url.password)
    return { blocked: true, reason: "URL credentials are not allowed" };
  if (isPrivateNetworkAddress(url.hostname))
    return { blocked: true, reason: `Blocked host: ${url.hostname}` };
  if (
    opts.resolveDns === false ||
    ipv4Value(url.hostname) !== null ||
    ipv6Words(url.hostname) !== null
  )
    return { blocked: false };
  try {
    const ips = await resolveHostnameIps(url.hostname, opts.fetchImpl ?? fetch);
    if (ips.length === 0)
      return {
        blocked: true,
        reason: "Destination has no verified DNS address",
      };
    const privateIp = ips.find(isPrivateNetworkAddress);
    return privateIp
      ? {
          blocked: true,
          reason: `Host resolves to a blocked address: ${privateIp}`,
        }
      : { blocked: false };
  } catch {
    return { blocked: true, reason: "Destination DNS could not be verified" };
  }
}
