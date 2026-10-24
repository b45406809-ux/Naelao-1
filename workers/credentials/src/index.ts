import { checkedAudioStream, isOpenRouterSpeechStream } from "./audio-stream.js";
// G-C01: Credentials worker — encrypted per-Space credential storage.
//
// Credential hierarchy: a credential is resolved for an acting user and signed project context;
// the privileged override remains the highest-precedence space credential.
//   1. space-scope row with is_override=1  — privileged (owner/admin) override, always wins
//   2. user-scope row for the acting user  — personal credential (the per-user default)
//   3. project-bound row                    — available only with a signed project credential token
//   4. space-scope row with is_override=0  — shared business-wide fallback (optionally narrowed
//      to specific members via shared_with_user_ids — NULL means everyone, unchanged default)
//   5. the PRODUCT ROOT's own space-scope row — a builder-set product-wide default, checked only
//      when this space is a business (has parent_space_id) and nothing matched above
// A caller above this worker (mcp-hub, a prebuilt op) applies its own final fallback — a
// Naelao-held platform Workers Secret (Tavily, etc, item 42's universal-tools doctrine) — when
// this worker returns nothing at all; that tier is deliberately NOT a vaulted DB row here (see
// CLAUDE.md's item on naelao-wide fallback billing).
// See resolveCredential() below and infra/migrations/0040_space_credentials.sql +
// infra/migrations/0069_credential_sharing_and_product_tier.sql.
import { badRequest, errorResponse, forbidden, mintInternalToken, notFound, requestId, requireInternalHmac, readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";
import { decryptAuthenticated, encryptAuthenticated, generateDek, unwrapDek, wrapDek, type EncryptedEnvelope } from "@naelao/crypto";
import { Hono } from "hono";
import { authorizeEgressRedirect, authorizeEgressUrl, isSpaceNetworkEgressDenied, readSpaceEgressPolicy, scanAndScrubEgress } from "@naelao/security";

// ── Env ───────────────────────────────────────────────────────────────────────

export interface CredentialsEnv {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  PLATFORM_DB: D1Database;
  ANALYTICS: AnalyticsEngineDataset;
  // Optional: lets a resolved fallback (the acting user didn't get their own personal
  // credential) notify the assistant via SpaceDO's generic event ingress. Best-effort —
  // resolution/decryption never depends on this being wired.
  SPACES_WORKER?: Fetcher;
}

/** Fire credential.fallback_used through SpaceDO's existing generic external-event ingress
 *  (same pattern as workers/billing's fireWalletEvent) — best-effort, never blocks a resolved
 *  credential read. Only fired when a specific acting user was named and didn't get their own
 *  personal credential, so this is signal ("you're running on someone/something else's
 *  credential"), not noise on every ordinary space-level resolution with no acting user. */
async function fireCredentialFallbackEvent(
  env: CredentialsEnv,
  params: { tenantId: string; spaceId: string; name: string; actingUserId: string; tier: CredentialResolvedTier }
): Promise<void> {
  if (!env.SPACES_WORKER) return;
  try {
    await env.SPACES_WORKER.fetch(
      new Request(`http://spaces-worker/internal/spaces/${encodeURIComponent(params.spaceId)}/events/fire`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": params.tenantId,
          "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, params.tenantId),
        },
        body: JSON.stringify({
          type: "credential.fallback_used",
          space_id: params.spaceId,
          payload: { connector: params.name, requested_by: params.actingUserId, resolved_tier: params.tier },
        }),
      })
    );
  } catch {
    // Best-effort — the credential read itself already succeeded.
  }
}

interface OutboundReceiptContext {
  tenantId: string; spaceId: string; actorId: string; runId: string; taskId?: string;
  agentId: string; traceId: string; spanId: string; actionId: string; idempotencyKey: string;
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function isActiveTenantSpace(db: D1Database, spaceId: string, tenantId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT s.id FROM spaces s JOIN orgs o ON o.id = s.tenant_id AND o.status = 'active'
     WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'active'`
  ).bind(spaceId, tenantId).first<{ id: string }>();
  return row !== null;
}

async function recordOutboundReceipt(
  env: CredentialsEnv,
  context: OutboundReceiptContext,
  phase: "pending" | "succeeded" | "failed" | "unknown",
  inputHash: string,
  outputHash: string,
  summary: string,
): Promise<{ replayed: boolean; outcome: string }> {
  if (!env.SPACES_WORKER) throw new Error("action_receipt_store_unavailable");
  const phaseKey = `${context.idempotencyKey}:${phase === "pending" ? "pending" : "final"}`;
  const response = await env.SPACES_WORKER.fetch(new Request(
    `http://spaces-worker/internal/spaces/${encodeURIComponent(context.spaceId)}/action-receipts`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": context.tenantId,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, context.tenantId),
      },
      body: JSON.stringify({
        tenant_id: context.tenantId,
        space_id: context.spaceId,
        action_id: context.actionId,
        idempotency_key: phaseKey,
        actor_id: context.actorId,
        run_id: context.runId,
        task_id: context.taskId ?? null,
        worker_id: context.agentId,
        trace_id: context.traceId,
        span_id: context.spanId,
        action: "outbound.fetch",
        input_hash: inputHash,
        output_hash: outputHash,
        grant_id: null,
        cost_micros: 0,
        outcome: phase,
        decision_summary: summary.slice(0, 512),
      }),
    },
  ));
  if (!response.ok) throw new Error("action_receipt_persistence_failed");
  const result = await response.json<{ receipt?: { outcome?: string }; replayed?: boolean }>()
    .catch((): { receipt?: { outcome?: string }; replayed?: boolean } => ({}));
  return { replayed: result.replayed === true, outcome: result.receipt?.outcome ?? phase };
}

async function readBoundedResponse(response: Response, limit = 8 * 1024 * 1024): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error("egress_response_too_large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export function redactOutboundSecrets(input: Uint8Array, secrets: string[]): Uint8Array {
  const needles = secrets.map((secret) => new TextEncoder().encode(secret)).filter((needle) => needle.length > 0);
  if (!needles.some((needle) => needle.length <= input.length)) return input;
  const replacement = new TextEncoder().encode("[REDACTED]");
  const redact = (source: Uint8Array, needle: Uint8Array): Uint8Array => {
    if (needle.length > source.length) return source;
    const table = new Uint32Array(needle.length);
    for (let i = 1, prefix = 0; i < needle.length; i++) {
      while (prefix > 0 && needle[i] !== needle[prefix]) prefix = table[prefix - 1]!;
      if (needle[i] === needle[prefix]) prefix++;
      table[i] = prefix;
    }
    let matched = 0;
    let count = 0;
    for (let i = 0; i < source.length; i++) {
      while (matched > 0 && source[i] !== needle[matched]) matched = table[matched - 1]!;
      if (source[i] === needle[matched]) matched++;
      if (matched === needle.length) {
        count++;
        matched = 0;
      }
    }
    if (count === 0) return source;
    const outputLength = source.length + count * (replacement.length - needle.length);
    if (outputLength > 16 * 1024 * 1024) return new TextEncoder().encode("[REDACTED: upstream response omitted]");
    const output = new Uint8Array(outputLength);
    let cursor = 0;
    let offset = 0;
    matched = 0;
    for (let i = 0; i < source.length; i++) {
      while (matched > 0 && source[i] !== needle[matched]) matched = table[matched - 1]!;
      if (source[i] === needle[matched]) matched++;
      if (matched === needle.length) {
        const end = i + 1;
        const start = end - needle.length;
        output.set(source.subarray(cursor, start), offset);
        offset += start - cursor;
        output.set(replacement, offset);
        offset += replacement.length;
        cursor = end;
        matched = 0;
      }
    }
    output.set(source.subarray(cursor), offset);
    return output;
  };
  return needles.reduce((source, needle) => redact(source, needle), input);
}

function validateEnv(env: CredentialsEnv): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error("Missing required secret: CREDENTIAL_ENCRYPTION_KEY");
  }
  validateEncryptionKeyEnv(env.CREDENTIAL_ENCRYPTION_KEY);
  const previousKey = (env as CredentialsEnv & { CREDENTIAL_ENCRYPTION_KEY_PREV?: string }).CREDENTIAL_ENCRYPTION_KEY_PREV;
  if (previousKey) validateEncryptionKeyEnv(previousKey);
}

