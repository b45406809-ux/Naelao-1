/**
 * storefront (spec §11 external portal) — provision a Naelao-hosted, multitenant storefront.
 * Tier 2.
 *
 * Architecture (Cloudflare for SaaS, confirmed against CF docs): storefronts are NOT a
 * Worker-per-tenant. They are ONE multitenant surface — a CF Pages static shell fronted by
 * the portal Worker (the fallback origin) which routes by Host header. Provisioning a
 * storefront therefore does not deploy anything; it just:
 *   1. allocates {slug}.naelao.com (covered by the zone's wildcard cert — no per-tenant cert)
 *   2. records a business_services row (space_id, kind='storefront', naelao_handle)
 *   3. registers the Host→spaceId route the portal Worker reads
 *
 * Custom domains are opt-in (productConfig.commerce.allowCustomDomain). They use the
 * Cloudflare for SaaS custom_hostnames API: the customer CNAMEs their domain to the
 * fallback origin and CF issues a DV cert. Until DNS validates, status is 'pending_dns'.
 *
 * Operations:
 *   storefront.provision(slug?)            → { handle: "{slug}.naelao.com", status }
 *   storefront.set_custom_domain(domain)   → { custom_domain, status: "pending_dns", dns }
 *   storefront.status()                    → current storefront service record
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken, readBoundedResponseJson, readBoundedResponseText } from "@naelao/http";

async function bizService(
  ctx: PrebuiltOpContext,
  method: "POST" | "GET",
  body?: Record<string, unknown>
): Promise<unknown> {
  if (!ctx.env.spacesWorker) throw new Error("storefront unavailable: spaces worker binding not configured");
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": ctx.env.tenantId,
      "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
    },
  };
  if (body) init.body = JSON.stringify({ space_id: ctx.env.spaceId, ...body });
  const path = method === "GET"
    ? `/internal/business-services?space_id=${encodeURIComponent(ctx.env.spaceId)}&kind=storefront`
    : `/internal/business-services`;
  const resp = await ctx.env.spacesWorker.fetch(new Request(`http://spaces-worker${path}`, init));
  if (!resp.ok) throw new Error(`storefront op failed: ${resp.status} ${(await readBoundedResponseText(resp, 8 * 1024).catch(() => "")).slice(0, 300)}`);
  return readBoundedResponseJson(resp, 2 * 1024 * 1024);
}

/** Normalise a free-text name into a DNS-safe slug. */
function toSlug(input: string): string {
  return (input || "shop").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shop";
}

export const storefront: PrebuiltScript = {
  name: "storefront",
  description:
    "Provision a Naelao-hosted storefront at {slug}.naelao.com (multitenant CF Pages + Worker) " +
    "and optionally attach the owner's custom domain via Cloudflare for SaaS.",
  domain: "api",
  requires_tier: 2,
  paramHints: {
    "storefront.provision": "slug (or name, slugified automatically) is optional — defaults to 'shop'. This is the {slug}.naelao.com handle, not a domain.",
    "storefront.set_custom_domain": "domain is required, e.g. 'shop.example.com'. A SEPARATE operation from storefront.provision — calling provision again after this would drop the custom domain, never re-provision to change a domain.",
  },
  operations: {
    "storefront.provision": (a, c) =>
      bizService(c, "POST", { kind: "storefront", slug: toSlug(String(a["slug"] ?? a["name"] ?? "shop")) }),
    "storefront.set_custom_domain": (a, c) =>
      // Custom domains are a separate business_services row (kind='custom_domain'); this is what
      // triggers the Cloudflare-for-SaaS apply (createCustomHostname + TXT DCV) on the spaces
      // worker. Posting kind='storefront' here would drop the domain and allocate a handle.
      bizService(c, "POST", { kind: "custom_domain", custom_domain: String(a["domain"] ?? "") }),
    "storefront.status": (_a, c) => bizService(c, "GET"),
  },
};
