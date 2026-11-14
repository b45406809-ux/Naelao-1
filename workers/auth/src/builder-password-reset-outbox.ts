type ResetEmailPayload = { token: string; recipient: string };
type Db = Pick<D1Database, "prepare" | "batch">;

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

async function resetEmailKey(platformSecret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(platformSecret),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("naelao-builder-password-reset-v1"),
      info: new TextEncoder().encode("encrypted-outbox-payload"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptPayload(
  platformSecret: string,
  payload: ResetEmailPayload
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await resetEmailKey(platformSecret),
    new TextEncoder().encode(JSON.stringify(payload))
  );
  return `v1.${bytesToBase64(nonce)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

async function decryptPayload(
  platformSecret: string,
  envelope: string
): Promise<ResetEmailPayload> {
  const [version, noncePart, ciphertextPart, extra] = envelope.split(".");
  if (version !== "v1" || !noncePart || !ciphertextPart || extra !== undefined)
    throw new Error("invalid_encrypted_payload");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(noncePart) },
    await resetEmailKey(platformSecret),
    base64ToBytes(ciphertextPart)
  );
  const payload: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as ResetEmailPayload).token !== "string" ||
    typeof (payload as ResetEmailPayload).recipient !== "string"
  )
    throw new Error("invalid_email_payload");
  return payload as ResetEmailPayload;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface BuilderResetEmailEnv {
  PLATFORM_SECRET: string;
  NOTIFICATIONS_WORKER?: Fetcher;
  BUILDER_DASHBOARD_URL?: string;
}

/** Store the reset token and encrypted delivery payload in the same D1 transaction. */
export async function enqueueBuilderPasswordResetEmail(
  db: Db,
  env: BuilderResetEmailEnv,
  input: {
    tenantId: string;
    userId: string;
    email: string;
    tokenId: string;
    tokenHash: string;
    token: string;
    expiresAt: string;
  }
): Promise<string> {
  const operationId = crypto.randomUUID();
  const recipientHash = await sha256Hex(input.email.trim().toLowerCase());
  const encryptedPayload = await encryptPayload(env.PLATFORM_SECRET, {
    token: input.token,
    recipient: input.email,
  });
  await db.batch([
    db
      .prepare(
        "DELETE FROM builder_password_reset_tokens WHERE user_id = ?1 AND used_at IS NULL"
      )
      .bind(input.userId),
    db
      .prepare(
        `INSERT INTO builder_password_reset_tokens (id, user_id, token_hash, expires_at)
       VALUES (?1, ?2, ?3, ?4)`
      )
      .bind(input.tokenId, input.userId, input.tokenHash, input.expiresAt),
    db
      .prepare(
        `INSERT INTO builder_password_reset_email_outbox
        (operation_id, tenant_id, user_id, token_id, recipient_hash, encrypted_payload)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      )
      .bind(
        operationId,
        input.tenantId,
        input.userId,
        input.tokenId,
        recipientHash,
        encryptedPayload
      ),
  ]);
  return operationId;
}

interface OutboxRow {
  operation_id: string;
  tenant_id: string;
  user_id: string;
  token_id: string;
  recipient_hash: string;
  encrypted_payload: string;
  active_notification_id: string;
  attempt_count: number;
}

function retryDelaySeconds(attemptCount: number): number {
  return Math.min(21_600, 30 * 2 ** Math.min(Math.max(0, attemptCount - 1), 9));
}

async function finishAttempt(
  db: Db,
  row: OutboxRow,
  leaseToken: string,
  outcome: "accepted" | "ambiguous" | "retry" | "failed" | "cancelled",
  errorCode: string | null,
  receiptId: string | null = null,
  clearActiveNotification = true
): Promise<void> {
  const status = outcome === "retry" ? "pending" : outcome;
  const terminal = status !== "pending";
  const retrySeconds = retryDelaySeconds(row.attempt_count);
  await db
    .prepare(
      `UPDATE builder_password_reset_email_outbox
        SET status = ?, next_attempt_at = CASE WHEN ? THEN datetime('now', ?) ELSE next_attempt_at END,
            encrypted_payload = CASE WHEN ? THEN '' ELSE encrypted_payload END,
            active_notification_id = CASE WHEN ? THEN NULL ELSE active_notification_id END,
            provider_receipt_id = COALESCE(?, provider_receipt_id), last_error_code = ?,
            updated_at = datetime('now'), accepted_at = CASE WHEN ? = 'accepted' THEN datetime('now') ELSE accepted_at END,
            lease_token = NULL, lease_until = NULL
      WHERE operation_id = ? AND status = 'sending' AND lease_token = ?`
    )
    .bind(
      status,
      status === "pending" ? 1 : 0,
      `+${retrySeconds} seconds`,
      terminal ? 1 : 0,
      clearActiveNotification ? 1 : 0,
      receiptId,
      errorCode,
      status,
      row.operation_id,
      leaseToken
    )
    .run();
}

