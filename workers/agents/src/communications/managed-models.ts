import { decryptAuthenticated, deriveKek, encryptAuthenticated } from "@naelao/crypto";
import type { AgentsEnv } from "../index.js";
import type { CommunicationScope } from "./core.js";
import {
  markManagedServiceCreditsUncertain,
  releaseManagedServiceCredits,
  reserveManagedServiceCredits,
  settleManagedServiceCredits,
} from "./managed-service-billing.js";
import { ensureOrganizationPayerMandate, revokeOrganizationPayerMandate } from "./managed-service-ownership.js";

const PROVIDER = "cloudflare";
const SERVICE = "workers-ai";
const OPERATION = "generate-text";
const REGION = "global";
const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROMPT_CHARS = 8_000;
const MAX_RESULT_CHARS = 32_000;

type ModelEntitlement = {
  capability_version: number;
  price_version: string;
  max_credits_per_operation: number;
  credits_per_operation: number | null;
  max_output_tokens: number | null;
  max_operations_per_period: number | null;
};

type ResolvedModelEntitlement = { planTier: string; entitlement: ModelEntitlement };

type OperationRow = {
  operation_id: string;
  quote_id: string | null;
  request_sha256: string;
  model_id: string | null;
  status: string;
  lease_until: string | null;
  price_version: string | null;
  reserved_credits: number | null;
  error_code: string | null;
};

type SavedResult = {
  tenant_id: string;
  space_id: string;
  project_id: string | null;
  requester_user_id: string;
  model_id: string;
  envelope_json: string;
  expires_at: string;
};

export type ManagedModelOperationResult = {
  operationId: string;
  modelId: string;
  status: "complete" | "pending" | "uncertain";
  credits: number;
  priceVersion: string;
  maxOutputTokens: number;
  output?: string;
  errorCode?: string;
  deduplicated?: boolean;
};

export type ManagedModelQuote = {
  quoteId: string;
  provider: typeof PROVIDER;
  serviceId: typeof SERVICE;
  operationName: typeof OPERATION;
  modelId: string;
  region: typeof REGION;
  credits: number;
  creditUnit: "naelao_credit";
  priceVersion: string;
  maxOutputTokens: number;
  status: "quoted";
  expiresAt: string;
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateModelRequest(modelId: string, prompt: string, idempotencyKey?: string) {
  if (!/^@?[A-Za-z0-9][A-Za-z0-9@._:/-]{0,198}$/.test(modelId)
    || typeof prompt !== "string" || prompt.trim().length < 1 || prompt.length > MAX_PROMPT_CHARS
    || (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey))) {
    throw new Error("managed_model_request_invalid");
  }
}

async function resolveModelEntitlement(
  env: AgentsEnv,
  scope: CommunicationScope,
  modelId: string,
  now: Date,
): Promise<ResolvedModelEntitlement> {
  const org = await env.PLATFORM_DB.prepare("SELECT plan_tier FROM orgs WHERE id=? AND status='active'")
    .bind(scope.tenantId).first<{ plan_tier: string }>();
  if (!org) throw new Error("managed_model_tenant_unavailable");
  const entitlement = await env.PLATFORM_DB.prepare(`SELECT e.capability_version,e.price_version,e.credits_per_operation,
      e.max_credits_per_operation,e.max_output_tokens,e.max_operations_per_period
    FROM managed_service_model_entitlements e JOIN managed_service_capability_versions c
      ON c.provider=e.provider AND c.service_id=e.service_id AND c.version=e.capability_version
    WHERE e.plan_tier=? AND e.provider=? AND e.service_id=? AND e.operation_name=? AND e.model_id=? AND e.region=?
      AND e.status='active' AND e.verified_by IS NOT NULL AND e.verified_at IS NOT NULL AND e.valid_until>?
      AND c.status='verified' AND c.valid_until>? AND c.version=(SELECT MAX(latest.version) FROM managed_service_capability_versions latest
        WHERE latest.provider=c.provider AND latest.service_id=c.service_id)
      AND EXISTS(SELECT 1 FROM json_each(c.operations_json) WHERE value=e.operation_name)
      AND EXISTS(SELECT 1 FROM json_each(c.regions_json) WHERE value=e.region)
      AND EXISTS(SELECT 1 FROM json_each(c.account_modes_json) WHERE value='naelao_managed')
    LIMIT 1`)
    .bind(org.plan_tier, PROVIDER, SERVICE, OPERATION, modelId, REGION, now.toISOString(), now.toISOString())
    .first<ModelEntitlement>();
  if (!entitlement || !Number.isSafeInteger(entitlement.credits_per_operation) || entitlement.credits_per_operation! < 1
    || !Number.isSafeInteger(entitlement.max_output_tokens) || entitlement.max_output_tokens! < 1 || entitlement.max_output_tokens! > 4096
    || entitlement.credits_per_operation! > entitlement.max_credits_per_operation) {
    throw new Error("managed_model_not_entitled");
  }
  return { planTier: org.plan_tier, entitlement };
}

