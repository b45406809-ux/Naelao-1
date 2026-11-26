// MS-50 (MS-48 item 5): read-only AgentMail inventory listing for the reconciliation sweep. Behind MANAGED_RECONCILIATION_ENABLED
// (the adapter is only registered by the sweep). Evidence: docs/research/agentmail-inventory-evidence.md (public docs, not verified live).
//
// - Org-level `GET /v0/inboxes?limit=100[&page_token=…]` with the platform key (`AGENTMAIL_API_KEY`, naelao_managed accounts only),
//   once per configured host in use (us / eu), following `next_page_token` until it is absent. The page cap and truncation handling
//   are the sweep's (MAX_INVENTORY_PAGES): a cap hit writes and resolves nothing.
// - The cursor carries the host and the opaque token (`us:<token>`; an empty token starts a host). A missing `status` is active.
// - Only GET is ever issued. Nothing is deleted, deactivated or changed upstream.
import { readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../../index.js";
import { ProviderAdapterError, capabilityUnsupported, type Page, type ProviderAdapterV1, type ProviderResource } from "./contract.js";

export const AGENTMAIL_PROVIDER = "agentmail";
export const AGENTMAIL_SERVICE_ID = "agentmail";
/** Only naelao_managed accounts live in the platform organization this key lists; user_connected inboxes are in their owners' organizations. */
export const AGENTMAIL_INVENTORY_CONNECTION_MODE = "naelao_managed";
export const AGENTMAIL_INVENTORY_PAGE_SIZE = 100;
const API = "https://api.agentmail.to/v0";
const EU_API = "https://api.agentmail.eu/v0";
const CURSOR = /^(us|eu):([^\s]{0,2048})$/;

export type AgentMailInventoryEnv = Pick<AgentsEnv, "PLATFORM_DB" | "AGENTMAIL_API_KEY" | "AGENTMAIL_API_BASE_URL" | "AGENTMAIL_API_BASE_URL_EU" | "AGENTMAIL_REGION">;

export function createAgentMailInventoryAdapter(env: AgentMailInventoryEnv, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): ProviderAdapterV1 {
  let hosts: Promise<Array<{ region: "us" | "eu"; base: string }>> | undefined;
  /** Hosts in use: regions of managed AgentMail registry rows (null = us) plus the configured region (default us), deduplicated by base URL. */
  const hostsInUse = () => hosts ??= (async () => {
    const rows = (await env.PLATFORM_DB.prepare("SELECT DISTINCT region FROM managed_service_accounts WHERE provider=? AND service_id=? AND connection_mode=?")
      .bind(AGENTMAIL_PROVIDER, AGENTMAIL_SERVICE_ID, AGENTMAIL_INVENTORY_CONNECTION_MODE).all<{ region: string | null }>()).results;
    const regions = new Set<string>(rows.map(row => row.region ?? "us"));
    if (env.AGENTMAIL_REGION) regions.add(env.AGENTMAIL_REGION);
    if (!regions.size) regions.add("us"); // nothing in use yet: still list the default host so strays are seen
    const out: Array<{ region: "us" | "eu"; base: string }> = [];
    for (const region of ["us", "eu"] as const) {
      if (!regions.has(region)) continue;
      const base = (region === "eu" ? env.AGENTMAIL_API_BASE_URL_EU ?? EU_API : env.AGENTMAIL_API_BASE_URL ?? API).replace(/\/$/, "");
      if (!out.some(host => host.base === base)) out.push({ region, base });
    }
    for (const region of regions) if (region !== "us" && region !== "eu") throw new ProviderAdapterError("agentmail_provider_region_unsupported");
    return out;
  })();

  return {
    provider: AGENTMAIL_PROVIDER,
    capabilities: () => [],
    lookup: async () => { throw capabilityUnsupported("lookup"); },
    execute: async req => { throw capabilityUnsupported(String(req.operation)); },

    async listUpstreamResources(cursor?: string): Promise<Page<ProviderResource>> {
      const key = env.AGENTMAIL_API_KEY;
      if (!key) throw new ProviderAdapterError("agentmail_inventory_not_configured");
      const all = await hostsInUse();
      let index = 0, token = "";
      if (cursor !== undefined) {
        const match = CURSOR.exec(cursor);
        if (!match) throw new ProviderAdapterError("invalid_cursor");
        index = all.findIndex(host => host.region === match[1]);
        if (index < 0) throw new ProviderAdapterError("invalid_cursor");
        token = match[2]!;
      }
      const host = all[index];
      if (!host) return { items: [] };
      const query = `limit=${AGENTMAIL_INVENTORY_PAGE_SIZE}${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
      const response = await fetchImpl(`${host.base}/inboxes?${query}`, {
        method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new ProviderAdapterError("agentmail_provider_error", String(response.status));
      const body = await readBoundedResponseJson<{ inboxes?: unknown; next_page_token?: unknown }>(response, 2 * 1024 * 1024);
      if (!Array.isArray(body?.inboxes)) throw new ProviderAdapterError("invalid_inventory_response");
      const items: ProviderResource[] = [];
      for (const inbox of body.inboxes as Array<Record<string, unknown>>) {
        if (typeof inbox?.inbox_id !== "string" || !inbox.inbox_id) throw new ProviderAdapterError("invalid_inventory_response");
        items.push({
          provider: AGENTMAIL_PROVIDER, service_id: AGENTMAIL_SERVICE_ID, resource_type: "inbox", provider_resource_ref: inbox.inbox_id,
          // Missing status means active (docs); a deactivated inbox is not usable upstream.
          status: inbox.status === "deactivated" ? "deleted" : "active",
          ...(typeof inbox.email === "string" && inbox.email ? { address: inbox.email } : {}),
        });
      }
      const next = typeof body.next_page_token === "string" && body.next_page_token ? `${host.region}:${body.next_page_token}` : all[index + 1] ? `${all[index + 1]!.region}:` : undefined;
      return { items, ...(next ? { next_cursor: next } : {}) };
    },
  };
}
