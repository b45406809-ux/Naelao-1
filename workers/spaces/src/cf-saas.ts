import { readBoundedResponseJson } from "@naelao/http";

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
const CF_REQUEST_TIMEOUT_MS = 10_000;

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
  if (typeof r.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(r.id) || typeof r.hostname !== "string" || typeof r.status !== "string") {
    throw new Error("Cloudflare for SaaS returned an invalid hostname record");
  }
  const hostname = normalizeCustomHostname(r.hostname);
  const records = (r.ssl?.validation_records ?? []).slice(0, 20).flatMap((record) => {
    const clean: NonNullable<CustomHostnameResult["validation_records"][number]> = {};
    for (const key of ["txt_name", "txt_value", "http_url", "http_body"] as const) {
      const value = record[key];
      if (typeof value === "string") clean[key] = value.slice(0, 2048);
    }
    return [clean];
  });
  return {
    id: r.id,
    hostname,
    status: r.status.slice(0, 64),
    ssl_status: r.ssl?.status ?? "pending_validation",
    validation_records: records,
  };
}

/** Normalize and reject values that are not public DNS hostnames before persisting or sending
 * them to Cloudflare. IDNs must be supplied in their ASCII punycode form. */
export function normalizeCustomHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253 || hostname.includes("*") || hostname.includes("/")) {
    throw new Error("Invalid custom hostname");
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) throw new Error("Custom hostname must be a DNS name, not an IP address");
  const labels = hostname.split(".");
  if (labels.length < 2 || labels.some((label) =>
    label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )) throw new Error("Invalid custom hostname");
  // A tenant must not claim Naelao's own serving domain or any hostname beneath it.
  if (hostname === "naelao.com" || hostname.endsWith(".naelao.com")) {
    throw new Error("Custom hostname is within a reserved Naelao domain");
  }
  return hostname;
}

async function readResponse(resp: Response): Promise<CfCustomHostnameResponse> {
  if (!resp.ok) throw new Error(`Cloudflare for SaaS request failed (${resp.status})`);
  return readBoundedResponseJson<CfCustomHostnameResponse>(resp, 64 * 1024);
}

/** Add a custom hostname (TXT DCV). Returns the hostname id + any validation records. */
export async function createCustomHostname(
  cfg: CfSaasConfig,
  hostname: string
): Promise<CustomHostnameResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(cfg.zoneId)) throw new Error("Invalid Cloudflare SaaS zone ID");
  const normalizedHostname = normalizeCustomHostname(hostname);
  const resp = await fetch(`${CF_API}/zones/${cfg.zoneId}/custom_hostnames`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      hostname: normalizedHostname,
      ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
    }),
    signal: AbortSignal.timeout(CF_REQUEST_TIMEOUT_MS),
  });
  return parse(await readResponse(resp));
}

/** Poll a custom hostname for its validation records + activation status. */
export async function getCustomHostname(
  cfg: CfSaasConfig,
  hostnameId: string
): Promise<CustomHostnameResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(cfg.zoneId) || !/^[A-Za-z0-9_-]{1,128}$/.test(hostnameId)) {
    throw new Error("Invalid Cloudflare custom hostname reference");
  }
  const resp = await fetch(`${CF_API}/zones/${cfg.zoneId}/custom_hostnames/${hostnameId}`, {
    headers: { Authorization: `Bearer ${cfg.apiToken}` },
    signal: AbortSignal.timeout(CF_REQUEST_TIMEOUT_MS),
  });
  return parse(await readResponse(resp));
}

/** Delete a hostname during tenant data erasure. Missing provider records are already erased. */
export async function deleteCustomHostname(cfg: CfSaasConfig, hostnameId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(cfg.zoneId) || !/^[A-Za-z0-9_-]{1,128}$/.test(hostnameId)) {
    throw new Error("Invalid Cloudflare custom hostname reference");
  }
  const resp = await fetch(`${CF_API}/zones/${cfg.zoneId}/custom_hostnames/${hostnameId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${cfg.apiToken}` },
    signal: AbortSignal.timeout(CF_REQUEST_TIMEOUT_MS),
  });
  if (resp.status === 404) return;
  if (!resp.ok) throw new Error(`Cloudflare for SaaS delete failed (${resp.status})`);
  const body = await readBoundedResponseJson<{ success: boolean }>(resp, 64 * 1024);
  if (body.success !== true) throw new Error("Cloudflare for SaaS rejected hostname deletion");
}

/** Resolve config from env; null when the deploy-time secrets are not present (dev path). */
export function cfSaasConfig(env: { CF_API_TOKEN?: string; CF_SAAS_ZONE_ID?: string }): CfSaasConfig | null {
  if (!env.CF_API_TOKEN || !env.CF_SAAS_ZONE_ID) return null;
  return { apiToken: env.CF_API_TOKEN, zoneId: env.CF_SAAS_ZONE_ID };
}