/** Persist a short-lived quote from the exact active fixed-price model entitlement. */
export async function createManagedModelQuote(
  env: AgentsEnv,
  scope: CommunicationScope,
  input: { modelId: string; prompt: string },
  now = new Date(),
): Promise<ManagedModelQuote> {
  validateModelRequest(input.modelId, input.prompt);
  if (!env.AI) throw new Error("managed_model_provider_unavailable");
  const { planTier, entitlement } = await resolveModelEntitlement(env, scope, input.modelId, now);
  const quoteId = `msq_${crypto.randomUUID().replaceAll("-", "")}`;
  const expiresAt = new Date(now.getTime() + 180_000).toISOString();
  await env.PLATFORM_DB.prepare(`INSERT INTO managed_service_operation_quotes(
    quote_id,tenant_id,space_id,project_id,requester_user_id,plan_tier,provider,service_id,operation_name,model_id,region,
    capability_version,price_version,credits,max_output_tokens,status,expires_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'quoted',?,?)`)
    .bind(quoteId, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId, planTier,
      PROVIDER, SERVICE, OPERATION, input.modelId, REGION, entitlement.capability_version, entitlement.price_version,
      entitlement.credits_per_operation, entitlement.max_output_tokens, expiresAt, now.toISOString()).run();
  return { quoteId, provider: PROVIDER, serviceId: SERVICE, operationName: OPERATION, modelId: input.modelId,
    region: REGION, credits: entitlement.credits_per_operation!, creditUnit: "naelao_credit",
    priceVersion: entitlement.price_version, maxOutputTokens: entitlement.max_output_tokens!, status: "quoted", expiresAt };
}

function safeErrorCode(value: unknown): string {
  const message = value instanceof Error ? value.message : "managed_model_operation_failed";
  return /^[a-z][a-z0-9_:-]{1,100}$/.test(message) ? message : "managed_model_operation_failed";
}

function resultAad(tenantId: string, spaceId: string, operationId: string) {
  return `managed-model-result:${tenantId}:${spaceId}:${operationId}`;
}

async function readSavedResult(env: AgentsEnv, scope: CommunicationScope, operationId: string) {
  const row = await env.PLATFORM_DB.prepare(`SELECT tenant_id,space_id,project_id,requester_user_id,model_id,envelope_json,expires_at
    FROM managed_service_model_results WHERE operation_id=? AND tenant_id=? AND space_id=? AND requester_user_id=?`)
    .bind(operationId, scope.tenantId, scope.spaceId, scope.userId).first<SavedResult>();
  if (!row) return null;
  if (row.project_id !== (scope.projectId ?? null)) throw new Error("managed_model_operation_scope_conflict");
  if (Date.parse(row.expires_at) <= Date.now()) throw new Error("managed_model_result_expired");
  let envelope: unknown;
  try { envelope = JSON.parse(row.envelope_json); } catch { throw new Error("managed_model_result_unavailable"); }
  try {
    return await decryptAuthenticated(envelope as Parameters<typeof decryptAuthenticated>[0],
      await deriveKek(env.PLATFORM_SECRET, scope.tenantId), resultAad(scope.tenantId, scope.spaceId, operationId));
  } catch { throw new Error("managed_model_result_unavailable"); }
}

