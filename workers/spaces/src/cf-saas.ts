/**
 * Cloudflare for SaaS — custom hostname provisioning (confirmed against CF API docs:
 * /api/resources/custom_hostnames/methods/create). When a builder attaches their own domain
 * to a Naelao-hosted storefront, we add it as a custom hostname on Naelao's SaaS zone and CF
 * issues a DV certificate. The customer points their domain (CNAME) at the fallback origin
 * (the portal Worker); traffic for the hostname then routes to us and we serve their store.
 *
 * TXT DCV is used so the certificate can be issued before the customer changes DNS (per CF's
 * guidance). The POST response's ssl.validation_records may be empty briefly, so callers
 * should poll GET after a short delay — surfaced via getCustomHostname().
 *
 * Pure module (no cloudflare:workers import) so it's unit-testable. All calls are no-ops
 * unless CF_API_TOKEN + CF_SAAS_ZONE_ID are configured (deploy-time secrets).
 */

const CF_API = "https://api.cloudflare.com/client/v4";

export interface CfSaasConfig {
  apiToken: string;
  zoneId: string;
}

export interface CustomHostnameResult {
  id: string;
  hostname: string;
  status: string; // pending | active | ...
  ssl_status: string; // pending_validation | active | ...
  /** DCV records the owner must add to their DNS (CNAME for routing + TXT for validation). */
  validation_records: Array<{ txt_name?: string; txt_value?: string; http_url?: string; http_body?: string }>;
}

interface CfCustomHostnameResponse {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: {
    id: string;
    hostname: string;
    status: string;
    ssl?: { status?: string; validation_records?: Array<Record<string, string>> };
  };
}

function parse(json: CfCustomHostnameResponse): CustomHostnameResult {
  if (!json.success || !json.result) {
    throw new Error(`Cloudflare for SaaS error: ${json.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  const r = json.result;
  return {
    id: r.id,
    hostname: r.hostname,
    status: r.status,
    ssl_status: r.ssl?.status ?? "pending_validation",
    validation_records: (r.ssl?.validation_records ?? []) as CustomHostnameResult["validation_records"],
  };
}

/** Add a custom hostname (TXT DCV). Returns the hostname id + any validation records. */
export async function createCustomHostname(
  cfg: CfSaasConfig,
  hostname: string
): Promise<CustomHostnameResult> {
  const resp = await fetch(`${CF_API}/zones/${cfg.zoneId}/custom_hostnames`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      hostname,
      ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
    }),
  });
  return parse(await resp.json<CfCustomHostnameResponse>());
}

/** Poll a custom hostname for its validation records + activation status. */
export async function getCustomHostname(
  cfg: CfSaasConfig,
  hostnameId: string
): Promise<CustomHostnameResult> {
  const resp = await fetch(`${CF_API}/zones/${cfg.zoneId}/custom_hostnames/${hostnameId}`, {
    headers: { Authorization: `Bearer ${cfg.apiToken}` },
  });
  return parse(await resp.json<CfCustomHostnameResponse>());
}

/** Resolve config from env; null when the deploy-time secrets are not present (dev path). */
export function cfSaasConfig(env: { CF_API_TOKEN?: string; CF_SAAS_ZONE_ID?: string }): CfSaasConfig | null {
  if (!env.CF_API_TOKEN || !env.CF_SAAS_ZONE_ID) return null;
  return { apiToken: env.CF_API_TOKEN, zoneId: env.CF_SAAS_ZONE_ID };
}