async function dispatchOne(
  db: Db,
  env: BuilderResetEmailEnv,
  operationId: string
): Promise<boolean> {
  const leaseToken = crypto.randomUUID();
  const claimed = await db
    .prepare(
      `UPDATE builder_password_reset_email_outbox
        SET status = 'sending', lease_token = ?, lease_until = datetime('now', ?),
            attempt_count = attempt_count + 1,
            active_notification_id = COALESCE(active_notification_id, 'builder-password-reset:' || token_id || ':' || (attempt_count + 1)),
            updated_at = datetime('now')
      WHERE operation_id = ? AND attempt_count < ?
        AND ((status = 'pending' AND next_attempt_at <= datetime('now'))
          OR (status = 'sending' AND lease_until <= datetime('now')))`
    )
    .bind(leaseToken, `+${LEASE_SECONDS} seconds`, operationId, MAX_ATTEMPTS)
    .run();
  if (claimed.meta.changes !== 1) return false;

  const row = await db
    .prepare(
      `SELECT operation_id, tenant_id, user_id, token_id, recipient_hash, encrypted_payload,
            active_notification_id, attempt_count
       FROM builder_password_reset_email_outbox WHERE operation_id = ? AND lease_token = ? AND status = 'sending'`
    )
    .bind(operationId, leaseToken)
    .first<OutboxRow>();
  if (!row) return false;

  const activeToken = await db
    .prepare(
      `SELECT 1 FROM builder_password_reset_tokens
      WHERE id = ? AND user_id = ? AND used_at IS NULL AND julianday(expires_at) > julianday('now')`
    )
    .bind(row.token_id, row.user_id)
    .first();
  if (!activeToken) {
    await finishAttempt(db, row, leaseToken, "cancelled", null);
    return false;
  }
  if (!env.NOTIFICATIONS_WORKER) {
    const terminal = row.attempt_count >= MAX_ATTEMPTS;
    await finishAttempt(
      db,
      row,
      leaseToken,
      terminal ? "failed" : "retry",
      "notification_binding_unavailable",
      null,
      false
    );
    return false;
  }

  let payload: ResetEmailPayload;
  try {
    payload = await decryptPayload(env.PLATFORM_SECRET, row.encrypted_payload);
    if (
      (await sha256Hex(payload.recipient.trim().toLowerCase())) !==
      row.recipient_hash
    )
      throw new Error("recipient_integrity_failed");
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)
        ? error.message
        : "payload_integrity_failed";
    await finishAttempt(db, row, leaseToken, "failed", code);
    return false;
  }

  const link = env.BUILDER_DASHBOARD_URL
    ? `\n\nOr click this link: ${env.BUILDER_DASHBOARD_URL.replace(/\/$/, "")}/reset-password#token=${encodeURIComponent(payload.token)}`
    : "";
  const notificationId = row.active_notification_id;
  try {
    const response = await env.NOTIFICATIONS_WORKER.fetch(
      new Request("http://notifications-worker/internal/notify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": row.tenant_id,
        },
        body: JSON.stringify({
          channel: "email",
          to: payload.recipient,
          subject: "Reset your Naelao password",
          body: `Reset token: ${payload.token}${link}\n\nThis token expires in 1 hour. If you didn't request this, ignore this email.`,
          notification_id: notificationId,
        }),
      })
    );
    type NotificationResult = {
      delivered?: boolean;
      outcome?:
        | "provider_accepted"
        | "provider_rejected"
        | "not_sent"
        | "attempt_ambiguous";
      provider_receipt_id?: unknown;
    };
    const result: NotificationResult = await response
      .json<NotificationResult>()
      .catch(() => ({}) as NotificationResult);
    const receiptId =
      typeof result.provider_receipt_id === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(result.provider_receipt_id)
        ? result.provider_receipt_id
        : null;
    if (response.ok && result.delivered === true) {
      await finishAttempt(db, row, leaseToken, "accepted", null, receiptId);
      return true;
    }
    if (
      result.outcome === "not_sent" ||
      result.outcome === "provider_rejected"
    ) {
      const terminal = row.attempt_count >= MAX_ATTEMPTS;
      await finishAttempt(
        db,
        row,
        leaseToken,
        terminal ? "failed" : "retry",
        `notification_${result.outcome}`,
        null
      );
      return false;
    }
    if (
      result.outcome === "attempt_ambiguous" ||
      response.ok ||
      response.status >= 500
    ) {
      // Reconcile the same Notification ID after an uncertain response. The Notifications
      // outcome ledger will return the prior result without repeating provider egress.
      const terminal = row.attempt_count >= MAX_ATTEMPTS;
      if (terminal)
        await finishAttempt(
          db,
          row,
          leaseToken,
          "ambiguous",
          "notification_outcome_ambiguous"
        );
      else
        await finishAttempt(
          db,
          row,
          leaseToken,
          "retry",
          "notification_outcome_ambiguous",
          null,
          false
        );
      return false;
    }
    await finishAttempt(
      db,
      row,
      leaseToken,
      "failed",
      `notification_http_${response.status}`
    );
    return false;
  } catch {
    // The request may have reached Notifications. Keep its ID for a later reconciliation pass.
    const terminal = row.attempt_count >= MAX_ATTEMPTS;
    if (terminal)
      await finishAttempt(
        db,
        row,
        leaseToken,
        "ambiguous",
        "notification_transport_ambiguous"
      );
    else
      await finishAttempt(
        db,
        row,
        leaseToken,
        "retry",
        "notification_transport_ambiguous",
        null,
        false
      );
    return false;
  }
}

