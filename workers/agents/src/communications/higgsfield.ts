import { readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import { openCommunication, sealCommunication, type CommunicationIdentity, type CommunicationScope } from "./core.js";
import { requireManagedServiceCapability } from "./managed-service-capabilities.js";

export const HIGGSFIELD_MODEL_ID = "kling-video-v4-text-to-video";
const MODEL_PATH = "kling-video/v4.0/text-to-video";
const API_ORIGIN = "https://api.higgsfield.ai";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TERMINAL = new Set(["completed", "failed", "nsfw", "canceled", "deleted"]);

export interface HiggsfieldGenerationInput {
  prompt: string;
  duration?: number;
  resolution?: "720p" | "1080p";
  aspect_ratio?: "21:9" | "16:9" | "9:16" | "1:1";
}

type AccountRow = {
  id: string; tenant_id: string; space_id: string; project_id: string | null; assistant_identity_id: string;
  owner_user_id: string; credential_ciphertext: string; credential_iv: string; credential_fingerprint: string; status: string;
};

function id(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }

function trustedProviderPath(value: unknown, requestId: string, suffix: "status" | "cancel"): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const expected = `/requests/${requestId}/${suffix}`;
    return url.origin === API_ORIGIN && !url.username && !url.password && url.pathname === expected
      && !url.search && !url.hash ? url.pathname : null;
  } catch { return null; }
}

function validInput(value: unknown): value is HiggsfieldGenerationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.prompt === "string" && input.prompt.trim().length > 0 && input.prompt.length <= 10_000 &&
    (input.duration === undefined || Number.isSafeInteger(input.duration) && Number(input.duration) >= 3 && Number(input.duration) <= 30) &&
    (input.resolution === undefined || input.resolution === "720p" || input.resolution === "1080p") &&
    (input.aspect_ratio === undefined || ["21:9", "16:9", "9:16", "1:1"].includes(String(input.aspect_ratio))) &&
    Object.keys(input).every((key) => ["prompt", "duration", "resolution", "aspect_ratio"].includes(key));
}

function normalizedInput(value: HiggsfieldGenerationInput): Required<HiggsfieldGenerationInput> {
  return {
    prompt: value.prompt.trim(), duration: value.duration ?? 10,
    resolution: value.resolution ?? "1080p", aspect_ratio: value.aspect_ratio ?? "16:9",
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseUsd(value: unknown): string | null {
  const amount = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/.test(amount)) return null;
  if (!/[1-9]/.test(amount.replace(".", ""))) return null;
  return amount;
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function requireEnabled(env: AgentsEnv) {
  if (env.HIGGSFIELD_BYO_ENABLED !== "true") throw new Error("higgsfield_integration_disabled");
}

async function capability(env: AgentsEnv, operation: "estimate" | "generate" | "status" | "cancel" | "delete") {
  return requireManagedServiceCapability(env.PLATFORM_DB, {
    provider: "higgsfield", serviceId: HIGGSFIELD_MODEL_ID, operation,
    connectionMode: "user_connected", region: "global",
  });
}

async function accountFor(env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, accountId: string): Promise<AccountRow> {
  if (!ID.test(accountId)) throw new Error("higgsfield_account_unavailable");
  const account = await env.PLATFORM_DB.prepare(`SELECT id,tenant_id,space_id,project_id,assistant_identity_id,owner_user_id,
      credential_ciphertext,credential_iv,credential_fingerprint,status FROM assistant_higgsfield_accounts
    WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=? AND assistant_identity_id=? LIMIT 1`)
    .bind(accountId, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId, identity.id).first<AccountRow>();
  if (!account || account.status !== "active") throw new Error("higgsfield_account_unavailable");
  return account;
}

async function apiKeyFor(env: AgentsEnv, identity: CommunicationIdentity, account: AccountRow): Promise<string> {
  const value = await openCommunication(env, identity, account.id, {
    ciphertext: account.credential_ciphertext, iv: account.credential_iv, algorithm: "aes-256-gcm",
  });
  if (typeof value.apiKey !== "string" || value.apiKey.length < 16) throw new Error("higgsfield_credential_unavailable");
  return value.apiKey;
}

async function providerRequest(
  key: string,
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Key ${key}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new Error("higgsfield_provider_outcome_unknown"); }
  if (response.status >= 500 || response.status === 429) throw new Error("higgsfield_provider_outcome_unknown");
  if (!response.ok) throw new Error(`higgsfield_provider_rejected_${response.status}`);
  if (response.status === 202 || response.status === 204 || response.headers.get("content-length") === "0") {
    return { status: response.status, body: {} };
  }
  const result = await readBoundedResponseJson<unknown>(response, 256 * 1024).catch(() => null);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    if (method === "DELETE") return { status: response.status, body: {} };
    throw new Error("higgsfield_provider_response_invalid");
  }
  return { status: response.status, body: result as Record<string, unknown> };
}