function validateEncryptionKeyEnv(value: string): void {
  const parsed = parseKeyEnv(value);
  if (!/^v[1-9][0-9]*$/.test(parsed.version) || !/^[0-9a-fA-F]{64}$/.test(parsed.hex)) {
    throw new Error("Invalid credential encryption key configuration; expected v<N>:<64 hex characters>");
  }
}

// ── Hex encode/decode helpers ─────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string length");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (isNaN(byte)) throw new Error(`Invalid hex character at position ${i * 2}`);
    bytes[i] = byte;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── AES-256-GCM encryption helpers ───────────────────────────────────────────
// G-D05: Credentials store a key_version alongside each encrypted record.
// On key rotation: new encryptions use the new key version; old records can be
// re-encrypted by reading them with the old key and re-writing with the new key.
// The CREDENTIAL_ENCRYPTION_KEY env var encodes "v<N>:<hex-key>", e.g. "v2:<32bytes-hex>".

// G-AH07: Per-space key hierarchy. Root key is CREDENTIAL_ENCRYPTION_KEY.
// Per-space key is derived via HKDF(root_key, "naelao-cred-v1:<spaceId>").
// This means a single-key compromise only yields the root; space keys are non-extractable.

function parseKeyEnv(keyEnv: string): { version: string; hex: string } {
  const colonIdx = keyEnv.indexOf(":");
  if (colonIdx > 0 && keyEnv[0] === "v") {
    return { version: keyEnv.slice(0, colonIdx), hex: keyEnv.slice(colonIdx + 1) };
  }
  // Legacy: no version prefix — treat as v1. Validation still enforces a 256-bit key.
  return { version: "v1", hex: keyEnv };
}

type CredentialAad = Pick<CredentialRow, "space_id" | "tenant_id" | "name" | "scope" | "user_id" | "project_id">;

export type CredentialScope = "SPACE_SHARED" | "PROJECT_BOUND" | "USER_PERSONAL";

function credentialScopeForRow(row: Pick<CredentialRow, "scope" | "project_id">): CredentialScope {
  if (row.project_id) return "PROJECT_BOUND";
  return row.scope === "user" ? "USER_PERSONAL" : "SPACE_SHARED";
}

function credentialAad(row: CredentialAad): string {
  // A fixed-position tuple is stable across runtimes and prevents ciphertext from being
  // transplanted to another tenant, credential, owner, or scope.
  return JSON.stringify(["naelao-credential-v1", row.tenant_id, row.space_id, row.name, row.scope, row.user_id, row.project_id]);
}

// G-AH07: Derive a per-space AES-256-GCM key from the root key using HKDF-SHA256.
// The info string binds the derivation to the specific space — compromise of one
// space's derived key cannot be used to decrypt another space's credentials.
async function deriveSpaceKey(rootKeyHex: string, spaceId: string): Promise<CryptoKey> {
  const rootBytes = hexToBytes(rootKeyHex);
  const rootKey = await crypto.subtle.importKey("raw", rootBytes, { name: "HKDF" }, false, ["deriveBits"]);
  const info = new TextEncoder().encode(`naelao-cred-v1:${spaceId}`);
  const salt = new Uint8Array(32); // zero salt (info provides domain separation)
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    rootKey,
    256
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function deriveSpaceKek(rootKeyHex: string, tenantId: string, spaceId: string): Promise<CryptoKey> {
  const rootBytes = hexToBytes(rootKeyHex);
  const rootKey = await crypto.subtle.importKey("raw", rootBytes, { name: "HKDF" }, false, ["deriveBits"]);
  const info = new TextEncoder().encode(`naelao-vault-kek-v1:${tenantId}:${spaceId}`);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
    rootKey,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encrypt(
  plaintext: string,
  db: D1Database,
  env: CredentialsEnv,
  tenantId: string,
  spaceId: string,
  aadRow: CredentialAad,
): Promise<{ ciphertext: string; iv: string; key_version: string }> {
  const { version } = parseKeyEnv(env.CREDENTIAL_ENCRYPTION_KEY);
  const dek = await getSpaceDek(db, env, tenantId, spaceId, true);
  const envelope = await encryptAuthenticated(plaintext, dek, credentialAad(aadRow));
  return { ciphertext: `a2:${envelope.ciphertext}`, iv: envelope.iv, key_version: version };
}

async function decrypt(ciphertext: string, iv: string, env: CredentialsEnv, db: D1Database, tenantId: string, spaceId: string, aadRow: CredentialRow): Promise<string> {
  if (ciphertext.startsWith("a2:")) {
    const dek = await getSpaceDek(db, env, tenantId, spaceId, false);
    const envelope: EncryptedEnvelope = { ciphertext: ciphertext.slice(3), iv, algorithm: "aes-256-gcm" };
    return decryptAuthenticated(envelope, dek, credentialAad(aadRow));
  }
  const rootHex = resolveRootKeyHex(env, aadRow.key_version);
  // G-AH07: Derive the same per-space key for decryption
  const spaceKey = await deriveSpaceKey(rootHex, spaceId);
  if (ciphertext.startsWith("a1:")) {
    const envelope: EncryptedEnvelope = { ciphertext: ciphertext.slice(3), iv, algorithm: "aes-256-gcm" };
    return decryptAuthenticated(envelope, spaceKey, credentialAad(aadRow));
  }
  // Legacy rows predate authenticated metadata. They remain readable during migration; all
  // new and updated rows use the authenticated `a1:` envelope above.
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBytes(iv) }, spaceKey, hexToBytes(ciphertext));
  return new TextDecoder().decode(decrypted);
}

/**
 * A per-space data-encryption key is wrapped by a per-space KEK derived from the versioned
 * platform root secret. Existing DEKs are transparently rewrapped when the active root version
 * changes; ciphertext rows do not need to be rewritten during root-key rotation.
 */
