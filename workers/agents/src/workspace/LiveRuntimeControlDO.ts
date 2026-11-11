import { DurableObject } from "cloudflare:workers";
import { mintInternalToken, readBoundedRequestText, readBoundedResponseJson, verifyInternalToken } from "@naelao/http";
import {
  sha256Hex,
  validateWorkspaceBranch,
  validateWorkspaceContentType,
  validateWorkspacePath,
  validateWorkspaceScope,
} from "./workspace-contract.js";

interface Env {
  PLATFORM_SECRET: string;
  /** Implemented only by a runtime adapter that can attest its own operation journal and flush. */
  LIVE_RUNTIME_AGENT?: Fetcher;
  ANALYTICS?: AnalyticsEngineDataset;
}

type OperationKind = "sync" | "prepare" | "abort" | "activate" | "ack";
type OperationState = "dispatching" | "complete" | "rejected" | "unknown";
interface OperationRecord {
  operationId: string;
  kind: OperationKind;
  tenantId: string;
  sessionId: string;
  runtimeId: string;
  allocationGeneration: number;
  fence: number;
  nonce?: string;
  requestHash: string;
  state: OperationState;
  updatedAt: number;
  result?: Record<string, unknown>;
  errorCode?: string;
  responseStatus?: number;
  /** Large deltas are deliberately not copied into Durable Object storage. */
  resultStored?: boolean;
}

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RUNTIME_RESPONSE_BYTES = 30 * 1024 * 1024;
const MAX_CHANGES = 100;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const SESSION = /^ws_[0-9a-f-]{36}$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundOperation(value: Record<string, unknown>): boolean {
  return typeof value.sessionId === "string" && SESSION.test(value.sessionId) &&
    typeof value.runtimeId === "string" && ID.test(value.runtimeId) &&
    Number.isSafeInteger(value.allocationGeneration) && Number(value.allocationGeneration) > 0 &&
    Number.isSafeInteger(value.fence) && Number(value.fence) >= 0;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch { return null; }
}

function validSyncResponse(result: Record<string, unknown>, input: Record<string, unknown>): boolean {
  if (result.synced !== true || result.nonce !== input.nonce || result.requestId !== input.requestId ||
      result.sessionId !== input.sessionId || result.runtimeId !== input.runtimeId ||
      result.allocationGeneration !== input.allocationGeneration || result.fence !== input.fence ||
      !Array.isArray(result.changes) || result.changes.length > MAX_CHANGES || typeof result.cursor !== "string" || result.cursor.length > 2048) return false;
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const candidate of result.changes) {
    if (!isRecord(candidate) || !validateWorkspacePath(candidate.path) || paths.has(candidate.path as string) ||
        !(candidate.expectedHash === null || (typeof candidate.expectedHash === "string" && HASH.test(candidate.expectedHash))) ||
        !(candidate.contentBase64 === null || typeof candidate.contentBase64 === "string") ||
        (candidate.executable !== undefined && typeof candidate.executable !== "boolean") ||
        (candidate.contentType !== undefined && !validateWorkspaceContentType(candidate.contentType))) return false;
    paths.add(candidate.path as string);
    if (typeof candidate.contentBase64 === "string") {
      const bytes = decodeBase64(candidate.contentBase64);
      if (!bytes || bytes.byteLength > MAX_FILE_BYTES) return false;
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) return false;
    }
  }
  return true;
}

function validPrepareResponse(result: Record<string, unknown>, input: Record<string, unknown>): boolean {
  const receipt = result.receipt;
  if (result.prepared !== true || !isRecord(receipt)) return false;
  return typeof receipt.id === "string" && ID.test(receipt.id) && receipt.nonce === input.nonce &&
    receipt.sessionId === input.sessionId && receipt.runtimeId === input.runtimeId &&
    receipt.allocationGeneration === input.allocationGeneration && receipt.fence === input.fence &&
    Number.isSafeInteger(receipt.revision) && Number(receipt.revision) >= 0 &&
    receipt.writeAdmissionStopped === true && receipt.inFlightDrained === true && receipt.filesystemFlushed === true &&
    typeof receipt.flushMethod === "string" && receipt.flushMethod.length > 0 && receipt.flushMethod.length <= 80 &&
    typeof receipt.flushCompletedAt === "number" && Number.isFinite(receipt.flushCompletedAt) &&
    receipt.flushCompletedAt <= Date.now() + 30_000 && Date.now() - receipt.flushCompletedAt <= 30_000;
}

function validActivateResponse(result: Record<string, unknown>, input: Record<string, unknown>): boolean {
  return result.activated === true && result.nonce === input.nonce && result.sessionId === input.sessionId &&
    result.runtimeId === input.runtimeId && result.allocationGeneration === input.allocationGeneration &&
    result.fence === input.fence && result.revision === input.revision;
}