async function providerJson(key: string, path: string, method: "GET" | "POST", body?: unknown, idempotencyKey?: string) {
  return (await providerRequest(key, path, method, body, idempotencyKey)).body;
}

async function quote(env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, account: AccountRow, input: HiggsfieldGenerationInput) {
  const normalized = normalizedInput(input);
  const requestHash = await sha256(JSON.stringify(normalized));
  const key = await apiKeyFor(env, identity, account);
  const response = await providerJson(key, `/estimate/${MODEL_PATH}`, "POST", normalized);
  const amount = parseUsd(response.usd);
  if (!amount) throw new Error("higgsfield_estimate_invalid");
  const now = new Date();
  const estimateId = id("hfe");
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  await env.PLATFORM_DB.prepare(`INSERT INTO assistant_higgsfield_estimates(
    id,account_id,tenant_id,space_id,project_id,owner_user_id,model_id,request_sha256,amount_usd,expires_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(estimateId, account.id, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId,
      HIGGSFIELD_MODEL_ID, requestHash, amount, expiresAt, now.toISOString()).run();
  return { id: estimateId, modelId: HIGGSFIELD_MODEL_ID, amountUsd: amount, expiresAt };
}

export async function connectHiggsfieldAccount(
  env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, input: { apiKey: string },
) {
  requireEnabled(env);
  if (typeof input.apiKey !== "string" || !/^\S{1,256}:\S{1,512}$/.test(input.apiKey) || input.apiKey.length > 1024) throw new Error("higgsfield_credential_invalid");
  const existing = await env.PLATFORM_DB.prepare(`SELECT id FROM assistant_higgsfield_accounts
    WHERE tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=? LIMIT 1`)
    .bind(scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId).first<{ id: string }>();
  const accountId = existing?.id ?? id("hfa");
  const sealed = await sealCommunication(env, identity, accountId, { apiKey: input.apiKey });
  const fingerprint = await sha256(input.apiKey);
  const at = new Date().toISOString();
  if (existing) {
    await env.PLATFORM_DB.prepare(`UPDATE assistant_higgsfield_accounts SET assistant_identity_id=?,credential_ciphertext=?,credential_iv=?,
      credential_fingerprint=?,status='active',updated_at=? WHERE id=? AND tenant_id=? AND owner_user_id=?`)
      .bind(identity.id, String(sealed.ciphertext), String(sealed.iv), fingerprint, at, accountId, scope.tenantId, scope.userId).run();
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET credential_ref=?,provider_payer_type='user',provider_payer_id=?,
      lifecycle_state='active',updated_at=? WHERE id=? AND tenant_id=? AND owner_id=?`)
      .bind(accountId, scope.userId, at, accountId, scope.tenantId, scope.userId).run();
  } else {
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(`INSERT INTO managed_service_accounts(
        id,tenant_id,space_id,project_id,provider,service_id,connection_mode,provider_resource_ref,credential_ref,
        owner_type,owner_id,provider_payer_type,provider_payer_id,lifecycle_state,metadata_json,created_at,updated_at)
        VALUES(?,?,?,?,? ,?,'user_connected','customer-owned-api-key',?,'user',?,'user',?,'active','{}',?,?)`)
        .bind(accountId, scope.tenantId, scope.spaceId, scope.projectId ?? null, "higgsfield", HIGGSFIELD_MODEL_ID,
          accountId, scope.userId, scope.userId, at, at),
      env.PLATFORM_DB.prepare(`INSERT INTO assistant_higgsfield_accounts(
        id,tenant_id,space_id,project_id,assistant_identity_id,owner_user_id,credential_ciphertext,credential_iv,credential_fingerprint,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'active',?,?)`)
        .bind(accountId, scope.tenantId, scope.spaceId, scope.projectId ?? null, identity.id, scope.userId,
          String(sealed.ciphertext), String(sealed.iv), fingerprint, at, at),
    ]);
  }
  return { id: accountId, provider: "higgsfield", connectionMode: "user_connected", status: "active", credentialSaved: true };
}