async function markOperation(
  env: AgentsEnv,
  operationId: string,
  scope: CommunicationScope,
  status: "failed" | "uncertain" | "complete",
  errorCode: string | null,
  resultRef: string | null = null,
) {
  await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status=?,error_code=?,result_ref=?,lease_until=NULL,updated_at=?
    WHERE operation_id=? AND tenant_id=? AND status IN ('running','uncertain')`)
    .bind(status, errorCode, resultRef, new Date().toISOString(), operationId, scope.tenantId).run();
}

async function markUncertain(env: AgentsEnv, scope: CommunicationScope, operationId: string, reservationId: string, code: string) {
  await markOperation(env, operationId, scope, "uncertain", code);
  await markManagedServiceCreditsUncertain(env, scope, reservationId).catch(() => undefined);
}

async function saveResult(
  env: AgentsEnv,
  scope: CommunicationScope,
  operationId: string,
  modelId: string,
  output: string,
  now: Date,
) {
  const envelope = await encryptAuthenticated(JSON.stringify({ output }), await deriveKek(env.PLATFORM_SECRET, scope.tenantId),
    resultAad(scope.tenantId, scope.spaceId, operationId));
  const expiresAt = new Date(now.getTime() + RESULT_TTL_MS).toISOString();
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_model_results(
    operation_id,tenant_id,space_id,project_id,requester_user_id,provider,service_id,model_id,envelope_json,expires_at,created_at)
    VALUES(?,?,?,?,?,? ,?,?,?,?,?)`)
    .bind(operationId, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId,
      PROVIDER, SERVICE, modelId, JSON.stringify(envelope), expiresAt, now.toISOString()).run();
  const stored = await readSavedResult(env, scope, operationId);
  if (stored !== JSON.stringify({ output })) {
    let parsed: unknown;
    try { parsed = JSON.parse(stored ?? "null"); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object" || (parsed as { output?: unknown }).output !== output) {
      throw new Error("managed_model_result_persistence_conflict");
    }
  }
}

function responseText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("managed_model_provider_response_invalid");
  const record = value as Record<string, unknown>;
  if (record.success === false) throw new Error("managed_model_provider_rejected");
  const result = record.result && typeof record.result === "object" && !Array.isArray(record.result)
    ? record.result as Record<string, unknown> : null;
  const output = typeof record.response === "string" ? record.response
    : typeof record.output === "string" ? record.output
      : result && typeof result.response === "string" ? result.response : null;
  if (output === null || output.length > MAX_RESULT_CHARS) throw new Error("managed_model_provider_response_invalid");
  return output;
}

async function settleSavedResult(
  env: AgentsEnv,
  scope: CommunicationScope,
  operation: OperationRow,
  modelId: string,
  reservationId: string,
  entitlement: ModelEntitlement,
  deduplicated: boolean,
): Promise<ManagedModelOperationResult> {
  const output = await readSavedResult(env, scope, operation.operation_id);
  if (output === null) throw new Error("managed_model_result_unavailable");
  let decoded: unknown;
  try { decoded = JSON.parse(output); } catch { throw new Error("managed_model_result_unavailable"); }
  const text = decoded && typeof decoded === "object" && typeof (decoded as { output?: unknown }).output === "string"
    ? (decoded as { output: string }).output : null;
  if (text === null) throw new Error("managed_model_result_unavailable");
  try {
    await settleManagedServiceCredits(env, scope, reservationId, entitlement.credits_per_operation!);
  } catch {
    await markUncertain(env, scope, operation.operation_id, reservationId, "managed_model_settlement_uncertain");
    return { operationId: operation.operation_id, modelId, status: "uncertain", credits: entitlement.credits_per_operation!,
      priceVersion: entitlement.price_version, maxOutputTokens: entitlement.max_output_tokens!, deduplicated: true };
  }
  await markOperation(env, operation.operation_id, scope, "complete", null, `managed-model:${operation.operation_id}`);
  await revokeOrganizationPayerMandate(env, scope, `managed-model:${operation.operation_id}`,
    "Managed model operation completed under its single-operation authorization.").catch(() => undefined);
  return { operationId: operation.operation_id, modelId, status: "complete", credits: entitlement.credits_per_operation!,
    priceVersion: entitlement.price_version, maxOutputTokens: entitlement.max_output_tokens!, output: text, deduplicated };
}