async function getSpaceDek(
  db: D1Database,
  env: CredentialsEnv,
  tenantId: string,
  spaceId: string,
  create: boolean,
): Promise<CryptoKey> {
  const active = parseKeyEnv(env.CREDENTIAL_ENCRYPTION_KEY);
  const lookup = async () => db.prepare(
    "SELECT wrapped_dek, key_version FROM space_credential_keys WHERE tenant_id = ? AND space_id = ? LIMIT 1",
  ).bind(tenantId, spaceId).first<{ wrapped_dek: string; key_version: string }>();
  let row = await lookup();
  if (row) {
    const wrappingRoot = resolveRootKeyHex(env, row.key_version);
    const dek = await unwrapDek(row.wrapped_dek, await deriveSpaceKek(wrappingRoot, tenantId, spaceId));
    if (row.key_version !== active.version) {
      const newWrapped = await wrapDek(dek, await deriveSpaceKek(active.hex, tenantId, spaceId));
      await db.prepare(
        "UPDATE space_credential_keys SET wrapped_dek = ?, key_version = ?, updated_at = ? WHERE tenant_id = ? AND space_id = ?",
      ).bind(newWrapped, active.version, new Date().toISOString(), tenantId, spaceId).run();
    }
    return dek;
  }
  if (!create) throw new Error("credential_data_key_unavailable");

  const dek = await generateDek();
  const wrapped = await wrapDek(dek, await deriveSpaceKek(active.hex, tenantId, spaceId));
  await db.prepare(
    `INSERT OR IGNORE INTO space_credential_keys (tenant_id, space_id, wrapped_dek, key_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(tenantId, spaceId, wrapped, active.version, new Date().toISOString(), new Date().toISOString()).run();
  row = await lookup();
  if (!row) throw new Error("credential_data_key_unavailable");
  if (row.wrapped_dek === wrapped) return dek;
  const existingRoot = resolveRootKeyHex(env, row.key_version);
  return unwrapDek(row.wrapped_dek, await deriveSpaceKek(existingRoot, tenantId, spaceId));
}

/** Resolve the root key hex matching a stored row's key_version (handles rotation). */
function resolveRootKeyHex(
  env: CredentialsEnv,
  rowVersion: string | null
): string {
  const { version: currentVersion, hex: currentHex } = parseKeyEnv(env.CREDENTIAL_ENCRYPTION_KEY);
  const effectiveRowVersion = rowVersion ?? "v1";
  if (effectiveRowVersion === currentVersion) return currentHex;
  const prevKey = (env as CredentialsEnv & { CREDENTIAL_ENCRYPTION_KEY_PREV?: string }).CREDENTIAL_ENCRYPTION_KEY_PREV;
  if (prevKey) {
    const { version: prevVersion, hex: prevHex } = parseKeyEnv(prevKey);
    if (effectiveRowVersion === prevVersion) return prevHex;
  }
  throw new Error("credential_encryption_key_version_unavailable");
}

// ── G-F06: Short-lived per-request HMAC token for internal credential access ──
// Token format: "t=<unix-seconds>,aid=<agentId>,v1=<hmac-hex>"
// HMAC payload:  "<spaceId>:<agentId>:<timestamp>"
// Token expires after 60 seconds.

export async function generateCredentialToken(
  platformSecret: string,
  spaceId: string,
  agentId: string,
  projectId?: string,
  tenantId?: string,
  context?: { actorId?: string; runId?: string; taskId?: string; traceId?: string; spanId?: string; purpose?: "assistant-audio" },
): Promise<string> {
  const contextValues = context ? Object.values(context).filter((value): value is string => Boolean(value)) : [];
  if (![spaceId, agentId, ...(projectId ? [projectId] : []), ...(tenantId ? [tenantId] : []), ...contextValues].every((value) => /^[A-Za-z0-9._:-]{1,160}$/.test(value))) {
    throw new Error("invalid_credential_token_scope");
  }
  if (context?.traceId && !/^[a-f0-9]{32}$/i.test(context.traceId)) throw new Error("invalid_credential_trace_context");
  if (context?.spanId && !/^[a-f0-9]{16}$/i.test(context.spanId)) throw new Error("invalid_credential_trace_context");
  const timestamp = Math.floor(Date.now() / 1000);
  const hasRunContext = Boolean(context && Object.values(context).some(Boolean));
  const signingInput = tenantId && hasRunContext
    ? `${tenantId}:${spaceId}:${agentId}:${projectId ?? ""}:${context?.actorId ?? ""}:${context?.runId ?? ""}:${context?.taskId ?? ""}:${context?.traceId ?? ""}:${context?.spanId ?? ""}:${timestamp}`
    : tenantId
    ? `${tenantId}:${spaceId}:${agentId}:${projectId ?? ""}:${timestamp}`
    : projectId ? `${spaceId}:${agentId}:${projectId}:${timestamp}` : `${spaceId}:${agentId}:${timestamp}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput + (context?.purpose ? `:${context.purpose}` : "")));
  const hexSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (tenantId && hasRunContext) return `t=${timestamp},aid=${agentId},tid=${tenantId}${projectId ? `,pid=${projectId}` : ""}${context?.actorId ? `,uid=${context.actorId}` : ""}${context?.runId ? `,rid=${context.runId}` : ""}${context?.taskId ? `,task=${context.taskId}` : ""}${context?.traceId ? `,tr=${context.traceId}` : ""}${context?.spanId ? `,sp=${context.spanId}` : ""}${context?.purpose ? `,purpose=${context.purpose},v5=${hexSig}` : `,v4=${hexSig}`}`;
  if (tenantId) return `t=${timestamp},aid=${agentId},tid=${tenantId}${projectId ? `,pid=${projectId}` : ""},v3=${hexSig}`;
  return projectId ? `t=${timestamp},aid=${agentId},pid=${projectId},v2=${hexSig}` : `t=${timestamp},aid=${agentId},v1=${hexSig}`;
}