export async function createHiggsfieldEstimate(
  env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, accountId: string, input: unknown,
) {
  requireEnabled(env);
  if (!validInput(input)) throw new Error("higgsfield_request_invalid");
  const currentCapability = await capability(env, "estimate");
  const account = await accountFor(env, scope, identity, accountId);
  await env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET capability_version=?,updated_at=? WHERE id=? AND tenant_id=?`)
    .bind(currentCapability.version, new Date().toISOString(), account.id, scope.tenantId).run();
  const estimate = await quote(env, scope, identity, account, input);
  return { estimate, input: normalizedInput(input) };
}

export async function submitHiggsfieldGeneration(
  env: AgentsEnv,
  scope: CommunicationScope,
  identity: CommunicationIdentity,
  input: { accountId: string; estimateId: string; confirmedUsd: string; idempotencyKey: string; request: unknown },
) {
  requireEnabled(env);
  if (!ID.test(input.accountId) || !ID.test(input.estimateId) || !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey)
    || !parseUsd(input.confirmedUsd) || !validInput(input.request)) throw new Error("higgsfield_request_invalid");
  const currentCapability = await capability(env, "generate");
  const account = await accountFor(env, scope, identity, input.accountId);
  const normalized = normalizedInput(input.request);
  const requestHash = await sha256(JSON.stringify(normalized));
  const idempotencyHash = await sha256(input.idempotencyKey);

  const existing = await env.PLATFORM_DB.prepare(`SELECT id,operation_id,request_sha256,provider_request_id,provider_status,estimated_usd,error_code,credential_fingerprint
    FROM assistant_higgsfield_requests WHERE account_id=? AND idempotency_hash=?`)
    .bind(account.id, idempotencyHash).first<{ id: string; operation_id: string; request_sha256: string; provider_request_id: string | null;
      provider_status: string; estimated_usd: string; error_code: string | null; credential_fingerprint: string }>();
  if (existing) {
    if (existing.request_sha256 !== requestHash) throw new Error("higgsfield_idempotency_conflict");
    if (!existing.provider_request_id && ["unknown", "submitting"].includes(existing.provider_status)) {
      if (existing.credential_fingerprint !== account.credential_fingerprint) throw new Error("higgsfield_provider_credential_changed");
      const retryEstimate = await env.PLATFORM_DB.prepare(`SELECT id,request_sha256,amount_usd,expires_at,consumed_at
        FROM assistant_higgsfield_estimates WHERE id=? AND account_id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=?`)
        .bind(input.estimateId, account.id, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId)
        .first<{ id: string; request_sha256: string; amount_usd: string; expires_at: string; consumed_at: string | null }>();
      if (!retryEstimate || retryEstimate.request_sha256 !== requestHash || retryEstimate.consumed_at || Date.parse(retryEstimate.expires_at) <= Date.now()) {
        throw new Error("higgsfield_estimate_expired_or_mismatched");
      }
      const key = await apiKeyFor(env, identity, account);
      const current = parseUsd((await providerJson(key, `/estimate/${MODEL_PATH}`, "POST", normalized)).usd);
      if (!current) throw new Error("higgsfield_estimate_invalid");
      if (current !== retryEstimate.amount_usd || input.confirmedUsd !== retryEstimate.amount_usd) {
        return { submitted: false, requiresConfirmation: true, estimate: await quote(env, scope, identity, account, normalized) };
      }
      const at = new Date().toISOString();
      const claimed = await env.PLATFORM_DB.prepare("UPDATE assistant_higgsfield_estimates SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?" )
        .bind(at, retryEstimate.id, at).run();
      if (!claimed.meta.changes) throw new Error("higgsfield_estimate_expired_or_mismatched");
      await env.PLATFORM_DB.batch([
        env.PLATFORM_DB.prepare(`UPDATE assistant_higgsfield_requests SET estimate_id=?,estimated_usd=?,provider_status='submitting',error_code=NULL,updated_at=?
          WHERE id=? AND provider_request_id IS NULL AND provider_status IN ('unknown','submitting')`)
          .bind(retryEstimate.id, retryEstimate.amount_usd, at, existing.id),
        env.PLATFORM_DB.prepare("UPDATE managed_service_operations SET status='running',error_code=NULL,updated_at=? WHERE operation_id=? AND status='uncertain'")
          .bind(at, existing.operation_id),
      ]);
      return dispatchHiggsfieldGeneration(env, scope, identity, account.id, key, normalized, idempotencyHash, existing.id, existing.operation_id);
    }
    return { submitted: existing.provider_request_id !== null, request: await publicRequest(env, scope, identity, account.id, existing) };
  }

  const unresolved = await env.PLATFORM_DB.prepare(`SELECT id FROM assistant_higgsfield_requests
    WHERE account_id=? AND request_sha256=? AND provider_status IN ('unknown','submitting') LIMIT 1`)
    .bind(account.id, requestHash).first<{ id: string }>();
  if (unresolved) throw new Error("higgsfield_outcome_reconciliation_required");

  const estimate = await env.PLATFORM_DB.prepare(`SELECT id,request_sha256,amount_usd,expires_at,consumed_at
    FROM assistant_higgsfield_estimates WHERE id=? AND account_id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=?`)
    .bind(input.estimateId, account.id, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId)
    .first<{ id: string; request_sha256: string; amount_usd: string; expires_at: string; consumed_at: string | null }>();
  if (!estimate || estimate.request_sha256 !== requestHash || estimate.consumed_at || Date.parse(estimate.expires_at) <= Date.now()) {
    throw new Error("higgsfield_estimate_expired_or_mismatched");
  }

  const key = await apiKeyFor(env, identity, account);
  let currentAmount: string;
  try {
    const response = await providerJson(key, `/estimate/${MODEL_PATH}`, "POST", normalized);
    const amount = parseUsd(response.usd);
    if (!amount) throw new Error("higgsfield_estimate_invalid");
    currentAmount = amount;
  } catch (error) { throw error; }
  if (currentAmount !== estimate.amount_usd || input.confirmedUsd !== estimate.amount_usd) {
    const renewed = await quote(env, scope, identity, account, normalized);
    return { submitted: false, requiresConfirmation: true, estimate: renewed };
  }

  const operationId = id("mso");
  const requestId = id("hfr");
  const at = new Date().toISOString();
  const serviceIdempotencyKey = `higgsfield:${account.id}:${idempotencyHash}`;
  const claimedEstimate = await env.PLATFORM_DB.prepare("UPDATE assistant_higgsfield_estimates SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?" )
    .bind(at, estimate.id, at).run();
  if (!claimedEstimate.meta.changes) throw new Error("higgsfield_estimate_expired_or_mismatched");
  const created = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_operations(
      operation_id,tenant_id,space_id,project_id,account_id,provider,service_id,capability_version,operation_name,region,
      idempotency_key,request_sha256,status,price_version,reserved_credits,created_at,updated_at)
      VALUES(?,?,?,?,?,'higgsfield',?,?,?,?,?,?,'running','provider-estimate-usd-by-user',0,?,?)`)
      .bind(operationId, scope.tenantId, scope.spaceId, scope.projectId ?? null, account.id, HIGGSFIELD_MODEL_ID,
        currentCapability.version, "generate", "global", serviceIdempotencyKey, requestHash, at, at),
    env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO assistant_higgsfield_requests(
      id,operation_id,account_id,tenant_id,space_id,project_id,owner_user_id,model_id,idempotency_hash,request_sha256,
      estimate_id,estimated_usd,credential_fingerprint,provider_status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'submitting',?,?)`)
      .bind(requestId, operationId, account.id, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId,
        HIGGSFIELD_MODEL_ID, idempotencyHash, requestHash, estimate.id, estimate.amount_usd, account.credential_fingerprint, at, at),
  ]);
  if (!created[0]?.meta.changes || !created[1]?.meta.changes) {
    const prior = await env.PLATFORM_DB.prepare(`SELECT id,operation_id,request_sha256,provider_request_id,provider_status,estimated_usd,error_code
      FROM assistant_higgsfield_requests WHERE account_id=? AND idempotency_hash=?`)
      .bind(account.id, idempotencyHash).first<{ id: string; operation_id: string; request_sha256: string; provider_request_id: string | null;
        provider_status: string; estimated_usd: string; error_code: string | null }>();
    if (!prior) throw new Error("higgsfield_operation_journal_unavailable");
    if (prior.request_sha256 !== requestHash) throw new Error("higgsfield_idempotency_conflict");
    return { submitted: prior.provider_request_id !== null, request: await publicRequest(env, scope, identity, account.id, prior) };
  }
  return dispatchHiggsfieldGeneration(env, scope, identity, account.id, key, normalized, idempotencyHash, requestId, operationId);
}

type RequestRow = { id: string; operation_id: string; request_sha256: string; provider_request_id: string | null; provider_status: string; estimated_usd: string; error_code: string | null;
  provider_status_url?: string | null; provider_cancel_url?: string | null };

async function dispatchHiggsfieldGeneration(
  env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, accountId: string,
  key: string, normalized: Required<HiggsfieldGenerationInput>, idempotencyHash: string, requestId: string, operationId: string,
) {
  try {
    const accepted = await providerJson(key, `/${MODEL_PATH}`, "POST", normalized, idempotencyHash);
    const providerRequestId = typeof accepted.request_id === "string" ? accepted.request_id : "";
    const providerStatus = accepted.status === "queued" || accepted.status === "in_progress" ? accepted.status : "";
    const statusPath = trustedProviderPath(accepted.status_url, providerRequestId, "status");
    const cancelPath = trustedProviderPath(accepted.cancel_url, providerRequestId, "cancel");
    if (!ID.test(providerRequestId) || !providerStatus || !statusPath || !cancelPath) throw new Error("higgsfield_provider_response_invalid");
    const at = new Date().toISOString();
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(`UPDATE assistant_higgsfield_requests SET provider_request_id=?,provider_status_url=?,provider_cancel_url=?,provider_status=?,error_code=NULL,updated_at=? WHERE id=? AND provider_status='submitting'`)
        .bind(providerRequestId, statusPath, cancelPath, providerStatus, at, requestId),
      env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET provider_operation_ref=?,error_code=NULL,updated_at=? WHERE operation_id=? AND status='running'`)
        .bind(providerRequestId, at, operationId),
    ]);
  } catch (error) {
    const unknown = error instanceof Error && ["higgsfield_provider_outcome_unknown", "higgsfield_provider_response_invalid"].includes(error.message);
    const errorCode = unknown ? (error instanceof Error && error.message === "higgsfield_provider_response_invalid" ? "provider_response_unverified" : "provider_outcome_unknown") : error instanceof Error && /^higgsfield_provider_rejected_\d+$/.test(error.message)
      ? error.message : "provider_response_unverified";
    const at = new Date().toISOString();
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(`UPDATE assistant_higgsfield_requests SET provider_status=?,error_code=?,updated_at=? WHERE id=? AND provider_status='submitting'`)
        .bind(unknown ? "unknown" : "failed", errorCode, at, requestId),
      env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status=?,error_code=?,updated_at=? WHERE operation_id=? AND status='running'`)
        .bind(unknown ? "uncertain" : "failed", errorCode, at, operationId),
    ]);
    if (unknown) return { submitted: false, request: await getHiggsfieldRequest(env, scope, identity, accountId, requestId) };
    throw error;
  }
  return { submitted: true, request: await getHiggsfieldRequest(env, scope, identity, accountId, requestId) };
}

async function publicRequest(env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, accountId: string, row: RequestRow) {
  const stored = await env.PLATFORM_DB.prepare(`SELECT result_ciphertext,result_iv,provider_expires_at FROM assistant_higgsfield_requests
    WHERE id=? AND account_id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=?`)
    .bind(row.id, accountId, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId)
    .first<{ result_ciphertext: string | null; result_iv: string | null; provider_expires_at: string | null }>();
  let videoUrl: string | undefined;
  if (stored?.result_ciphertext && stored.result_iv) {
    try {
      const result = await openCommunication(env, identity, row.id, { ciphertext: stored.result_ciphertext, iv: stored.result_iv, algorithm: "aes-256-gcm" });
      if (typeof result.videoUrl === "string") videoUrl = result.videoUrl;
    } catch { /* a corrupt result is withheld; provider data remains private */ }
  }
  return { id: row.id, providerRequestId: row.provider_request_id, status: row.provider_status, estimatedUsd: row.estimated_usd,
    errorCode: row.error_code, expiresAt: stored?.provider_expires_at ?? null, ...(videoUrl ? { videoUrl } : {}) };
}

async function getHiggsfieldRequest(env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, accountId: string, requestId: string) {
  const row = await env.PLATFORM_DB.prepare(`SELECT id,operation_id,request_sha256,provider_request_id,provider_status,estimated_usd,error_code
    FROM assistant_higgsfield_requests WHERE id=? AND account_id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=?`)
    .bind(requestId, accountId, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId).first<RequestRow>();
  if (!row) throw new Error("higgsfield_request_unavailable");
  return publicRequest(env, scope, identity, accountId, row);
}

export async function listHiggsfieldRequests(env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, accountId: string) {
  const account = await accountFor(env, scope, identity, accountId);
  const rows = await env.PLATFORM_DB.prepare(`SELECT id,operation_id,request_sha256,provider_request_id,provider_status,estimated_usd,error_code
    FROM assistant_higgsfield_requests WHERE account_id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=?
    ORDER BY created_at DESC LIMIT 20`)
    .bind(account.id, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId).all<RequestRow>();
  const requests = [];
  for (const row of rows.results) requests.push(await publicRequest(env, scope, identity, account.id, row));
  return { requests };
}

export async function refreshHiggsfieldRequest(
  env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, accountId: string, requestId: string,
) {
  const account = await accountFor(env, scope, identity, accountId);
  const local = await env.PLATFORM_DB.prepare(`SELECT id,operation_id,request_sha256,provider_request_id,provider_status_url,provider_cancel_url,provider_status,estimated_usd,error_code
    FROM assistant_higgsfield_requests WHERE id=? AND account_id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=?`)
    .bind(requestId, account.id, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId).first<RequestRow>();
  if (!local) throw new Error("higgsfield_request_unavailable");
  if (!local.provider_request_id || local.provider_status === "unknown" || local.provider_status === "submitting") return publicRequest(env, scope, identity, account.id, local);
  if (TERMINAL.has(local.provider_status)) return publicRequest(env, scope, identity, account.id, local);
  const key = await apiKeyFor(env, identity, account);
  if (!local.provider_status_url || trustedProviderPath(`${API_ORIGIN}${local.provider_status_url}`, local.provider_request_id, "status") !== local.provider_status_url) {
    throw new Error("higgsfield_provider_response_invalid");
  }
  const result = await providerJson(key, local.provider_status_url, "GET");
  const status = typeof result.status === "string" ? result.status : "";
  if (!["queued", "in_progress", "completed", "failed", "nsfw", "canceled"].includes(status)) throw new Error("higgsfield_provider_response_invalid");
  let sealed: { ciphertext: string; iv: string } | undefined;
  const video = result.video && typeof result.video === "object" && !Array.isArray(result.video) ? result.video as Record<string, unknown> : null;
  if (status === "completed" && video && typeof video.url === "string") {
    try {
      const outputUrl = new URL(video.url);
      if (outputUrl.protocol !== "https:" || outputUrl.username || outputUrl.password) throw new Error("invalid_url");
      sealed = await sealCommunication(env, identity, local.id, { videoUrl: outputUrl.toString() });
    } catch { throw new Error("higgsfield_provider_response_invalid"); }
  }
  const providerExpiresAt = typeof result.expires_at === "string" && Number.isFinite(Date.parse(result.expires_at)) ? result.expires_at : null;
  const at = new Date().toISOString();
  const errorCode = status === "failed" ? "provider_generation_failed" : status === "nsfw" ? "provider_moderated" : null;
  const operationStatus = status === "completed" ? "complete" : status === "canceled" ? "cancelled" : status === "failed" || status === "nsfw" ? "failed" : "running";
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`UPDATE assistant_higgsfield_requests SET provider_status=?,error_code=?,result_ciphertext=COALESCE(?,result_ciphertext),
      result_iv=COALESCE(?,result_iv),provider_expires_at=COALESCE(?,provider_expires_at),updated_at=? WHERE id=? AND provider_request_id=?`)
      .bind(status, errorCode, sealed?.ciphertext ?? null, sealed?.iv ?? null, providerExpiresAt, at, local.id, local.provider_request_id),
    env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status=?,error_code=?,updated_at=? WHERE operation_id=? AND provider_operation_ref=? AND status IN ('running','uncertain')`)
      .bind(operationStatus, errorCode, at, local.operation_id, local.provider_request_id),
  ]);
  return getHiggsfieldRequest(env, scope, identity, account.id, local.id);
}