export async function dispatchBuilderPasswordResetEmail(
  db: Db,
  env: BuilderResetEmailEnv,
  operationId: string
): Promise<boolean> {
  return dispatchOne(db, env, operationId);
}

export async function dispatchPendingBuilderPasswordResetEmails(
  db: Db,
  env: BuilderResetEmailEnv,
  limit = 25
): Promise<{ accepted: number; deferred: number }> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  await db
    .prepare(
      `UPDATE builder_password_reset_email_outbox
        SET status = CASE WHEN attempt_count >= ? THEN 'failed' ELSE 'cancelled' END,
            encrypted_payload = '', active_notification_id = NULL, lease_token = NULL, lease_until = NULL,
            last_error_code = CASE WHEN attempt_count >= ? THEN 'delivery_attempts_exhausted' ELSE NULL END,
            updated_at = datetime('now')
      WHERE status IN ('pending', 'sending')
        AND token_id IN (
          SELECT id FROM builder_password_reset_tokens
           WHERE used_at IS NOT NULL OR julianday(expires_at) <= julianday('now')
        )`
    )
    .bind(MAX_ATTEMPTS, MAX_ATTEMPTS)
    .run();
  const due = await db
    .prepare(
      `SELECT operation_id FROM builder_password_reset_email_outbox
      WHERE attempt_count < ? AND ((status = 'pending' AND next_attempt_at <= datetime('now'))
        OR (status = 'sending' AND lease_until <= datetime('now')))
      ORDER BY next_attempt_at, created_at, operation_id LIMIT ?`
    )
    .bind(MAX_ATTEMPTS, boundedLimit)
    .all<{ operation_id: string }>();
  let accepted = 0;
  let deferred = 0;
  for (const row of due.results ?? []) {
    if (await dispatchOne(db, env, row.operation_id)) accepted++;
    else deferred++;
  }
  await db
    .prepare(
      `DELETE FROM builder_password_reset_email_outbox WHERE operation_id IN (
       SELECT operation_id FROM builder_password_reset_email_outbox
        WHERE status IN ('accepted', 'ambiguous', 'failed', 'cancelled') AND updated_at < datetime('now', '-30 days') LIMIT 100
     )`
    )
    .run();
  return { accepted, deferred };
}
