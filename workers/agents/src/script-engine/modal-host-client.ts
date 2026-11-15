import { signHmac } from "@naelao/crypto";
import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { ModalSandboxClient } from "./modal-lifecycle.js";

export type ModalHostScope = { tenantId: string; spaceId: string; projectId: string };

export function createModalHostClient(input: {
  hostUrl: string;
  platformSecret: string;
  scope: ModalHostScope;
  operationId: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}): ModalSandboxClient {
  let base: URL;
  try { base = new URL(input.hostUrl); }
  catch { throw new Error("modal_host_configuration_invalid"); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash
    || !input.platformSecret || !/^[A-Za-z0-9:._-]{1,200}$/.test(input.operationId)
    || !/^[A-Za-z0-9:._-]{1,160}$/.test(input.idempotencyKey)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.scope.tenantId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.scope.spaceId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.scope.projectId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.scope.projectId)) {
    throw new Error("modal_host_configuration_invalid");
  }
  const fetcher = input.fetchImpl ?? fetch;
  async function request(path: string, method: "GET" | "POST" | "DELETE", body?: Record<string, unknown>) {
    const timestamp = Date.now().toString();
    const bodyText = body ? JSON.stringify({ scope: input.scope, ...body }) : "";
    const bodyHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const pathAndQuery = new URL(path, base);
    const signaturePayload = JSON.stringify([
      "modal-request-v1", timestamp, method, pathAndQuery.pathname + pathAndQuery.search, input.scope.tenantId, input.scope.spaceId,
      input.scope.projectId, input.operationId, input.idempotencyKey, bodyHash,
    ]);
    const response = await fetcher(new Request(new URL(path, base), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        "x-naelao-tenant-id": input.scope.tenantId,
        "x-naelao-internal-token": await mintInternalToken(input.platformSecret, input.scope.tenantId),
        "x-naelao-space-id": input.scope.spaceId,
        "x-naelao-project-id": input.scope.projectId,
        "x-naelao-modal-request-signature": `t=${timestamp},v1=${await signHmac(signaturePayload, input.platformSecret)}`,
        "x-naelao-operation-id": input.operationId,
        "idempotency-key": input.idempotencyKey,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: bodyText } : {}),
    }));
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`modal_host_${response.status >= 500 ? "unavailable" : "request_rejected"}`);
    }
    return response;
  }
  return {
    async create(spec) {
      const response = await request("/v1/sandboxes", "POST", { spec });
      const result = await readBoundedResponseJson<{ id?: unknown; state?: unknown }>(response, 8 * 1024);
      if (typeof result.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result.id))
        throw new Error("modal_host_receipt_invalid");
      if (result.state !== "running" && result.state !== "stopped") throw new Error("modal_host_receipt_invalid");
      return { id: result.id, state: result.state };
    },
    async inspect(providerId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(providerId)) throw new Error("modal_provider_id_invalid");
      const response = await request(`/v1/sandboxes/${encodeURIComponent(providerId)}`, "GET");
      const result = await readBoundedResponseJson<{ state?: unknown; actualCredits?: unknown }>(response, 8 * 1024);
      if (!(result.state === "running" || result.state === "stopped" || result.state === "unknown")
        || result.actualCredits !== undefined && (!Number.isSafeInteger(result.actualCredits) || Number(result.actualCredits) < 0))
        throw new Error("modal_host_receipt_invalid");
      return { state: result.state, ...(result.actualCredits === undefined ? {} : { actualCredits: Number(result.actualCredits) }) };
    },
    async terminate(providerId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(providerId)) throw new Error("modal_provider_id_invalid");
      const response = await request(`/v1/sandboxes/${encodeURIComponent(providerId)}`, "DELETE");
      await response.body?.cancel().catch(() => undefined);
    },
  };
}