export async function cancelHiggsfieldRequest(
  env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, accountId: string, requestId: string,
) {
  const account = await accountFor(env, scope, identity, accountId);
  const local = await env.PLATFORM_DB.prepare(`SELECT id,operation_id,request_sha256,provider_request_id,provider_status_url,provider_cancel_url,provider_status,estimated_usd,error_code
    FROM assistant_higgsfield_requests WHERE id=? AND account_id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=?`)
    .bind(requestId, account.id, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId).first<RequestRow>();
  if (!local) throw new Error("higgsfield_request_unavailable");
  if (local.provider_status === "canceled") return { cancelled: true, request: await publicRequest(env, scope, identity, account.id, local) };
  if (!local.provider_request_id || local.provider_status !== "queued") throw new Error("higgsfield_request_not_cancellable");
  if (!local.provider_cancel_url || trustedProviderPath(`${API_ORIGIN}${local.provider_cancel_url}`, local.provider_request_id, "cancel") !== local.provider_cancel_url) {
    throw new Error("higgsfield_provider_response_invalid");
  }
  const key = await apiKeyFor(env, identity, account);
  const response = await providerRequest(key, local.provider_cancel_url, "POST");
  if (response.status !== 202) throw new Error("higgsfield_cancel_not_confirmed");
  const at = new Date().toISOString();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`UPDATE assistant_higgsfield_requests SET provider_status='canceled',updated_at=? WHERE id=? AND provider_status='queued'`)
      .bind(at, local.id),
    env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='cancelled',updated_at=? WHERE operation_id=? AND status='running'`)
      .bind(at, local.operation_id),
  ]);
  return { cancelled: true, request: await getHiggsfieldRequest(env, scope, identity, account.id, local.id) };
}

/** Explicitly erase this owner's finished provider request and locally encrypted output URL. */
export async function deleteHiggsfieldRequest(
  env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, accountId: string, requestId: string,
) {
  const account = await accountFor(env, scope, identity, accountId);
  const local = await env.PLATFORM_DB.prepare(`SELECT id,operation_id,request_sha256,provider_request_id,provider_status,estimated_usd,error_code
    FROM assistant_higgsfield_requests WHERE id=? AND account_id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=?`)
    .bind(requestId, account.id, scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.userId).first<RequestRow>();
  if (!local) throw new Error("higgsfield_request_unavailable");
  if (!local.provider_request_id || !TERMINAL.has(local.provider_status)) throw new Error("higgsfield_request_not_deletable");
  if (local.provider_status !== "deleted") {
    const key = await apiKeyFor(env, identity, account);
    const response = await providerRequest(key, `/requests/${encodeURIComponent(local.provider_request_id)}`, "DELETE");
    if (response.body.status !== "deleted" && response.status !== 204) throw new Error("higgsfield_delete_not_confirmed");
    await env.PLATFORM_DB.prepare(`UPDATE assistant_higgsfield_requests SET provider_status='deleted',result_ciphertext=NULL,result_iv=NULL,
      updated_at=? WHERE id=? AND account_id=? AND owner_user_id=? AND provider_request_id=? AND provider_status IN ('completed','failed','nsfw','canceled','deleted')`)
      .bind(new Date().toISOString(), local.id, account.id, scope.userId, local.provider_request_id).run();
  }
  return { deleted: true, request: await getHiggsfieldRequest(env, scope, identity, account.id, local.id) };
}

export async function revokeHiggsfieldAccount(env: AgentsEnv, scope: CommunicationScope, identity: CommunicationIdentity, accountId: string) {
  const account = await accountFor(env, scope, identity, accountId);
  const at = new Date().toISOString();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("UPDATE assistant_higgsfield_accounts SET status='revoked',credential_ciphertext='',credential_iv='',updated_at=? WHERE id=? AND owner_user_id=? AND status='active'")
      .bind(at, account.id, scope.userId),
    env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET lifecycle_state='revoked',updated_at=? WHERE id=? AND tenant_id=? AND owner_id=?")
      .bind(at, account.id, scope.tenantId, scope.userId),
  ]);
  return { revoked: true, accountId: account.id };
}

/** Read-only scheduled polling for accepted jobs. Unknown submissions are left for an owner to
 *  retry with the original idempotency key and a fresh estimate. */
export async function sweepHiggsfieldRequests(env: AgentsEnv, now = new Date(), limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new Error("higgsfield_reconciliation_limit_invalid");
  const before = new Date(now.getTime() - 2 * 60_000).toISOString();
  const due = await env.PLATFORM_DB.prepare(`SELECT r.id,r.account_id,r.tenant_id,r.space_id,r.project_id,r.owner_user_id,a.assistant_identity_id
    FROM assistant_higgsfield_requests r JOIN assistant_higgsfield_accounts a ON a.id=r.account_id
    WHERE r.provider_status IN ('queued','in_progress') AND r.provider_request_id IS NOT NULL AND r.updated_at<=?
      AND a.status='active' ORDER BY r.updated_at LIMIT ?`)
    .bind(before, limit).all<{ id: string; account_id: string; tenant_id: string; space_id: string; project_id: string | null;
      owner_user_id: string; assistant_identity_id: string }>();
  const result = { checked: 0, reconciled: 0, deferred: 0, failed: 0 };
  for (const row of due.results) {
    result.checked++;
    try {
      const identity = await env.PLATFORM_DB.prepare(`SELECT * FROM assistant_communication_identities
        WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=? AND status='active'`)
        .bind(row.assistant_identity_id, row.tenant_id, row.space_id, row.project_id, row.owner_user_id).first<CommunicationIdentity>();
      if (!identity) { result.deferred++; continue; }
      const scope: CommunicationScope = { tenantId: row.tenant_id, spaceId: row.space_id, userId: row.owner_user_id,
        role: "owner", ...(row.project_id ? { projectId: row.project_id } : {}) };
      const request = await refreshHiggsfieldRequest(env, scope, identity, row.account_id, row.id);
      if (TERMINAL.has(request.status)) result.reconciled++;
      else result.deferred++;
    } catch { result.failed++; }
  }
  return result;
}