export async function verifyCredentialToken(
  token: string,
  platformSecret: string,
  expectedSpaceId: string,
  expectedTenantId: string,
): Promise<{ ok: boolean; reason?: string; projectId?: string; tenantId?: string; agentId?: string; actorId?: string; runId?: string; taskId?: string; traceId?: string; spanId?: string; purpose?: "assistant-audio" }> {
  const TOKEN_MAX_AGE_SECONDS = 60;
  if (token.length > 2048) return { ok: false, reason: "Malformed credential token" };
  const parts: Record<string, string> = {};
  for (const segment of token.split(",")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) return { ok: false, reason: "Malformed credential token" };
    const key = segment.slice(0, eq);
    if (Object.hasOwn(parts, key)) return { ok: false, reason: "Malformed credential token" };
    parts[key] = segment.slice(eq + 1);
  }
  const timestampValue = parts["t"] ?? "";
  const timestamp = /^\d{1,12}$/.test(timestampValue) ? Number(timestampValue) : Number.NaN;
  const agentId = parts["aid"] ?? "";
  const projectId = parts["pid"] || undefined;
  const tenantId = parts["tid"] || undefined;
  const actorId = parts["uid"] || undefined;
  const runId = parts["rid"] || undefined;
  const taskId = parts["task"] || undefined;
  const traceId = parts["tr"] || undefined;
  const spanId = parts["sp"] || undefined;
  const hasRunContext = Boolean(actorId || runId || taskId || traceId || spanId);
  const purpose = parts["purpose"];
  if (purpose !== undefined && (purpose !== "assistant-audio" || !hasRunContext || !tenantId)) return { ok: false, reason: "Invalid credential purpose" };
  const signatureKey = purpose ? "v5" : hasRunContext ? "v4" : tenantId ? "v3" : projectId ? "v2" : "v1";
  const versionKeys = Object.keys(parts).filter((key) => /^v\d+$/.test(key));
  const allowedKeys = new Set(["t", "aid", "pid", "tid", "uid", "rid", "task", "tr", "sp", ...(purpose ? ["purpose"] : []), signatureKey]);
  const receivedHex = parts[signatureKey] ?? "";

  if (Object.keys(parts).some((key) => !allowedKeys.has(key)) || versionKeys.length !== 1 || versionKeys[0] !== signatureKey || !agentId || !/^[a-f0-9]{64}$/i.test(receivedHex)) return { ok: false, reason: "Malformed credential token" };
  if (tenantId && tenantId !== expectedTenantId) return { ok: false, reason: "Credential token tenant scope mismatch" };

  const age = Math.floor(Date.now() / 1000) - timestamp;
  if (!Number.isSafeInteger(timestamp) || age < 0 || age > TOKEN_MAX_AGE_SECONDS) {
    return { ok: false, reason: `Credential token expired (age=${age}s)` };
  }

  if (hasRunContext && (!tenantId || !actorId || !runId || !traceId || !spanId || !/^[a-f0-9]{32}$/i.test(traceId) || !/^[a-f0-9]{16}$/i.test(spanId))) {
    return { ok: false, reason: "Malformed credential run context" };
  }
  const signingInput = tenantId && hasRunContext
    ? `${tenantId}:${expectedSpaceId}:${agentId}:${projectId ?? ""}:${actorId ?? ""}:${runId ?? ""}:${taskId ?? ""}:${traceId ?? ""}:${spanId ?? ""}:${timestamp}`
    : tenantId
    ? `${tenantId}:${expectedSpaceId}:${agentId}:${projectId ?? ""}:${timestamp}`
    : projectId ? `${expectedSpaceId}:${agentId}:${projectId}:${timestamp}` : `${expectedSpaceId}:${agentId}:${timestamp}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const expectedSigBytes = new Uint8Array(
    (receivedHex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    expectedSigBytes,
    new TextEncoder().encode(signingInput + (purpose ? `:${purpose}` : ""))
  );
  if (!valid) return { ok: false, reason: "Invalid credential token signature" };
  return { ok: true, agentId, ...(purpose ? { purpose: purpose as "assistant-audio" } : {}), ...(projectId ? { projectId } : {}), ...(tenantId ? { tenantId } : {}), ...(actorId ? { actorId } : {}), ...(runId ? { runId } : {}), ...(taskId ? { taskId } : {}), ...(traceId ? { traceId } : {}), ...(spanId ? { spanId } : {}) };
}

// ── Validation ────────────────────────────────────────────────────────────────

// Plain "gmail" or a multi-slot "gmail::work" — the slot suffix lets one user hold several
// named credentials on the same connector (e.g. a personal vs a work Gmail) with no schema
// change: each slot is just a distinct credential name under the existing (space,name,scope
// [,user]) uniqueness rules. The base connector id and the slot label are each capped like a
// plain name would be.
const CREDENTIAL_NAME_RE = /^[A-Za-z0-9_]{1,64}(::[A-Za-z0-9_]{1,32})?$/;
const PRIVILEGED_ROLES = new Set(["owner", "admin"]);

function validateCredentialName(name: string): void {
  if (!CREDENTIAL_NAME_RE.test(name)) {
    throw badRequest(
      "Credential name must be 1–64 characters (alphanumeric/underscore), optionally followed by ::slot (1–32 alphanumeric/underscore)"
    );
  }
}

/** Build provider authorization only after the vault resolves the secret. Caller headers never control this value. */
export function buildOutboundAuthorization(secret: string, auth?: { type: "basic"; username: string }): string {
  if (auth?.type === "basic") {
    if (!/^[\x20-\x7e]{1,128}$/.test(auth.username) || auth.username.includes(":")) throw new Error("egress_auth_invalid");
    const bytes = new TextEncoder().encode(`${auth.username}:${secret}`);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return `Basic ${btoa(binary)}`;
  }
  return `Bearer ${secret}`;
}

export function headersForEgressRedirect(current: URL, next: URL, headers: Headers): Headers {
  const forwarded = new Headers(headers);
  if (current.origin !== next.origin) forwarded.delete("authorization");
  return forwarded;
}

/** Rebuild an upstream response after secret redaction without retaining stale entity metadata. */
export function buildOutboundResponse(response: Response, bytes: Uint8Array, secrets: string[] = []): Response {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (/^(set-cookie|authorization|proxy-authenticate|www-authenticate)$/i.test(name) || secrets.some((secret) => secret && value.includes(secret))) continue;
    headers.append(name, value);
  }
  // Secret removal can change bytes and their digests. Let the runtime calculate framing for
  // the replacement body rather than forwarding the origin's now-stale representation metadata.
  for (const name of ["content-length", "content-md5", "digest", "etag", "content-range", "accept-ranges"]) {
    headers.delete(name);
  }
  const body = [204, 205, 304].includes(response.status) ? null : bytes;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function isPrivileged(role: string): boolean {
  return PRIVILEGED_ROLES.has(role);
}

// ── Credential hierarchy: row shape + resolution ─────────────────────────────

interface CredentialRow {
  id: string;
  space_id: string;
  tenant_id: string;
  name: string;
  scope: "user" | "space";
  project_id: string | null;
  user_id: string | null;
  is_override: number;
  shared_with_user_ids: string | null;
  encrypted_value: string;
  iv: string;
  key_version: string | null;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type CredentialResolvedTier = "business_override" | "project_bound" | "user" | "business_shared" | "product";

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function parseSharedUserIds(serialized: string | null): string[] | null {
  if (serialized === null) return null; // NULL = shared with everyone
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed) || parsed.length > 100 || parsed.some((id) =>
      typeof id !== "string" || id.length === 0 || id.length > 128 || hasControlCharacters(id)
    )) return []; // malformed persisted data must fail closed
    return [...new Set(parsed)];
  } catch {
    return []; // corrupted/legacy data never widens access
  }
}

function validateSharedUserIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 100 || value.some((id) =>
    typeof id !== "string" || id.trim().length === 0 || id.length > 128 || hasControlCharacters(id)
  )) {
    throw badRequest("shared_with_user_ids must contain at most 100 valid user ids, or be null");
  }
  return [...new Set(value)];
}

/** Does a business-shared row (is_override=0) apply to this specific acting user? */
function sharedRowAppliesToUser(row: CredentialRow, actingUserId: string | null): boolean {
  const allowed = parseSharedUserIds(row.shared_with_user_ids);
  if (allowed === null) return true; // NULL = shared with everyone
  if (!actingUserId) return false; // a selective share needs a known acting user to match against
  return allowed.includes(actingUserId);
}

async function fetchSpaceRow(
  db: D1Database,
  spaceId: string,
  tenantId: string,
  name: string
): Promise<CredentialRow | null> {
  return db.prepare(
    `SELECT * FROM space_credentials WHERE space_id = ? AND tenant_id = ? AND name = ? AND scope = 'space' AND project_id IS NULL LIMIT 1`
  ).bind(spaceId, tenantId, name).first<CredentialRow>();
}

/**
 * Resolve the effective credential row for (spaceId, name, actingUserId) per the hierarchy:
 *   1. space-scope row with is_override=1        (privileged override — always wins)
 *   2. user-scope row for actingUserId            (personal, default)
 *   3. project-bound row for a signed project context
 *   4. space-scope row with is_override=0         (business-shared fallback, optionally narrowed
 *      to specific members via shared_with_user_ids)
 *   5. the PRODUCT ROOT's own space-scope row     (product-wide default — only when this space
 *      has a parent, i.e. is a business, and nothing above matched)
 * actingUserId may be omitted (e.g. an agent acting on behalf of the space as a whole, not a
 * specific member) — resolution then skips tier 2 and treats a narrowed tier-3 row as absent.
 * A caller's own further fallback (a Naelao platform-secret key) happens OUTSIDE this function
 * when it returns null — that tier is never a space_credentials row.
 */
async function resolveCredential(
  db: D1Database,
  spaceId: string,
  tenantId: string,
  name: string,
  actingUserId: string | null,
  projectId: string | null,
  /** §A1 connector default-vs-personal switch: an explicit ask from the caller for WHICH tier to
   *  use, overriding the implicit "personal always wins when connected" default below.
   *  "business": skip tier 2 entirely (a member's own personal credential is ignored even if one
   *  exists) — the chat surface's default mode, so a shared business account is used unless the
   *  caller deliberately switched. "personal": REQUIRE tier 2 — a missing personal credential is
   *  reported distinctly (personal_required), never silently substituted with the shared one,
   *  since that's exactly the "forgot to switch" case the UI needs to warn about. Absent (every
   *  pre-existing caller) keeps today's byte-identical behavior. The privileged override (tier 1)
   *  always wins regardless — an admin forcing a value is not something either mode should skip. */
  preferScope?: "business" | "personal"
): Promise<{ row: CredentialRow; tier: CredentialResolvedTier } | { notFoundReason: "personal_required" } | null> {
  const spaceRow = await fetchSpaceRow(db, spaceId, tenantId, name);

  if (spaceRow && spaceRow.is_override) return { row: spaceRow, tier: "business_override" };

  const checkPersonalTier = preferScope !== "business" && Boolean(actingUserId);
  if (checkPersonalTier) {
    const userRow = await db.prepare(
      `SELECT * FROM space_credentials WHERE space_id = ? AND tenant_id = ? AND name = ? AND scope = 'user' AND user_id = ? LIMIT 1`
    ).bind(spaceId, tenantId, name, actingUserId).first<CredentialRow>();
    if (userRow) return { row: userRow, tier: "user" };
  }
  if (preferScope === "personal") {
    // Explicitly asked for the personal account and there isn't one connected — never fall
    // through to the shared credential silently, that's the exact mismatch the caller needs to
    // know about (see catalogue.ts / the shell's connector-mode UI).
    return { notFoundReason: "personal_required" };
  }

  // A project row is considered only when its ID arrived inside the signed project-scoped
  // credential token. A body/header-supplied project ID alone never grants access.
  if (projectId) {
    const projectRow = await db.prepare(
      `SELECT * FROM space_credentials WHERE space_id = ? AND tenant_id = ? AND name = ? AND scope = 'space' AND project_id = ? LIMIT 1`
    ).bind(spaceId, tenantId, name, projectId).first<CredentialRow>();
    if (projectRow) return { row: projectRow, tier: "project_bound" };
  }

  if (spaceRow && sharedRowAppliesToUser(spaceRow, actingUserId)) {
    return { row: spaceRow, tier: "business_shared" };
  }

  // Best-effort: the product-root walk is a nice-to-have tier, never a hard dependency of
  // credential resolution — a missing/unreachable spaces table must fall through to "not found"
  // rather than 500 the whole lookup.
  try {
    const space = await db.prepare(
      `SELECT parent_space_id FROM spaces WHERE id = ? AND tenant_id = ? AND status = 'active'`
    ).bind(spaceId, tenantId).first<{ parent_space_id: string | null }>();
    if (space?.parent_space_id) {
      const activeRoot = await db.prepare(
        `SELECT id FROM spaces WHERE id = ? AND tenant_id = ? AND status = 'active'`
      ).bind(space.parent_space_id, tenantId).first<{ id: string }>();
      if (activeRoot) {
        const rootRow = await fetchSpaceRow(db, space.parent_space_id, tenantId, name);
        if (rootRow) return { row: rootRow, tier: "product" };
      }
    }
  } catch {
    // Fall through — see comment above.
  }

  return null;
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: CredentialsEnv }>();

app.use("*", requestId);
app.use("*", async (c, next) => {
  validateEnv(c.env);
  await next();
});

// B1/B3 fix: the three public CRUD routes only ever trust x-naelao-tenant-id/-user-id/-role
// as-is — with workers_dev disabled the router is the only path in, but this is the
// defense-in-depth backstop (a misconfiguration or a future direct binding must not be able
// to forge a tenant/role). The internal plaintext-resolution route below has its own,
// independent HMAC scheme (generateCredentialToken/verifyCredentialToken, scoped to a single
// agentId+spaceId) and is deliberately NOT covered by this — it's not proxied by the router.
app.use("/spaces/:spaceId/credentials", requireInternalHmac((c) => (c as unknown as { env: CredentialsEnv }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/credentials/:credId", requireInternalHmac((c) => (c as unknown as { env: CredentialsEnv }).env.PLATFORM_SECRET));

// POST /v1/spaces/:spaceId/credentials — create a credential.
// Body: { name, value, description?, scope?: 'user'|'space'|'project' (default 'user'), project_id?, is_override?: boolean,
//         shared_with_user_ids?: string[] | null }
// - scope='user' (default): a member's own personal credential. Always allowed for the caller,
//   always owned by the caller (a user can never create another user's credential).
// - scope='space': the shared business-wide credential. Requires owner/admin.
// - is_override=true: only valid with scope='space', requires owner/admin — forces this value
//   ahead of any member's personal credential of the same name.
// - shared_with_user_ids: only valid with scope='space' AND is_override=false — narrows the
//   shared fallback to specific member ids instead of everyone in the business. Requires
//   owner/admin, same as scope='space' itself (a non-admin can never widen/narrow who sees a
//   credential they didn't have the privilege to share in the first place).
app.post("/spaces/:spaceId/credentials", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const role = c.req.header("x-naelao-role") ?? "viewer";
  const spaceId = c.req.param("spaceId");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");
  if (!userId) throw badRequest("x-naelao-user-id header is required");

  let body: {
    name: string;
    value: string;
    description?: string;
    scope?: "user" | "space" | "project" | CredentialScope;
    project_id?: string;
    is_override?: boolean;
    shared_with_user_ids?: string[] | null;
  };
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
    body = parsed as typeof body;
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (typeof body.name !== "string" || !body.name) throw badRequest("name is required");
  if (typeof body.value !== "string" || !body.value) throw badRequest("value must be a non-empty string");
  if (body.description !== undefined && body.description !== null &&
      (typeof body.description !== "string" || body.description.length > 4000)) {
    throw badRequest("description must be a string of at most 4000 characters");
  }
  if (body.is_override !== undefined && typeof body.is_override !== "boolean") {
    throw badRequest("is_override must be a boolean");
  }
  validateCredentialName(body.name);

  const inputScope = body.scope ?? "user";
  const requestedScope = inputScope === "USER_PERSONAL" ? "user" : inputScope === "SPACE_SHARED" ? "space" : inputScope === "PROJECT_BOUND" ? "project" : inputScope;
  if (requestedScope !== "user" && requestedScope !== "space" && requestedScope !== "project") {
    throw badRequest("scope must be USER_PERSONAL, SPACE_SHARED, or PROJECT_BOUND");
  }
  const scope: "user" | "space" = requestedScope === "project" ? "space" : requestedScope;
  if (requestedScope === "project" && typeof body.project_id !== "string") {
    throw badRequest("project_id must be a string for project-bound credentials");
  }
  const projectId = requestedScope === "project" ? body.project_id!.trim() : null;
  if (requestedScope === "project" && !projectId) throw badRequest("project_id is required for project-bound credentials");
  if (projectId && !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw badRequest("project_id has an invalid format");
  if (requestedScope !== "project" && body.project_id !== undefined) throw badRequest("project_id is only valid with scope='project'");
  const isOverride = Boolean(body.is_override);
  if (isOverride && (scope !== "space" || projectId)) {
    throw badRequest("is_override is only valid with scope='space'");
  }
  if ((scope === "space" || isOverride) && !isPrivileged(role)) {
    throw forbidden("Only owner/admin may set a business-shared credential or override");
  }
  const sharedWithUserIds = validateSharedUserIds(body.shared_with_user_ids);
  if (sharedWithUserIds !== null) {
    if (scope !== "space" || isOverride || projectId) {
      throw badRequest("shared_with_user_ids is only valid with scope='space' and is_override=false");
    }
    if (!Array.isArray(sharedWithUserIds) || sharedWithUserIds.some((u) => typeof u !== "string" || !u)) {
      throw badRequest("shared_with_user_ids must be an array of user ids, or null");
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const ownerUserId = scope === "user" ? userId : null;
  const sharedWithJson = sharedWithUserIds ? JSON.stringify(sharedWithUserIds) : null;

  // G-AH07: Space-derived key; each space's credentials use a distinct HKDF-derived key.
  // The logical identity is authenticated by AES-GCM so stored ciphertext cannot be moved
  // between spaces, names, tenants, scopes, or personal owners without detection.
  const { ciphertext, iv, key_version } = await encrypt(body.value, c.env.PLATFORM_DB, c.env, tenantId, spaceId, {
    space_id: spaceId, tenant_id: tenantId, name: body.name, scope, user_id: ownerUserId, project_id: projectId,
  });

  // Upsert on the unique (space,name,scope[,user]) index so re-saving the same name/scope
  // rotates the value in place rather than erroring or leaving orphaned rows.
  const conflictTarget = scope === "user"
    ? "(space_id, name, user_id) WHERE scope = 'user'"
    : projectId
      ? "(space_id, project_id, name) WHERE scope = 'space' AND project_id IS NOT NULL"
      : "(space_id, name) WHERE scope = 'space' AND project_id IS NULL";
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO space_credentials
       (id, space_id, tenant_id, name, scope, user_id, project_id, is_override, shared_with_user_ids, encrypted_value, iv, key_version, description, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT ${conflictTarget} DO UPDATE SET
       is_override = excluded.is_override,
       shared_with_user_ids = excluded.shared_with_user_ids,
       encrypted_value = excluded.encrypted_value,
       iv = excluded.iv,
       key_version = excluded.key_version,
       description = excluded.description,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      spaceId,
      tenantId,
      body.name,
      scope,
      ownerUserId,
      projectId ?? null,
      isOverride ? 1 : 0,
      sharedWithJson,
      ciphertext,
      iv,
      key_version,
      body.description ?? null,
      userId,
      now,
      now
    )
    .run();

  return c.json(
    {
      id,
      name: body.name,
      scope: projectId ? "project" : scope,
      credential_scope: credentialScopeForRow({ scope, project_id: projectId ?? null }),
      project_id: projectId ?? null,
      is_override: isOverride,
      shared_with_user_ids: sharedWithUserIds,
      description: body.description ?? null,
      created_at: now,
    },
    201
  );
});

// GET /v1/spaces/:spaceId/credentials — list credentials (metadata only, never values).
// A non-privileged caller sees: their own user-scoped credentials + all space-scoped ones
// (so they can see what's shared/overridden, without seeing teammates' personal credentials).
// A privileged caller (owner/admin) sees everything, for management/audit visibility.
app.get("/spaces/:spaceId/credentials", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const role = c.req.header("x-naelao-role") ?? "viewer";
  const spaceId = c.req.param("spaceId");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");

  const query = isPrivileged(role)
    ? c.env.PLATFORM_DB.prepare(
        `SELECT id, name, scope, project_id, user_id, is_override, shared_with_user_ids, description, created_at
         FROM space_credentials
         WHERE space_id = ? AND tenant_id = ?
         ORDER BY created_at DESC`
      ).bind(spaceId, tenantId)
    : c.env.PLATFORM_DB.prepare(
        `SELECT id, name, scope, project_id, user_id, is_override, shared_with_user_ids, description, created_at
         FROM space_credentials
         WHERE space_id = ? AND tenant_id = ? AND ((scope = 'space' AND project_id IS NULL) OR user_id = ?)
         ORDER BY created_at DESC`
      ).bind(spaceId, tenantId, userId);

  const results = await query.all<{
    id: string;
    name: string;
    scope: "user" | "space";
    project_id: string | null;
    user_id: string | null;
    is_override: number;
    shared_with_user_ids: string | null;
    description: string | null;
    created_at: string;
  }>();

  return c.json({
    credentials: results.results.map((r) => ({
      ...r,
      scope: r.project_id ? "project" : r.scope,
      credential_scope: credentialScopeForRow(r),
      is_override: Boolean(r.is_override),
      shared_with_user_ids: parseSharedUserIds(r.shared_with_user_ids),
    })),
  });
});

// DELETE /v1/spaces/:spaceId/credentials/:credId — delete a credential.
// A user may always delete their own user-scoped credential. Deleting a space-scoped
// credential (shared or override) requires owner/admin.
app.delete("/spaces/:spaceId/credentials/:credId", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const role = c.req.header("x-naelao-role") ?? "viewer";
  const spaceId = c.req.param("spaceId");
  const credId = c.req.param("credId");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");

  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT scope, project_id, user_id FROM space_credentials WHERE id = ? AND space_id = ? AND tenant_id = ?`
  ).bind(credId, spaceId, tenantId).first<{ scope: "user" | "space"; project_id: string | null; user_id: string | null }>();
  if (!row) throw notFound("Credential");

  const isOwnCredential = row.scope === "user" && row.user_id === userId;
  if (!isOwnCredential && !isPrivileged(role)) {
    throw forbidden("Only the owning member or an owner/admin may delete this credential");
  }

  const result = await c.env.PLATFORM_DB.prepare(
    `DELETE FROM space_credentials WHERE id = ? AND space_id = ? AND tenant_id = ?`
  )
    .bind(credId, spaceId, tenantId)
    .run();

  if (result.meta.changes === 0) {
    throw notFound("Credential");
  }

  return c.json({ deleted: true });
});