/** Execute one explicitly requested, fixed-price Workers AI text inference. Unknown outcomes are never replayed. */
export async function runManagedModelOperation(
  env: AgentsEnv,
  scope: CommunicationScope,
  input: { modelId: string; prompt: string; idempotencyKey: string; quoteId: string },
  now = new Date(),
): Promise<ManagedModelOperationResult> {
  validateModelRequest(input.modelId, input.prompt, input.idempotencyKey);
  if (!/^msq_[A-Fa-f0-9]{32}$/.test(input.quoteId)) throw new Error("managed_model_quote_invalid");
  if (!env.AI) throw new Error("managed_model_provider_unavailable");

  const { planTier, entitlement } = await resolveModelEntitlement(env, scope, input.modelId, now);
  const quote = await env.PLATFORM_DB.prepare(`SELECT quote_id,tenant_id,space_id,project_id,requester_user_id,plan_tier,
      provider,service_id,operation_name,model_id,region,capability_version,price_version,credits,max_output_tokens,status,
      operation_id,expires_at FROM managed_service_operation_quotes WHERE quote_id=? AND tenant_id=? AND space_id=?
        AND project_id IS ? AND requester_user_id=?`)
    .bind(input.quoteId, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId)
    .first<{ quote_id:string;tenant_id:string;space_id:string;project_id:string|null;requester_user_id:string;plan_tier:string;
      provider:string;service_id:string;operation_name:string;model_id:string;region:string;capability_version:number;
      price_version:string;credits:number;max_output_tokens:number;status:string;operation_id:string|null;expires_at:string }>();
  if (!quote) throw new Error("managed_model_quote_not_found");
  if (quote.plan_tier !== planTier || quote.provider !== PROVIDER || quote.service_id !== SERVICE
    || quote.operation_name !== OPERATION || quote.model_id !== input.modelId || quote.region !== REGION
    || quote.capability_version !== entitlement.capability_version || quote.price_version !== entitlement.price_version
    || quote.credits !== entitlement.credits_per_operation || quote.max_output_tokens !== entitlement.max_output_tokens) {
    throw new Error("managed_model_quote_terms_changed");
  }

  const requestHash = await sha256(JSON.stringify({ tenant: scope.tenantId, space: scope.spaceId, project: scope.projectId ?? null,
    user: scope.userId, model: input.modelId, prompt: input.prompt, maxOutputTokens: entitlement.max_output_tokens }));
  const idempotencyKey = `owner:${scope.spaceId}:${scope.userId}:${input.idempotencyKey}`;
  const createdAt = now.toISOString();
  let operation = await env.PLATFORM_DB.prepare(`SELECT operation_id,quote_id,request_sha256,model_id,status,lease_until,price_version,reserved_credits,error_code
    FROM managed_service_operations WHERE tenant_id=? AND provider=? AND idempotency_key=? LIMIT 1`)
    .bind(scope.tenantId, PROVIDER, idempotencyKey).first<OperationRow>();
  if (operation && (operation.request_sha256 !== requestHash || operation.model_id !== input.modelId
    || operation.price_version !== entitlement.price_version || operation.quote_id !== input.quoteId
    || quote.status !== "consumed" || quote.operation_id !== operation.operation_id)) {
    throw new Error("managed_model_idempotency_conflict");
  }
  if (!operation) {
    if (quote.status !== "quoted") throw new Error("managed_model_quote_already_used");
    if (Date.parse(quote.expires_at) <= now.getTime()) throw new Error("managed_model_quote_expired");
    const operationId = `msmo_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_operations(
        operation_id,tenant_id,space_id,project_id,provider,service_id,capability_version,operation_name,model_id,region,
        idempotency_key,request_sha256,status,price_version,quote_id,reserved_credits,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?,NULL,?,?
        FROM managed_service_operation_quotes q WHERE q.quote_id=? AND q.tenant_id=? AND q.space_id=? AND q.project_id IS ?
          AND q.requester_user_id=? AND q.plan_tier=? AND q.price_version=? AND q.credits=? AND q.max_output_tokens=?
          AND q.status='quoted' AND q.operation_id IS NULL AND q.expires_at>? AND NOT EXISTS(
            SELECT 1 FROM managed_service_operations WHERE tenant_id=? AND provider=? AND idempotency_key=?)`)
        .bind(operationId, scope.tenantId, scope.spaceId, scope.projectId ?? null, PROVIDER, SERVICE,
          entitlement.capability_version, OPERATION, input.modelId, REGION, idempotencyKey, requestHash,
          entitlement.price_version, input.quoteId, createdAt, createdAt, input.quoteId, scope.tenantId, scope.spaceId,
          scope.projectId ?? null, scope.userId, planTier, entitlement.price_version, entitlement.credits_per_operation,
          entitlement.max_output_tokens, now.toISOString(), scope.tenantId, PROVIDER, idempotencyKey),
      env.PLATFORM_DB.prepare(`UPDATE managed_service_operation_quotes SET status='consumed',operation_id=?,consumed_at=?
        WHERE quote_id=? AND status='quoted' AND expires_at>? AND EXISTS(
          SELECT 1 FROM managed_service_operations WHERE operation_id=? AND quote_id=? AND tenant_id=? AND idempotency_key=?)`)
        .bind(operationId, now.toISOString(), input.quoteId, now.toISOString(), operationId, input.quoteId, scope.tenantId, idempotencyKey),
    ]);
    operation = await env.PLATFORM_DB.prepare(`SELECT operation_id,quote_id,request_sha256,model_id,status,lease_until,price_version,reserved_credits,error_code
      FROM managed_service_operations WHERE tenant_id=? AND provider=? AND idempotency_key=? LIMIT 1`)
      .bind(scope.tenantId, PROVIDER, idempotencyKey).first<OperationRow>();
    if (!operation || operation.quote_id !== input.quoteId || operation.request_sha256 !== requestHash
      || operation.model_id !== input.modelId || operation.price_version !== entitlement.price_version) {
      throw new Error("managed_model_quote_already_used");
    }
    const consumedQuote = await env.PLATFORM_DB.prepare(`SELECT status,operation_id FROM managed_service_operation_quotes WHERE quote_id=? AND tenant_id=?`)
      .bind(input.quoteId, scope.tenantId).first<{status:string;operation_id:string|null}>();
    if (consumedQuote?.status !== "consumed" || consumedQuote.operation_id !== operation.operation_id)
      throw new Error("managed_model_quote_consume_conflict");
  }
  if (!operation) throw new Error("managed_model_operation_unavailable");
  const reservationId = `msmr_${operation.operation_id}`;

  const existingResult = await readSavedResult(env, scope, operation.operation_id);
  if (existingResult !== null) {
    return settleSavedResult(env, scope, operation, input.modelId, reservationId, entitlement, true);
  }
  if (operation.status === "complete") throw new Error("managed_model_result_unavailable");
  if (operation.status === "failed") throw new Error(operation.error_code ?? "managed_model_operation_failed");
  if (operation.status === "uncertain") {
    return { operationId: operation.operation_id, modelId: input.modelId, status: "uncertain",
      credits: entitlement.credits_per_operation!, priceVersion: entitlement.price_version,
      maxOutputTokens: entitlement.max_output_tokens!, errorCode: operation.error_code ?? "managed_model_outcome_uncertain", deduplicated: true };
  }
  if (operation.status === "running") {
    if (operation.lease_until && Date.parse(operation.lease_until) > now.getTime()) {
      return { operationId: operation.operation_id, modelId: input.modelId, status: "pending",
        credits: entitlement.credits_per_operation!, priceVersion: entitlement.price_version,
        maxOutputTokens: entitlement.max_output_tokens!, deduplicated: true };
    }
    await markUncertain(env, scope, operation.operation_id, reservationId, "managed_model_worker_interrupted");
    return { operationId: operation.operation_id, modelId: input.modelId, status: "uncertain",
      credits: entitlement.credits_per_operation!, priceVersion: entitlement.price_version,
      maxOutputTokens: entitlement.max_output_tokens!, errorCode: "managed_model_worker_interrupted", deduplicated: true };
  }
  const leaseUntil = new Date(now.getTime() + 120_000).toISOString();
  const claimed = await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,updated_at=?
    WHERE operation_id=? AND tenant_id=? AND status='pending'`)
    .bind(leaseUntil, createdAt, operation.operation_id, scope.tenantId).run();
  if (!claimed.meta.changes) return { operationId: operation.operation_id, modelId: input.modelId, status: "pending",
    credits: entitlement.credits_per_operation!, priceVersion: entitlement.price_version, maxOutputTokens: entitlement.max_output_tokens!, deduplicated: true };

  const mandateKey = `managed-model:${operation.operation_id}`;
  const operationScope: CommunicationScope = { ...scope, role: "owner" };
  let payerMandateId: string;
  try {
    payerMandateId = await ensureOrganizationPayerMandate(env, operationScope, {
      mandateKey, provider: PROVIDER, serviceId: SERVICE, operationName: OPERATION,
      maxCreditsPerOperation: entitlement.credits_per_operation!, maxCreditsPerPeriod: entitlement.credits_per_operation!,
      periodDays: 30, allowRenewal: false,
    });
  } catch (error) {
    await markOperation(env, operation.operation_id, scope, "failed", safeErrorCode(error));
    throw error;
  }

  try {
    const reserved = await reserveManagedServiceCredits(env, scope, {
      reservationId, operationId: operation.operation_id, provider: PROVIDER, serviceId: SERVICE,
      operationName: OPERATION, modelId: input.modelId, region: REGION, credits: entitlement.credits_per_operation!, priceVersion: entitlement.price_version,
      payerMandateId, quoteId: input.quoteId,
    }) as { reserved?: boolean; status?: string };
    if (reserved.reserved !== true || reserved.status !== "held") {
      await markUncertain(env, scope, operation.operation_id, reservationId, "managed_model_reservation_uncertain");
      return { operationId: operation.operation_id, modelId: input.modelId, status: "uncertain",
        credits: entitlement.credits_per_operation!, priceVersion: entitlement.price_version,
        maxOutputTokens: entitlement.max_output_tokens!, errorCode: "managed_model_reservation_uncertain" };
    }
  } catch (error) {
    const code = safeErrorCode(error);
    if (code.startsWith("managed_service_billing_")) {
      await markOperation(env, operation.operation_id, scope, "failed", code);
      await revokeOrganizationPayerMandate(env, scope, mandateKey, "Managed model credit reservation was denied before provider dispatch.").catch(() => undefined);
      throw error;
    }
    await markUncertain(env, scope, operation.operation_id, reservationId, "managed_model_reservation_uncertain");
    return { operationId: operation.operation_id, modelId: input.modelId, status: "uncertain",
      credits: entitlement.credits_per_operation!, priceVersion: entitlement.price_version,
      maxOutputTokens: entitlement.max_output_tokens!, errorCode: "managed_model_reservation_uncertain" };
  }
  const reservationRecorded = await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET reserved_credits=?,updated_at=?
    WHERE operation_id=? AND tenant_id=? AND status='running'`)
    .bind(entitlement.credits_per_operation, new Date().toISOString(), operation.operation_id, scope.tenantId).run();
  if (!reservationRecorded.meta.changes) {
    let released = false;
    try {
      await releaseManagedServiceCredits(env, scope, reservationId, "no_effect");
      released = true;
    } catch { /* A failed release leaves the charge outcome unresolved. */ }
    if (released) {
      await markOperation(env, operation.operation_id, scope, "failed", "managed_model_operation_claim_lost");
      await revokeOrganizationPayerMandate(env, scope, mandateKey, "Managed model operation claim ended before provider dispatch.").catch(() => undefined);
      throw new Error("managed_model_operation_claim_lost");
    } else {
      await markUncertain(env, scope, operation.operation_id, reservationId, "managed_model_operation_claim_lost");
      return { operationId: operation.operation_id, modelId: input.modelId, status: "uncertain",
        credits: entitlement.credits_per_operation!, priceVersion: entitlement.price_version,
        maxOutputTokens: entitlement.max_output_tokens!, errorCode: "managed_model_operation_claim_lost" };
    }
  }

  let providerOutput: string;
  try {
    const run = env.AI.run as unknown as (model: string, inputs: Record<string, unknown>) => Promise<unknown>;
    const raw = await run(input.modelId, {
      messages: [{ role: "user", content: input.prompt }],
      max_tokens: entitlement.max_output_tokens,
    });
    providerOutput = responseText(raw);
  } catch (error) {
    const code = safeErrorCode(error);
    await markUncertain(env, scope, operation.operation_id, reservationId, code);
    return { operationId: operation.operation_id, modelId: input.modelId, status: "uncertain",
      credits: entitlement.credits_per_operation!, priceVersion: entitlement.price_version,
      maxOutputTokens: entitlement.max_output_tokens!, errorCode: code };
  }

  if (!providerOutput.trim()) {
    try { await settleManagedServiceCredits(env, scope, reservationId, entitlement.credits_per_operation!); }
    catch {
      await markUncertain(env, scope, operation.operation_id, reservationId, "managed_model_settlement_uncertain");
      return { operationId: operation.operation_id, modelId: input.modelId, status: "uncertain",
        credits: entitlement.credits_per_operation!, priceVersion: entitlement.price_version,
        maxOutputTokens: entitlement.max_output_tokens!, errorCode: "managed_model_settlement_uncertain" };
    }
    await markOperation(env, operation.operation_id, scope, "failed", "managed_model_empty_response");
    throw new Error("managed_model_empty_response");
  }
  try {
    await saveResult(env, scope, operation.operation_id, input.modelId, providerOutput, now);
  } catch {
    try { await settleManagedServiceCredits(env, scope, reservationId, entitlement.credits_per_operation!); }
    catch {
      await markUncertain(env, scope, operation.operation_id, reservationId, "managed_model_result_persistence_uncertain");
      return { operationId: operation.operation_id, modelId: input.modelId, status: "uncertain",
        credits: entitlement.credits_per_operation!, priceVersion: entitlement.price_version,
        maxOutputTokens: entitlement.max_output_tokens!, errorCode: "managed_model_result_persistence_uncertain" };
    }
    await markOperation(env, operation.operation_id, scope, "failed", "managed_model_result_persistence_failed");
    throw new Error("managed_model_result_persistence_failed");
  }
  const refreshed = await env.PLATFORM_DB.prepare(`SELECT operation_id,request_sha256,model_id,status,lease_until,price_version,reserved_credits,error_code
    FROM managed_service_operations WHERE operation_id=? AND tenant_id=?`)
    .bind(operation.operation_id, scope.tenantId).first<OperationRow>();
  if (!refreshed) throw new Error("managed_model_operation_unavailable");
  return settleSavedResult(env, scope, refreshed, input.modelId, reservationId, entitlement, false);
}