function validSimpleResponse(kind: OperationKind, result: Record<string, unknown>, input: Record<string, unknown>): boolean {
  if (kind === "sync") return validSyncResponse(result, input);
  if (kind === "prepare") return validPrepareResponse(result, input);
  if (kind === "activate") return validActivateResponse(result, input);
  if (kind === "ack") return result.acknowledged === true;
  if (kind === "abort") return result.aborted === true && result.nonce === input.nonce && result.sessionId === input.sessionId &&
    result.runtimeId === input.runtimeId && result.allocationGeneration === input.allocationGeneration && result.fence === input.fence;
  return false;
}

function operationKey(operationId: string): string { return `operation:${operationId}`; }

/**
 * Durable service boundary for the coordinator's live writer protocol. It never synthesizes
 * filesystem evidence. A trusted runtime adapter must return a scoped receipt and keep a durable
 * operation journal so lost responses can be reconciled with a read-only status request.
 */
export class LiveRuntimeControlDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
    if (!tenantId || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, tenantId, this.env.PLATFORM_SECRET)) {
      return json({ error_code: "forbidden" }, 403);
    }
    if (request.method !== "POST") return json({ error_code: "method_not_allowed" }, 405);
    let raw: string;
    try { raw = await readBoundedRequestText(request, MAX_REQUEST_BYTES); }
    catch { return json({ error_code: "request_too_large" }, 413); }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return json({ error_code: "invalid_json" }, 400); }
    if (!isRecord(body) || !validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId) return json({ error_code: "invalid_runtime_scope" }, 400);

    const path = new URL(request.url).pathname;
    const scopeHash = await sha256Hex(new TextEncoder().encode(stableJson(body.scope)));
    const boundScope = await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<string>("runtime_scope_hash");
      if (current && current !== scopeHash) return false;
      if (!current) await tx.put("runtime_scope_hash", scopeHash);
      return true;
    });
    if (!boundScope) return json({ error_code: "runtime_scope_mismatch" }, 409);
    if (path === "/internal/v1/project/erase") {
      if (body.confirm !== true) return json({ error_code: "erasure_confirmation_required" }, 400);
      await this.ctx.storage.transaction(async (tx) => {
        if (!await tx.get<boolean>("erased")) await tx.put("erased", { at: Date.now(), scopeHash });
      });
      return json({ erased: true, runtimeStop: "not_proven", providerDeletion: "tracked_separately" });
    }
    if (await this.ctx.storage.get("erased")) return json({ error_code: "runtime_scope_erased" }, 410);
    if (path === "/internal/v1/operations/reconcile") return this.reconcile(tenantId, body);
    const route = this.route(path);
    if (!route) return json({ error_code: "not_found" }, 404);
    if (route.kind !== "ack" && !isBoundOperation(body)) return json({ error_code: "invalid_runtime_operation" }, 400);
    if (route.kind === "sync" && (typeof body.nonce !== "string" || !ID.test(body.nonce) || typeof body.requestId !== "string" || !ID.test(body.requestId) ||
        !validateWorkspaceBranch(body.branch) || !(body.afterCursor === null || body.afterCursor === undefined ||
          (typeof body.afterCursor === "string" && body.afterCursor.length <= 2048)))) {
      return json({ error_code: "invalid_runtime_operation" }, 400);
    }
    if ((route.kind === "prepare" || route.kind === "abort" || route.kind === "activate") && (typeof body.nonce !== "string" || !ID.test(body.nonce))) {
      return json({ error_code: "invalid_runtime_operation" }, 400);
    }
    if (route.kind === "ack" && (typeof body.requestId !== "string" || !ID.test(body.requestId) || !isBoundOperation(body) ||
        !(body.revision === null || Number.isSafeInteger(body.revision)) || !Number.isFinite(body.elapsedMs) || Number(body.elapsedMs) < 0)) {
      return json({ error_code: "invalid_runtime_ack" }, 400);
    }
    const operationId = this.getOperationId(route.kind, body);
    const hashInput = { ...body };
    // The coordinator mints a fresh transport nonce when it retries a durable sync request.
    // The requestId and all generation/fence/cursor fields still bind the same operation.
    if (route.kind === "sync") delete hashInput.nonce;
    // Durations and coalescing counts can change when the coordinator redelivers its receipt.
    // The idempotency identity remains the scoped request and the canonical publication result.
    if (route.kind === "ack") {
      for (const key of Object.keys(hashInput)) {
        if (!["scope", "requestId", "sessionId", "runtimeId", "allocationGeneration", "fence", "revision", "publication"].includes(key)) delete hashInput[key];
      }
    }
    const requestHash = await sha256Hex(new TextEncoder().encode(stableJson(hashInput)));
    const key = operationKey(operationId);
    const handlePrior = async (current: OperationRecord): Promise<Response> => {
      if (current.tenantId !== tenantId || current.requestHash !== requestHash) return json({ error_code: "runtime_operation_conflict" }, 409);
      if (current.state === "complete" && current.result) return this.responseFor(route.kind, current.result, body);
      if (current.state === "rejected") return json({ error_code: current.errorCode ?? "runtime_operation_rejected" }, current.responseStatus ?? 409);
      return this.reconcileRecord(current, body);
    };
    const current = await this.ctx.storage.get<OperationRecord>(key);
    if (current) return handlePrior(current);
    if (!this.env.LIVE_RUNTIME_AGENT && route.kind !== "ack") return json({ error_code: "runtime_adapter_unavailable", outcome: "not_dispatched" }, 503);
    const record: OperationRecord = {
      operationId, kind: route.kind, tenantId, sessionId: String(body.sessionId), runtimeId: String(body.runtimeId),
      allocationGeneration: Number(body.allocationGeneration), fence: Number(body.fence), requestHash,
      ...(typeof body.nonce === "string" ? { nonce: body.nonce } : {}),
      state: "dispatching", updatedAt: Date.now(),
    };
    // Write before crossing the runtime boundary. If the isolate or response is lost, a retry
    // sees dispatching/unknown and reconciles by operationId instead of re-executing the effect.
    const claimed = await this.ctx.storage.transaction(async (tx) => {
      const prior = await tx.get<OperationRecord>(key);
      if (prior) return { claimed: false as const, prior };
      await tx.put(key, record);
      return { claimed: true as const };
    });
    if (!claimed.claimed) return handlePrior(claimed.prior);
    const result = await this.dispatch(route.path, tenantId, operationId, body);
    if (result.type === "unavailable") {
      await this.ctx.storage.put(operationKey(operationId), { ...record, state: "unknown", updatedAt: Date.now() });
      return json({ error_code: "runtime_operation_outcome_unknown", operationId }, 503);
    }
    if (result.type === "rejected") {
      await this.ctx.storage.put(operationKey(operationId), { ...record, state: "rejected", errorCode: result.errorCode, responseStatus: result.status, updatedAt: Date.now() });
      return json({ error_code: result.errorCode }, result.status);
    }
    if (!validSimpleResponse(route.kind, result.value, body)) {
      await this.ctx.storage.put(operationKey(operationId), { ...record, state: "unknown", updatedAt: Date.now() });
      return json({ error_code: "runtime_operation_outcome_unverified", operationId }, 503);
    }
    const stored = route.kind === "sync" ? { ...record, state: "complete" as const, updatedAt: Date.now(), resultStored: false } :
      { ...record, state: "complete" as const, updatedAt: Date.now(), result: result.value, resultStored: true };
    await this.ctx.storage.put(operationKey(operationId), stored);
    this.writeMetric("completed", route.kind);
    return this.responseFor(route.kind, result.value, body);
  }

  private route(path: string): { kind: OperationKind; path: string } | null {
    const routes: Record<string, { kind: OperationKind; path: string }> = {
      "/internal/v1/checkpoint/sync": { kind: "sync", path: "/internal/v1/checkpoint/sync" },
      "/internal/v1/checkpoint/ack": { kind: "ack", path: "/internal/v1/checkpoint/ack" },
      "/internal/v1/handoff/prepare": { kind: "prepare", path: "/internal/v1/handoff/prepare" },
      "/internal/v1/handoff/abort": { kind: "abort", path: "/internal/v1/handoff/abort" },
      "/internal/v1/handoff/activate": { kind: "activate", path: "/internal/v1/handoff/activate" },
    };
    return routes[path] ?? null;
  }

  private getOperationId(kind: OperationKind, body: Record<string, unknown>): string {
    if (kind === "sync" || kind === "ack") return `${kind}:${String(body.requestId)}`;
    return `${kind}:${String(body.nonce)}`;
  }

  private async dispatch(path: string, tenantId: string, operationId: string, body: Record<string, unknown>): Promise<
    { type: "ok"; value: Record<string, unknown> } | { type: "rejected"; errorCode: string; status: number } | { type: "unavailable" }
  > {
    if (path === "/internal/v1/checkpoint/ack") return { type: "ok", value: { acknowledged: true } };
    if (!this.env.LIVE_RUNTIME_AGENT) return { type: "unavailable" };
    try {
      const response = await this.env.LIVE_RUNTIME_AGENT.fetch(new Request(`https://runtime-agent${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json", "x-naelao-tenant-id": tenantId,
          "x-naelao-internal-token": await mintInternalToken(this.env.PLATFORM_SECRET, tenantId),
          "x-naelao-runtime-operation-id": operationId,
        },
        body: JSON.stringify({ ...body, operationId }),
      }));
      if (response.status >= 500) return { type: "unavailable" };
      if (!response.ok) {
        return { type: "rejected", errorCode: "runtime_operation_rejected", status: response.status };
      }
      const parsed: unknown = await readBoundedResponseJson<unknown>(response, MAX_RUNTIME_RESPONSE_BYTES).catch(() => null);
      return isRecord(parsed) ? { type: "ok", value: parsed } : { type: "unavailable" };
    } catch { return { type: "unavailable" }; }
  }

  private responseFor(kind: OperationKind, result: Record<string, unknown>, input: Record<string, unknown>): Response {
    if (kind !== "sync") return json(result);
    // The same durable checkpoint request may be delivered with a fresh coordinator nonce.
    return json({ ...result, nonce: input.nonce });
  }

  private async reconcile(tenantId: string, body: Record<string, unknown>): Promise<Response> {
    if (typeof body.operationId !== "string" || body.operationId.length > 256) return json({ error_code: "invalid_runtime_operation_id" }, 400);
    const record = await this.ctx.storage.get<OperationRecord>(operationKey(body.operationId));
    if (!record || record.tenantId !== tenantId) return json({ error_code: "runtime_operation_not_found" }, 404);
    const result = await this.reconcileRecord(record, body);
    return result;
  }

  private async reconcileRecord(record: OperationRecord, input: Record<string, unknown>): Promise<Response> {
    if (record.state === "dispatching") {
      const unknown = { ...record, state: "unknown" as const, updatedAt: Date.now() };
      await this.ctx.storage.put(operationKey(record.operationId), unknown);
      this.writeMetric("unknown", record.kind);
      record = unknown;
    }
    if (record.state === "complete" && record.result) return this.responseFor(record.kind, record.result, input);
    if (record.state === "rejected") return json({ error_code: record.errorCode ?? "runtime_operation_rejected" }, record.responseStatus ?? 409);
    if (!this.env.LIVE_RUNTIME_AGENT) return json({ error_code: "runtime_operation_outcome_unknown", operationId: record.operationId }, 503);
    // This endpoint must only read the adapter's durable journal. No operation is replayed here.
    try {
      const response = await this.env.LIVE_RUNTIME_AGENT.fetch(new Request(
        `https://runtime-agent/internal/v1/operations/${encodeURIComponent(record.operationId)}`,
        { headers: { "x-naelao-tenant-id": record.tenantId, "x-naelao-internal-token": await mintInternalToken(this.env.PLATFORM_SECRET, record.tenantId) } },
      ));
      if (!response.ok) return json({ error_code: "runtime_operation_outcome_unknown", operationId: record.operationId }, 503);
      const journal: unknown = await readBoundedResponseJson<unknown>(response, MAX_RUNTIME_RESPONSE_BYTES).catch(() => null);
      if (!isRecord(journal) || journal.operationId !== record.operationId || journal.state !== "complete" || !isRecord(journal.result)) {
        return json({ error_code: "runtime_operation_outcome_unknown", operationId: record.operationId }, 503);
      }
      const validationInput = { ...input, sessionId: record.sessionId, runtimeId: record.runtimeId,
        allocationGeneration: record.allocationGeneration, fence: record.fence,
        ...(record.kind === "sync" ? { requestId: record.operationId.slice("sync:".length) } : {}),
        ...(typeof input.nonce === "string" ? {} : record.nonce ? { nonce: record.nonce } : {}) };
      const result = record.kind === "sync" ? { ...journal.result, nonce: validationInput.nonce } : journal.result;
      if (!validSimpleResponse(record.kind, result, validationInput)) return json({ error_code: "runtime_operation_outcome_unverified", operationId: record.operationId }, 503);
      const updated: OperationRecord = record.kind === "sync"
        ? { ...record, state: "complete", updatedAt: Date.now(), resultStored: false }
        : { ...record, state: "complete", updatedAt: Date.now(), result, resultStored: true };
      await this.ctx.storage.put(operationKey(record.operationId), updated);
      return this.responseFor(record.kind, result, validationInput);
    } catch {
      return json({ error_code: "runtime_operation_outcome_unknown", operationId: record.operationId }, 503);
    }
  }

  private writeMetric(status: "completed" | "unknown", kind: OperationKind): void {
    try {
      this.env.ANALYTICS?.writeDataPoint({
        blobs: [`workspace.live_runtime.operation.${kind}`, status, "phase5", "", "", "", "", "", "workspace-runtime-control-v1"],
        doubles: [1],
      });
    } catch { /* metrics must never change lease or publication decisions */ }
    if (status === "unknown") console.warn("workspace_live_runtime_operation_unknown", { kind });
  }
}
