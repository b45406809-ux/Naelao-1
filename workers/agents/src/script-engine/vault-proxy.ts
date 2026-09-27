import type { VaultFetchOptions } from "@naelao/agent-sdk";
import { scanAndScrubEgress } from "@naelao/security";

export interface VaultProxyOptions {
  credentialsWorker: Fetcher;
  platformSecret: string;
  tenantId: string;
  spaceId: string;
  agentId: string;
  userId?: string;
}

async function credentialToken(secret: string, spaceId: string, agentId: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${spaceId}:${agentId}:${timestamp}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `t=${timestamp},aid=${agentId},v1=${[...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A narrow service-binding facade: neither this object nor its Response contains the secret. */
export function createVaultProxy(options: VaultProxyOptions) {
  return Object.freeze({
    async fetchWithAuth(url: string, init: VaultFetchOptions): Promise<Response> {
      if (!init || typeof init.credentialName !== "string" || !init.credentialName) throw new Error("credentialName is required");
      const dlp = scanAndScrubEgress(init, "redact");
      if (dlp.findings.length) console.warn("[vault-proxy] outbound DLP redaction", dlp.audit);
      const response = await options.credentialsWorker.fetch(new Request(
        `http://credentials/v1/internal/spaces/${encodeURIComponent(options.spaceId)}/outbound`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-tenant-id": options.tenantId,
            "x-naelao-credential-token": await credentialToken(options.platformSecret, options.spaceId, options.agentId),
          },
          body: JSON.stringify({ url, ...dlp.payload, ...(options.userId ? { onBehalfOfUserId: options.userId } : {}) }),
        }
      ));
      if (!response.ok) {
        const message = await response.clone().text();
        throw new Error(`Vault egress failed (${response.status}): ${message.slice(0, 300)}`);
      }
      return response;
    },
  });
}
