import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type ModalHostScope = { tenantId: string; spaceId: string; projectId: string };
export type ModalHostSpec = { image: string; cpu: number; memoryMb: number; region: string; timeoutSeconds: number; gpu: string };
export type ModalHostReceipt = { id: string; state: "running" | "stopped" };

export interface ModalHostProvider {
  findByName(name: string): Promise<ModalHostReceipt | null>;
  create(name: string, spec: ModalHostSpec): Promise<ModalHostReceipt>;
  inspect(id: string): Promise<{ state: "running" | "stopped" | "unknown" }>;
  terminate(id: string): Promise<void>;
}

export interface ModalHostConfig {
  enabled: boolean;
  betaAccepted: boolean;
  privateGrpcAccepted: boolean;
  platformSecret: string;
  image: string;
  allowedRegions: string[];
  allowedGpus: string[];
  maxCpu: number;
  maxMemoryMb: number;
  maxTimeoutSeconds: number;
}

const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const IMAGE_PIN = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_BODY_BYTES = 16 * 1024;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function verifyInternalToken(header: string | null, tenantId: string, secret: string, now: number): boolean {
  if (!header || header.length > 128 || !secret) return false;
  const parts = header.split(",");
  if (parts.length !== 2) return false;
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2) ?? "";
  const signature = parts.find((part) => part.startsWith("v1="))?.slice(3) ?? "";
  if (!/^\d{1,16}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const sentAt = Number(timestamp);
  if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > 60_000) return false;
  const expected = createHmac("sha256", secret).update(`internal:${tenantId}:${timestamp}`).digest();
  const supplied = Buffer.from(signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function verifyScopeToken(header: string | null, scope: ModalHostScope, secret: string, now: number): boolean {
  if (!header || header.length > 128 || !secret) return false;
  const parts = header.split(",");
  if (parts.length !== 2) return false;
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2) ?? "";
  const signature = parts.find((part) => part.startsWith("v1="))?.slice(3) ?? "";
  if (!/^\d{1,16}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const sentAt = Number(timestamp);
  if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > 60_000) return false;
  const payload = JSON.stringify(["modal-scope-v1", scope.tenantId, scope.spaceId, scope.projectId, timestamp]);
  const expected = createHmac("sha256", secret).update(payload).digest();
  const supplied = Buffer.from(signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function boundedJson(request: Request): Promise<Record<string, unknown> | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch { return null; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function validScope(value: unknown): value is ModalHostScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return Object.keys(scope).sort().join(",") === "projectId,spaceId,tenantId"
    && typeof scope.tenantId === "string" && SCOPE_ID.test(scope.tenantId)
    && typeof scope.spaceId === "string" && SCOPE_ID.test(scope.spaceId)
    && typeof scope.projectId === "string" && SCOPE_ID.test(scope.projectId);
}

function validSpec(value: unknown, config: ModalHostConfig): value is ModalHostSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const spec = value as Record<string, unknown>;
  const allowedKeys = new Set(["image", "cpu", "memoryMb", "region", "timeoutSeconds", "gpu"]);
  if (Object.keys(spec).some((key) => !allowedKeys.has(key))) return false;
  return spec.image === config.image && typeof spec.image === "string" && IMAGE_PIN.test(spec.image)
    && typeof spec.cpu === "number" && Number.isFinite(spec.cpu) && spec.cpu >= 0.125 && spec.cpu <= config.maxCpu
    && Number.isSafeInteger(spec.memoryMb) && Number(spec.memoryMb) >= 128 && Number(spec.memoryMb) <= config.maxMemoryMb
    && typeof spec.region === "string" && config.allowedRegions.includes(spec.region)
    && Number.isSafeInteger(spec.timeoutSeconds) && Number(spec.timeoutSeconds) >= 1 && Number(spec.timeoutSeconds) <= config.maxTimeoutSeconds
    && typeof spec.gpu === "string" && config.allowedGpus.includes(spec.gpu);
}

function operationName(scope: ModalHostScope, operationId: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}\0${operationId}\0${idempotencyKey}`).digest("hex");
  return `naelao-${digest.slice(0, 48)}`;
}

function validReceipt(value: unknown): value is ModalHostReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.id === "string" && PROVIDER_ID.test(receipt.id)
    && (receipt.state === "running" || receipt.state === "stopped");
}

/** Web Request adapter for a separately hosted Node 22+ process. No credentials cross this boundary. */
export function createModalHostHandler(config: ModalHostConfig, provider: ModalHostProvider, now = () => Date.now()) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json(200, { service: "modal-host", enabled: config.enabled });
    if (!(config.enabled && config.betaAccepted && config.privateGrpcAccepted)) return json(503, { error_code: "modal_host_rollout_disabled" });

    const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
    if (!SCOPE_ID.test(tenantId) || !verifyInternalToken(request.headers.get("x-naelao-internal-token"), tenantId, config.platformSecret, now()))
      return json(403, { error_code: "forbidden" });
    const scope: ModalHostScope = {
      tenantId,
      spaceId: request.headers.get("x-naelao-space-id") ?? "",
      projectId: request.headers.get("x-naelao-project-id") ?? "",
    };
    if (!validScope(scope) || !verifyScopeToken(request.headers.get("x-naelao-modal-scope-token"), scope, config.platformSecret, now()))
      return json(403, { error_code: "forbidden" });
    const operationId = request.headers.get("x-naelao-operation-id") ?? "";
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY.test(operationId) || !IDEMPOTENCY.test(idempotencyKey)) return json(400, { error_code: "modal_operation_identity_invalid" });

    if (request.method === "POST" && url.pathname === "/v1/sandboxes") {
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json(415, { error_code: "content_type_invalid" });
      const body = await boundedJson(request);
      if (!body || !validScope(body.scope) || body.scope.tenantId !== tenantId
        || body.scope.spaceId !== scope.spaceId || body.scope.projectId !== scope.projectId || !validSpec(body.spec, config))
        return json(400, { error_code: "modal_sandbox_request_invalid" });
      const name = operationName(scope, operationId, idempotencyKey);
      try {
        const existing = await provider.findByName(name);
        const sandbox = existing ?? await provider.create(name, body.spec);
        if (!validReceipt(sandbox)) return json(502, { error_code: "modal_host_receipt_invalid" });
        return json(200, sandbox);
      } catch {
        // A create response can be lost after Modal accepts the request. Recover by deterministic name;
        // never issue a second sandbox without first performing this read-only lookup.
        try {
          const recovered = await provider.findByName(name);
          if (recovered) return json(200, recovered);
        } catch { /* preserve the uncertainty below */ }
        return json(503, { error_code: "modal_provider_outcome_unknown" });
      }
    }

    const match = /^\/v1\/sandboxes\/([^/]{1,768})$/.exec(url.pathname);
    if (!match) return json(404, { error_code: "not_found" });
    let providerId: string;
    try { providerId = decodeURIComponent(match[1]!); }
    catch { return json(400, { error_code: "modal_provider_id_invalid" }); }
    if (!PROVIDER_ID.test(providerId)) return json(400, { error_code: "modal_provider_id_invalid" });
    if (request.method === "GET") {
      try {
        // Never trust a caller-supplied provider ID as proof of tenant ownership. Resolve the
        // deterministic name under the signed project and operation scope before reading state.
        const owned = await provider.findByName(operationName(scope, operationId, idempotencyKey));
        if (!owned || owned.id !== providerId) return json(404, { error_code: "not_found" });
        const receipt = await provider.inspect(providerId);
        if (!(receipt.state === "running" || receipt.state === "stopped" || receipt.state === "unknown"))
          return json(502, { error_code: "modal_host_receipt_invalid" });
        return json(200, receipt);
      }
      catch { return json(503, { error_code: "modal_provider_unavailable" }); }
    }
    if (request.method === "DELETE") {
      try {
        const owned = await provider.findByName(operationName(scope, operationId, idempotencyKey));
        if (!owned || owned.id !== providerId) return json(404, { error_code: "not_found" });
        await provider.terminate(providerId);
        return new Response(null, { status: 204 });
      }
      catch { return json(503, { error_code: "modal_provider_outcome_unknown" }); }
    }
    return json(405, { error_code: "method_not_allowed" });
  };
}