export async function purgeExpiredManagedModelResults(db: Pick<D1Database, "prepare" | "batch">, now = new Date()): Promise<number> {
  const quoteRetentionCutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  await db.prepare(`DELETE FROM managed_service_operation_quotes
    WHERE (status IN ('quoted','cancelled') AND expires_at<=?)
       OR (status='consumed' AND consumed_at IS NOT NULL AND consumed_at<=?)`)
    .bind(quoteRetentionCutoff, quoteRetentionCutoff).run();
  const expired = await db.prepare(`SELECT operation_id FROM managed_service_model_results WHERE expires_at<=? ORDER BY expires_at LIMIT 100`)
    .bind(now.toISOString()).all<{ operation_id: string }>();
  if (!expired.results?.length) return 0;
  const ids = expired.results.map((row) => row.operation_id);
  const placeholders = ids.map(() => "?").join(",");
  const at = now.toISOString();
  const results = await db.batch([
    db.prepare(`DELETE FROM managed_service_model_results WHERE operation_id IN (${placeholders})`).bind(...ids),
    db.prepare(`UPDATE managed_service_operations SET result_ref=NULL,updated_at=? WHERE operation_id IN (${placeholders})`)
      .bind(at, ...ids),
  ]);
  return results[0]?.meta.changes ?? 0;
}
