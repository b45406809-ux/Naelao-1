import { readBoundedResponseJson } from "@naelao/http";

type Provider = "ceramic" | "exa" | "linkup";

export interface CloudflareWebSearchConfig {
  CLOUDFLARE_WEB_SEARCH_GATEWAY_ID?: string;
  CLOUDFLARE_WEB_SEARCH_BYOK_ALIAS?: string;
  CLOUDFLARE_WEB_SEARCH_PROVIDER?: string;
}

interface SearchRequest {
  gatewayId: string;
  byokAlias: string;
  provider: Provider;
  query: string;
  limit: number;
}

interface WebSearchBinding {
  websearch?(request: SearchRequest): Promise<Response>;
}

export function webSearchSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.href;
  } catch {
    // A malformed source cannot be cited.
  }
  return null;
}

export async function searchCloudflareWeb(
  ai: Ai,
  config: CloudflareWebSearchConfig,
  query: string,
  limit: number,
) {
  const gatewayId = config.CLOUDFLARE_WEB_SEARCH_GATEWAY_ID;
  const byokAlias = config.CLOUDFLARE_WEB_SEARCH_BYOK_ALIAS;
  const provider = config.CLOUDFLARE_WEB_SEARCH_PROVIDER ?? "ceramic";
  const binding = ai as WebSearchBinding | undefined;
  if (!gatewayId?.trim() || !byokAlias || !/^[A-Za-z0-9_-]{1,64}$/.test(byokAlias)
    || (provider !== "ceramic" && provider !== "exa" && provider !== "linkup")
    || typeof binding?.websearch !== "function") return null;

  // An explicit alias makes a missing provider key fail without consuming Gateway credits.
  const maxResults = Math.min(limit, 10);
  const response = await binding.websearch({ gatewayId: gatewayId.trim(), byokAlias, provider, query, limit: maxResults });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("cloudflare_web_search_failed");
  }
  const payload = await readBoundedResponseJson<{ items?: unknown }>(response, 256 * 1024);
  if (!Array.isArray(payload?.items)) throw new Error("cloudflare_web_search_invalid_response");

  const results: Array<{ url: string; title: string; content: string; score: number }> = [];
  const seen = new Set<string>();
  for (const value of payload.items as unknown[]) {
    if (results.length >= maxResults) break;
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const url = webSearchSourceUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      url,
      title: typeof item.title === "string" ? item.title.slice(0, 300) : "",
      content: typeof item.description === "string" ? item.description.slice(0, 2000) : "",
      score: 0,
    });
  }
  return { provider, results };
}
