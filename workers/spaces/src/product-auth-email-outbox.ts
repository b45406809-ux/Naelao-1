type ProductAuthEmailPayload = { token: string; recipient: string; verify_url?: string };
type Db = Pick<D1Database, "prepare">;

const MAX_ATTEMPTS = 12;
const LEASE_SECONDS = 60;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function productAuthEmailKey(platformSecret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(platformSecret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("naelao-product-auth-email-v1"), info: new TextEncoder().encode("encrypted-outbox-payload") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt both the single-use token and recipient before either enters durable D1 storage. */
export async function encryptProductAuthEmailPayload(platformSecret: string, payload: ProductAuthEmailPayload): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await productAuthEmailKey(platformSecret);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `v1.${bytesToBase64(nonce)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

async function decryptProductAuthEmailPayload(platformSecret: string, envelope: string): Promise<ProductAuthEmailPayload> {
  const [version, noncePart, ciphertextPart, extra] = envelope.split(".");
  if (version !== "v1" || !noncePart || !ciphertextPart || extra !== undefined) throw new Error("invalid_encrypted_payload");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(noncePart) },
    await productAuthEmailKey(platformSecret),
    base64ToBytes(ciphertextPart),
  );
  const payload: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (!payload || typeof payload !== "object" || typeof (payload as ProductAuthEmailPayload).token !== "string" ||
      typeof (payload as ProductAuthEmailPayload).recipient !== "string" ||
      ((payload as ProductAuthEmailPayload).verify_url !== undefined && typeof (payload as ProductAuthEmailPayload).verify_url !== "string")) throw new Error("invalid_email_payload");
  return payload as ProductAuthEmailPayload;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface OutboxRow {
  operation_id: string;
  tenant_id: string;
  product_space_id: string;
  token_id: string;
  message_kind: "password_reset" | "email_verification";
  recipient_hash: string;
  encrypted_payload: string;
  attempt_count: number;
}

export interface ProductAuthEmailDispatcherEnv {
  PLATFORM_SECRET: string;
  NOTIFICATIONS_WORKER?: Fetcher;
}

async function dispatchOne(db: Db, env: ProductAuthEmailDispatcherEnv, operationId: string): Promise<boolean> {
  const leaseToken = crypto.randomUUID();
  const claimed = await db.prepare(
    `UPDATE product_auth_email_outbox
        SET status = 'sending', lease_token = ?, lease_until = datetime('now', ?),
            attempt_count = attempt_count + 1, updated_at = datetime('now')
      WHERE operation_id = ? AND attempt_count < ?
        AND ((status = 'pending' AND next_attempt_at <= datetime('now'))
          OR (status = 'sending' AND lease_until <= datetime('now')))`
  ).bind(leaseToken, `+${LEASE_SECONDS} seconds`, operationId, MAX_ATTEMPTS).run();
  if (claimed.meta.changes !== 1) return false;

  const row = await db.prepare(
    `SELECT operation_id, tenant_id, product_space_id, token_id, message_kind, recipient_hash, encrypted_payload, attempt_count
       FROM product_auth_email_outbox WHERE operation_id = ? AND lease_token = ? AND status = 'sending'`
  ).bind(operationId, leaseToken).first<OutboxRow>();
  if (!row) return false;

  let errorCode = "notification_binding_unavailable";
  try {
    const tokenTable = row.message_kind === "password_reset" ? "password_reset_tokens" : "email_verification_tokens";
    const activeToken = await db.prepare(
      `SELECT 1 FROM ${tokenTable} WHERE id = ? AND used_at IS NULL AND julianday(expires_at) > julianday('now')`
    ).bind(row.token_id).first();
    if (!activeToken) {
      await db.prepare(
        `UPDATE product_auth_email_outbox SET status = 'cancelled', updated_at = datetime('now'),
           lease_token = NULL, lease_until = NULL, last_error_code = NULL
         WHERE operation_id = ? AND status = 'sending' AND lease_token = ?`
      ).bind(operationId, leaseToken).run();
      return false;
    }
    if (!env.NOTIFICATIONS_WORKER) throw new Error(errorCode);
    const payload = await decryptProductAuthEmailPayload(env.PLATFORM_SECRET, row.encrypted_payload);
    if (await sha256Hex(payload.recipient.trim().toLowerCase()) !== row.recipient_hash) throw new Error("recipient_integrity_failed");
    const subject = row.message_kind === "password_reset" ? "Reset your password" : "Verify your email";
    const body = row.message_kind === "password_reset"
      ? `Reset token: ${payload.token}\n\nThis token expires in 1 hour. If you did not request this, ignore this email.`
      : `Verification token: ${payload.token}${payload.verify_url ? `\n\nVerify your email: ${payload.verify_url}` : ""}\n\nThis token expires in 24 hours. Verifying helps secure your account and confirm email ownership.`;
    const response = await env.NOTIFICATIONS_WORKER.fetch(new Request("http://notifications-worker/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": row.tenant_id },
      body: JSON.stringify({
        channel: "email",
        space_id: row.product_space_id,
        to: payload.recipient,
        subject,
        body,
        notification_id: `product-auth:${row.operation_id}`,
      }),
    }));
    if (response.ok) {
      const result = await response.json<{ delivered?: boolean; provider_receipt_id?: unknown }>().catch(() => ({ delivered: false, provider_receipt_id: undefined }));
      if (result.delivered === true) {
        const receiptId = typeof result.provider_receipt_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(result.provider_receipt_id)
          ? result.provider_receipt_id
          : null;
        await db.prepare(
          `UPDATE product_auth_email_outbox SET status = 'accepted', accepted_at = datetime('now'), provider_receipt_id = ?,
             updated_at = datetime('now'), lease_token = NULL, lease_until = NULL, last_error_code = NULL
           WHERE operation_id = ? AND status = 'sending' AND lease_token = ?`
        ).bind(receiptId, operationId, leaseToken).run();
        return true;
      }
      errorCode = `notification_rejected_${response.status}`;
    } else {
      errorCode = `notification_http_${response.status}`;
    }
  } catch (error) {
    if (error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)) errorCode = error.message;
  }

  const terminal = row.attempt_count >= MAX_ATTEMPTS;
  const retrySeconds = Math.min(21_600, 30 * 2 ** Math.min(row.attempt_count - 1, 9));
  await db.prepare(
    `UPDATE product_auth_email_outbox
        SET status = ?, next_attempt_at = datetime('now', ?), updated_at = datetime('now'),
            lease_token = NULL, lease_until = NULL, last_error_code = ?
      WHERE operation_id = ? AND status = 'sending' AND lease_token = ?`
  ).bind(terminal ? "failed" : "pending", `+${retrySeconds} seconds`, errorCode, operationId, leaseToken).run();
  return false;
}

/** Try one operation immediately after it has been durably recorded. */
export function dispatchProductAuthEmailOutboxEntry(db: Db, env: ProductAuthEmailDispatcherEnv, operationId: string): Promise<boolean> {
  return dispatchOne(db, env, operationId);
}

/** Retry a bounded number of pending or lease-expired emails on the Spaces scheduled path. */
export async function dispatchPendingProductAuthEmails(
  db: Db,
  env: ProductAuthEmailDispatcherEnv,
  limit = 25,
): Promise<{ accepted: number; deferred: number }> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const due = await db.prepare(
    `SELECT operation_id FROM product_auth_email_outbox
      WHERE attempt_count < ? AND ((status = 'pending' AND next_attempt_at <= datetime('now'))
        OR (status = 'sending' AND lease_until <= datetime('now')))
      ORDER BY next_attempt_at, created_at, operation_id LIMIT ?`
  ).bind(MAX_ATTEMPTS, boundedLimit).all<{ operation_id: string }>();
  let accepted = 0;
  let deferred = 0;
  for (const row of due.results ?? []) {
    if (await dispatchOne(db, env, row.operation_id)) accepted++;
    else deferred++;
  }
  await db.prepare(
    `DELETE FROM product_auth_email_outbox WHERE operation_id IN (
       SELECT operation_id FROM product_auth_email_outbox
        WHERE status IN ('accepted', 'failed', 'cancelled') AND updated_at < datetime('now', '-30 days') LIMIT 100
     )`
  ).run();
  return { accepted, deferred };
}
