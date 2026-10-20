import type { VaultFetchOptions } from "@naelao/agent-sdk";
import { readBoundedResponseText } from "@naelao/http";
import { scanAndScrubEgress } from "@naelao/security";
import { formatTraceparent, generateSpanId, generateTraceId } from "@naelao/tracing";

export interface VaultProxyOptions {
  credentialsWorker: Fetcher;
  platformSecret: string;
  tenantId: string;
  spaceId: string;
  agentId: string;
  userId?: string;
  projectId?: string;
  runId?: string;
  taskId?: string;
}

async function credentialToken(secret: string, tenantId: string, spaceId: string, agentId: string, projectId: string | undefined, run?: { actorId: string; runId: string; taskId?: string; traceId: string; spanId: string }): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const values = [tenantId, spaceId, agentId, ...(projectId ? [projectId] : []), ...(run ? [run.actorId, run.runId, ...(run.taskId ? [run.taskId] : [])] : [])];
  if (!values.every((value) => /^[A-Za-z0-9._:-]{1,160}$/.test(value))) throw new Error("invalid_credential_token_scope");
  const payload = run
    ? `${tenantId}:${spaceId}:${agentId}:${projectId ?? ""}:${run.actorId}:${run.runId}:${run.taskId ?? ""}:${run.traceId}:${run.spanId}:${timestamp}`
    : `${tenantId}:${spaceId}:${agentId}:${projectId ?? ""}:${timestamp}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  const hex = [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return run
    ? `t=${timestamp},aid=${agentId},tid=${tenantId}${projectId ? `,pid=${projectId}` : ""},uid=${run.actorId},rid=${run.runId}${run.taskId ? `,task=${run.taskId}` : ""},tr=${run.traceId},sp=${run.spanId},v4=${hex}`
    : `t=${timestamp},aid=${agentId},tid=${tenantId}${projectId ? `,pid=${projectId}` : ""},v3=${hex}`;
}

/** A narrow service-binding facade: neither this object nor its Response contains the secret. */
export function createVaultProxy(options: VaultProxyOptions) {
  const traceId = generateTraceId();
  return Object.freeze({
    async fetchWithAuth(url: string, init: VaultFetchOptions): Promise<Response> {
      if (!init || typeof init.credentialName !== "string" || !init.credentialName) throw new Error("credentialName is required");
      const dlp = scanAndScrubEgress(init, "block");
      if (dlp.findings.length) console.warn("[vault-proxy] outbound payload blocked by DLP rules", dlp.audit);
      const spanId = generateSpanId();
      const runContext = options.runId ? {
        actorId: options.userId ?? options.agentId,
        runId: options.runId,
        ...(options.taskId ? { taskId: options.taskId } : {}),
        traceId,
        spanId,
      } : undefined;
      const response = await options.credentialsWorker.fetch(new Request(
        `http://credentials/v1/internal/spaces/${encodeURIComponent(options.spaceId)}/outbound`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-tenant-id": options.tenantId,
            "x-naelao-credential-token": await credentialToken(options.platformSecret, options.tenantId, options.spaceId, options.agentId, options.projectId, runContext),
            "traceparent": formatTraceparent(traceId, spanId),
          },
          body: JSON.stringify({ url, ...dlp.payload, ...(options.userId ? { onBehalfOfUserId: options.userId } : {}), ...(options.projectId ? { projectId: options.projectId } : {}) }),
        }
      ));
      if (!response.ok) {
        const message = (await readBoundedResponseText(response, 8 * 1024).catch(() => "")).slice(0, 300);
        throw new Error(`Vault egress failed (${response.status}): ${message}`);
      }
      return response;
    },
  });
}