// PATCH /v1/spaces/:spaceId/credentials/:credId — update sharing metadata on a business-shared
// credential (who it's shared with) WITHOUT touching or re-supplying the secret value. This is
// the "toggle sharing to everyone / selected members" control an admin uses from the UI — the
// upsert-on-POST path above still works for rotating the actual value.
app.patch("/spaces/:spaceId/credentials/:credId", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const role = c.req.header("x-naelao-role") ?? "viewer";
  const spaceId = c.req.param("spaceId");
  const credId = c.req.param("credId");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");
  if (!isPrivileged(role)) throw forbidden("Only owner/admin may change credential sharing");

  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT scope, is_override FROM space_credentials WHERE id = ? AND space_id = ? AND tenant_id = ?`
  ).bind(credId, spaceId, tenantId).first<{ scope: "user" | "space"; is_override: number }>();
  if (!row) throw notFound("Credential");
  if (row.scope !== "space") throw badRequest("Only a business-shared credential's sharing can be changed");

  let body: { shared_with_user_ids?: string[] | null };
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
    body = parsed as { shared_with_user_ids?: string[] | null };
  } catch {
    throw badRequest("Invalid JSON body");
  }
  if (body.shared_with_user_ids === undefined) throw badRequest("shared_with_user_ids is required");
  const sharedWithUserIds = validateSharedUserIds(body.shared_with_user_ids);
  if (row.is_override) throw badRequest("An override credential is always shared with everyone — clear is_override first");

  const sharedWithJson = sharedWithUserIds ? JSON.stringify(sharedWithUserIds) : null;
  await c.env.PLATFORM_DB.prepare(
    `UPDATE space_credentials SET shared_with_user_ids = ?, updated_at = ? WHERE id = ? AND space_id = ? AND tenant_id = ?`
  ).bind(sharedWithJson, new Date().toISOString(), credId, spaceId, tenantId).run();

  return c.json({ id: credId, shared_with_user_ids: sharedWithUserIds });
});

// POST /v1/internal/spaces/:spaceId/credentials/:name/plaintext
// Internal endpoint — returns decrypted value for agent tool dispatch, resolved through the
// credential hierarchy for an optional acting user (body.on_behalf_of_user_id). Callers that
// don't know/care about a specific member (e.g. mcp-hub resolving a connector's own secret)
// omit it and get the effective space-level credential (override, else shared).
// G-F06: Requires short-lived HMAC credential token (x-naelao-credential-token)
//        embedding {spaceId}:{agentId}:{timestamp}, expires 60s.
app.post("/v1/internal/spaces/:spaceId/credentials/:name/plaintext", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const credentialToken = c.req.header("x-naelao-credential-token") ?? "";
  const spaceId = c.req.param("spaceId");
  const credName = c.req.param("name");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");
  if (!credentialToken) throw forbidden("x-naelao-credential-token header is required");

  // G-F06: Verify short-lived HMAC token — prevents cross-space exfiltration
  const tokenCheck = await verifyCredentialToken(credentialToken, c.env.PLATFORM_SECRET, spaceId, tenantId);
  if (!tokenCheck.ok || tokenCheck.tenantId !== tenantId) {
    throw forbidden(tokenCheck.reason ?? "Invalid credential token");
  }
  if (!(await isActiveTenantSpace(c.env.PLATFORM_DB, spaceId, tenantId))) throw notFound("Space");

  let onBehalfOfUserId: string | null = null;
  let requestedProjectId: string | undefined;
  let preferScope: "business" | "personal" | undefined;
  try {
    const body = await c.req.json<{ on_behalf_of_user_id?: string; prefer_scope?: "business" | "personal"; project_id?: string }>();
    onBehalfOfUserId = body.on_behalf_of_user_id ?? null;
    preferScope = body.prefer_scope;
    requestedProjectId = body.project_id;
  } catch {
    // Empty/absent body is fine — resolves at the space level.
  }

  if (onBehalfOfUserId && onBehalfOfUserId !== tokenCheck.actorId) {
    throw forbidden("Credential user scope does not match the signed actor");
  }
  if (requestedProjectId && requestedProjectId !== tokenCheck.projectId) throw forbidden("Project scope does not match the signed credential token");
  const resolved = await resolveCredential(c.env.PLATFORM_DB, spaceId, tenantId, credName, onBehalfOfUserId, tokenCheck.projectId ?? null, preferScope);
  if (!resolved) {
    throw notFound("Credential");
  }
  if ("notFoundReason" in resolved) {
    return c.json({ error_code: "personal_credential_required", message: "No personal credential is connected for this member" }, 404);
  }
  const { row, tier } = resolved;

  // The credential row's tenant and owning space select its wrapped data key. These may differ
  // from the requested space when a product-root credential is inherited.
  const value = await decrypt(row.encrypted_value, row.iv, c.env, c.env.PLATFORM_DB, row.tenant_id, row.space_id, row);

  // G-D06: Immutable audit entry — credential_access event in Analytics Engine
  try {
    const tokenParts: Record<string, string> = {};
    for (const seg of credentialToken.split(",")) {
      const eq = seg.indexOf("=");
      if (eq > 0) tokenParts[seg.slice(0, eq)] = seg.slice(eq + 1);
    }
    c.env.ANALYTICS.writeDataPoint({
      blobs: [
        "credential_access",          // blob1: event_name
        row.name,                     // blob2: credential_name (not the value)
        spaceId,                      // blob3: space_id
        tokenParts["aid"] ?? "",      // blob4: agent_id
        tenantId,                     // blob5: tenant_id
        tier,                         // blob6: resolved tier, including project_bound
      ],
      doubles: [Date.now()],          // double1: access_timestamp_ms
      indexes: [spaceId],
    });
  } catch {
    // Best-effort — audit failures must not block the credential read
  }

  // Notify the assistant when a specific acting user didn't end up on their OWN credential —
  // e.g. their personal one was missing and business-shared/product/an admin override was used
  // instead. Fire-and-forget: this must never slow down or fail the actual credential read.
  if (onBehalfOfUserId && tier !== "user") {
    c.executionCtx.waitUntil(
      fireCredentialFallbackEvent(c.env, { tenantId, spaceId, name: credName, actingUserId: onBehalfOfUserId, tier })
    );
  }

  return c.json({ name: row.name, value, scope: row.project_id ? "project" : row.scope, credential_scope: credentialScopeForRow(row), project_id: row.project_id, is_override: Boolean(row.is_override), resolved_tier: tier });
});

// POST /v1/internal/spaces/:spaceId/outbound
// The sole network egress that can see credential plaintext. The caller supplies only a logical
// name; decryption and Authorization injection occur in this worker and are never serialized
// back across the service binding. Redirects are followed manually and re-validated to prevent
// a public endpoint redirecting into metadata/private networks.
app.post("/v1/internal/spaces/:spaceId/outbound", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const credentialToken = c.req.header("x-naelao-credential-token") ?? "";
  const spaceId = c.req.param("spaceId");
  if (!tenantId || !credentialToken) throw forbidden("Authenticated outbound request required");
  const tokenCheck = await verifyCredentialToken(credentialToken, c.env.PLATFORM_SECRET, spaceId, tenantId);
  if (!tokenCheck.ok || tokenCheck.tenantId !== tenantId) throw forbidden(tokenCheck.reason ?? "Credential token tenant scope mismatch");
  if (!(await isActiveTenantSpace(c.env.PLATFORM_DB, spaceId, tenantId))) throw notFound("Space");
  // This is the final bearer-secret egress boundary. Check the immutable space policy before
  // resolving or decrypting a credential, before SSRF validation, and before the first fetch.
  if (await isSpaceNetworkEgressDenied(c.env.PLATFORM_DB, spaceId)) {
    return c.json({
      error_code: "air_gap_egress_denied",
      message: "This space blocks network egress",
    }, 403);
  }

  let body: {
    url: string; credentialName: string; method?: string; idempotencyKey?: string; body?: unknown; responseMode?: "audio";
    headers?: Record<string, string>; auth?: { type: "basic"; username: string }; onBehalfOfUserId?: string; projectId?: string;
  };
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body_not_object");
    body = parsed as typeof body;
  } catch {
    return c.json({ error_code: "egress_request_invalid", message: "The outbound request must be a valid JSON object" }, 400);
  }
  if (typeof body.url !== "string" || body.url.length > 2048 || typeof body.credentialName !== "string") {
    return c.json({ error_code: "egress_request_invalid", message: "A bounded destination URL and credential name are required" }, 400);
  }
  if (body.method !== undefined && typeof body.method !== "string") {
    return c.json({ error_code: "egress_method_denied", message: "The request method must be a string" }, 400);
  }
  if (body.projectId !== undefined && typeof body.projectId !== "string") {
    return c.json({ error_code: "egress_request_invalid", message: "The project scope is invalid" }, 400);
  }
  if (body.onBehalfOfUserId !== undefined && typeof body.onBehalfOfUserId !== "string") {
    return c.json({ error_code: "egress_request_invalid", message: "The acting user is invalid" }, 400);
  }
  if (body.onBehalfOfUserId && body.onBehalfOfUserId !== tokenCheck.actorId) {
    throw forbidden("Credential user scope does not match the signed actor");
  }
  const requestHeaders = body.headers ?? {};
  if (!requestHeaders || typeof requestHeaders !== "object" || Array.isArray(requestHeaders) || Object.keys(requestHeaders).length > 64) {
    return c.json({ error_code: "egress_headers_invalid", message: "At most 64 outbound headers are allowed" }, 400);
  }
  let headerBytes = 0;
  try {
    for (const [name, value] of Object.entries(requestHeaders)) {
      if (typeof value !== "string") throw new Error("header_value_invalid");
      headerBytes += new TextEncoder().encode(name).byteLength + new TextEncoder().encode(value).byteLength;
    }
    if (headerBytes > 16 * 1024) throw new Error("headers_too_large");
    new Headers(requestHeaders);
  } catch {
    return c.json({ error_code: "egress_headers_invalid", message: "Outbound headers are malformed or exceed 16 KiB" }, 400);
  }
  let serializedBody: string | undefined;
  if (body.body !== undefined) {
    try { serializedBody = typeof body.body === "string" ? body.body : JSON.stringify(body.body); }
    catch { return c.json({ error_code: "egress_body_invalid", message: "The outbound body cannot be serialized" }, 400); }
    const isBoundedOpenRouterTranscription = tokenCheck.purpose === "assistant-audio"
      && body.method?.toUpperCase() === "POST"
      && body.url === "https://openrouter.ai/api/v1/audio/transcriptions";
    const maxOutboundBodyBytes = isBoundedOpenRouterTranscription ? 900 * 1024 : 512 * 1024;
    if (new TextEncoder().encode(serializedBody ?? "").byteLength > maxOutboundBodyBytes) {
      return c.json({ error_code: "egress_body_too_large", message: "Outbound request bodies are limited to 512 KiB" }, 413);
    }
  }
  if (body.auth !== undefined && (body.auth?.type !== "basic" || typeof body.auth.username !== "string" || !/^[\x20-\x7e]{1,128}$/.test(body.auth.username) || body.auth.username.includes(":"))) {
    return c.json({ error_code: "egress_auth_invalid", message: "The requested authentication mode is invalid" }, 400);
  }
  if (body.projectId && body.projectId !== tokenCheck.projectId) throw forbidden("Project scope does not match the signed credential token");
  validateCredentialName(body.credentialName);
  const method = (body.method ?? (body.body === undefined ? "GET" : "POST")).toUpperCase();
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(method)) return c.json({ error_code: "egress_method_denied", message: "This request method is not allowed" }, 403);
  if ((method === "GET" || method === "HEAD") && serializedBody !== undefined) {
    return c.json({ error_code: "egress_body_method_invalid", message: "GET and HEAD requests cannot include a body" }, 400);
  }
  if (body.responseMode !== undefined && (tokenCheck.purpose !== "assistant-audio" || !isOpenRouterSpeechStream(body.url, method, body.responseMode)))
    return c.json({ error_code: "egress_audio_destination_denied" }, 403);
  const isWrite = method !== "GET" && method !== "HEAD";
  if (isWrite && (typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(body.idempotencyKey))) {
    return c.json({ error_code: "egress_idempotency_required", message: "A valid idempotency key is required for external changes" }, 400);
  }
  if (isWrite && (!tokenCheck.actorId || !tokenCheck.runId || !tokenCheck.traceId || !tokenCheck.spanId || !tokenCheck.agentId)) {
    return c.json({ error_code: "egress_receipt_context_required", message: "This run cannot make external changes because its audit context is unavailable" }, 403);
  }
  let approvedUrl: URL;
  try {
    approvedUrl = await authorizeEgressUrl(body.url, await readSpaceEgressPolicy(c.env.PLATFORM_DB, spaceId));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "network_denied";
    return c.json({ error_code: `egress_${code}`, message: error instanceof Error ? error.message : "Destination denied by space policy" }, 403);
  }
  try {
    scanAndScrubEgress({
      url: body.url,
      headers: requestHeaders,
      auth: body.auth ?? null,
      body: body.body ?? null,
    }, "block");
  } catch {
    return c.json({ error_code: "egress_sensitive_payload", message: "The request contains data that space policy blocks from leaving" }, 403);
  }
  let credentialName = body.credentialName;
  let resolved = await resolveCredential(c.env.PLATFORM_DB, spaceId, tenantId, credentialName, body.onBehalfOfUserId ?? null, tokenCheck.projectId ?? null);
  // Host-only logical alias for audio transports. Resolve the selected OpenRouter BYOK key in
  // the vault worker so the voice Durable Object never reads plaintext credentials.
  if (credentialName === "llm_byok_active::openrouter" && resolved && !("notFoundReason" in resolved)) {
    const pointerValue = await decrypt(resolved.row.encrypted_value, resolved.row.iv, c.env, c.env.PLATFORM_DB, resolved.row.tenant_id, resolved.row.space_id, resolved.row);
    if (!/^llm_byok_openrouter(?:::[A-Za-z0-9_]{1,32})?$/.test(pointerValue)) throw forbidden("Active OpenRouter credential pointer is invalid");
    credentialName = pointerValue;
    resolved = await resolveCredential(c.env.PLATFORM_DB, spaceId, tenantId, credentialName, body.onBehalfOfUserId ?? null, tokenCheck.projectId ?? null);
  }
  if ((!resolved || "notFoundReason" in resolved) && credentialName === "llm_byok_active::openrouter") {
    // A Space with the first-generation single-key name can use it without migrating the key.
    credentialName = "llm_byok_openrouter";
    resolved = await resolveCredential(c.env.PLATFORM_DB, spaceId, tenantId, credentialName, body.onBehalfOfUserId ?? null, tokenCheck.projectId ?? null);
  }
  if (!resolved || "notFoundReason" in resolved) throw notFound("Credential");
  const secret = await decrypt(resolved.row.encrypted_value, resolved.row.iv, c.env, c.env.PLATFORM_DB, resolved.row.tenant_id, resolved.row.space_id, resolved.row);

  const supplied = new Headers(requestHeaders);
  supplied.delete("authorization");
  supplied.delete("proxy-authorization");
  supplied.delete("host");
  supplied.delete("cookie");
  supplied.delete("content-length");
  const authorization = buildOutboundAuthorization(secret, body.auth);
  supplied.set("authorization", authorization);
  if (isWrite) supplied.set("idempotency-key", body.idempotencyKey!);
  let destination = approvedUrl;
  let receiptContext: OutboundReceiptContext | undefined;
  let inputHash = "";
  if (isWrite) {
    const actionId = await sha256Hex(JSON.stringify([tenantId, spaceId, tokenCheck.runId, body.idempotencyKey]));
    receiptContext = {
      tenantId, spaceId, actorId: tokenCheck.actorId!, runId: tokenCheck.runId!,
      ...(tokenCheck.taskId ? { taskId: tokenCheck.taskId } : {}), agentId: tokenCheck.agentId!,
      traceId: tokenCheck.traceId!, spanId: tokenCheck.spanId!, actionId, idempotencyKey: body.idempotencyKey!,
    };
    inputHash = await sha256Hex(JSON.stringify([method, approvedUrl.toString(), credentialName, body.auth ?? { type: "bearer" }, body.body ?? null, [...supplied.entries()].filter(([name]) => !/^(authorization|idempotency-key)$/i.test(name)), ...(body.responseMode ? [body.responseMode] : [])]));
    let pending;
    try {
      pending = await recordOutboundReceipt(c.env, receiptContext, "pending", inputHash, await sha256Hex("pending"), "Authorized external write; outcome pending");
    } catch {
      return c.json({ error_code: "action_receipt_unavailable", message: "The action audit could not be saved, so the external change was not sent" }, 503);
    }
    if (pending.replayed) return c.json({
      error_code: pending.outcome === "pending" ? "action_outcome_unknown" : "action_already_recorded",
      message: pending.outcome === "pending"
        ? "This action may already have reached the service. It was not retried; check the action receipt before continuing."
        : "This action was already recorded and was not sent again.",
    }, 409);
  }
  let response: Response | undefined;
  let outboundHeaders = new Headers(supplied);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!(await isActiveTenantSpace(c.env.PLATFORM_DB, spaceId, tenantId))) {
      if (receiptContext) {
        try { await recordOutboundReceipt(c.env, receiptContext, "failed", inputHash, await sha256Hex("space suspended before dispatch"), "Space was suspended before the external request was sent"); } catch { /* pending receipt remains fail-closed */ }
      }
      return c.json({ error_code: "tenant_suspended", message: "This tenant or Space is inactive" }, 403);
    }
    try {
      response = await fetch(destination, {
        method,
        headers: outboundHeaders,
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (receiptContext) {
        try { await recordOutboundReceipt(c.env, receiptContext, "unknown", inputHash, await sha256Hex("network outcome unknown"), "Network failure after dispatch; replay blocked pending reconciliation"); } catch { /* pending receipt remains fail-closed */ }
      }
      return c.json({ error_code: "egress_upstream_unavailable", message: "The external service did not return a confirmed result. This action will not be retried automatically." }, 502);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) break;
    if (isWrite) {
      if (receiptContext) {
        try { await recordOutboundReceipt(c.env, receiptContext, "unknown", inputHash, await sha256Hex(`redirect:${response.status}`), "Write redirect rejected; upstream outcome requires reconciliation"); } catch { /* pending receipt remains fail-closed */ }
      }
      return c.json({ error_code: "egress_write_redirect_denied", message: "Redirects are disabled for requests that may change remote state" }, 502);
    }
    let next: URL;
    try { next = await authorizeEgressRedirect(destination, location, await readSpaceEgressPolicy(c.env.PLATFORM_DB, spaceId)); }
    catch { return c.json({ error_code: "egress_redirect_denied", message: "The destination redirected outside the approved network policy" }, 502); }
    outboundHeaders = headersForEgressRedirect(destination, next, outboundHeaders);
    destination = next;
    response = undefined;
  }
  if (!response) throw forbidden("Outbound redirect limit exceeded");

  if (body.responseMode === "audio" && response.ok) {
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!response.body || !["audio/pcm", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/L16".toLowerCase(), "application/octet-stream"].includes(contentType ?? "")) {
      await response.body?.cancel().catch(() => {});
      if (receiptContext) await recordOutboundReceipt(c.env, receiptContext, "unknown", inputHash, await sha256Hex("audio format rejected"), "Speech returned an unsupported format").catch(() => {});
      return c.json({ error_code: "egress_audio_format_invalid" }, 502);
    }
    const stream = checkedAudioStream({ source: response.body, secrets: [secret, authorization],
      completed: async bytes => {
        if (receiptContext) await recordOutboundReceipt(c.env, receiptContext, "succeeded", inputHash, await sha256Hex(bytes), "Speech stream completed");
      },
      interrupted: async () => {
        if (receiptContext) await recordOutboundReceipt(c.env, receiptContext, "unknown", inputHash, await sha256Hex("audio interrupted"), "Speech stream interrupted; automatic replay blocked");
      },
    });
    const headers = new Headers({ "content-type": contentType!, "cache-control": "no-store" });
    const generation = response.headers.get("x-generation-id");
    if (generation && !generation.includes(secret) && !generation.includes(authorization) && /^[a-zA-Z0-9_-]{1,200}$/.test(generation)) headers.set("x-generation-id", generation);
    return new Response(stream, { status: 200, headers });
  }

  let bytes: Uint8Array;
  try { bytes = redactOutboundSecrets(await readBoundedResponse(response), [secret, authorization]); }
  catch {
    if (receiptContext) {
      try { await recordOutboundReceipt(c.env, receiptContext, "unknown", inputHash, await sha256Hex("response exceeded safe limit"), "Response was too large to safely record"); } catch { /* pending receipt remains fail-closed */ }
    }
    return c.json({ error_code: "egress_response_unavailable", message: "The external response exceeded the safe limit; the action will not be retried automatically." }, 502);
  }
  // Defend against an origin reflecting the injected authorization value into output bodies.
  const contentType = response.headers.get("content-type") ?? "";
  if (/^(text\/|application\/(json|xml|javascript))/.test(contentType)) {
    const text = new TextDecoder().decode(bytes);
    bytes = new TextEncoder().encode([secret, authorization].reduce((value, sensitive) => value.split(sensitive).join("[REDACTED]"), text));
  }
  if (receiptContext) {
    const outcome = response.ok ? "succeeded" : "failed";
    try {
      await recordOutboundReceipt(c.env, receiptContext, outcome, inputHash, await sha256Hex(`${response.status}:${await sha256Hex(bytes)}`), `External service returned HTTP ${response.status}`);
    } catch {
      return c.json({ error_code: "action_receipt_finalize_failed", message: "The external service responded, but its audit record could not be finalized. Do not retry this action." }, 503);
    }
  }
  return buildOutboundResponse(response, bytes, [secret, authorization]);
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

// ── Export ────────────────────────────────────────────────────────────────────
const MAX_CREDENTIALS_REQUEST_BYTES = 1024 * 1024;

export default {
  async fetch(request: Request, env: CredentialsEnv, ctx: ExecutionContext): Promise<Response> {
    if (!request.body || request.method === "GET" || request.method === "HEAD") return app.fetch(request, env, ctx);
    try {
      const bytes = await readBoundedRequestBytes(request, MAX_CREDENTIALS_REQUEST_BYTES);
      return app.fetch(new Request(request, { body: bytes }), env, ctx);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError)
        return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
      return errorResponse(error, "unknown");
    }
  },
} satisfies ExportedHandler<CredentialsEnv>;
