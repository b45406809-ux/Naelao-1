import { getDOName } from "@naelao/crypto";

type Db = Pick<D1Database, "prepare">;
type ProductUserNamespace = Pick<DurableObjectNamespace, "idFromName" | "get">;

export interface ProductAccountSecurityDispatcherEnv {
  PLATFORM_SECRET: string;
  PRODUCT_USER_DO: ProductUserNamespace;
}

interface SecurityOperation {
  operation_id: string;
  tenant_id: string;
  product_space_id: string;
  end_user_id: string;
  security_generation: number;
  attempt_count: number;
}

const LEASE_SECONDS = 60;

async function dispatchOne(db: Db, env: ProductAccountSecurityDispatcherEnv, operationId: string): Promise<boolean> {
  const leaseToken = crypto.randomUUID();
  const claimed = await db.prepare(
    `UPDATE product_account_security_outbox
        SET status = 'processing', lease_token = ?, lease_until = datetime('now', ?), attempt_count = attempt_count + 1,
            updated_at = datetime('now')
      WHERE operation_id = ? AND
        ((status = 'pending' AND next_attempt_at <= datetime('now'))
         OR (status = 'processing' AND lease_until <= datetime('now')))`
  ).bind(leaseToken, `+${LEASE_SECONDS} seconds`, operationId).run();
  if (claimed.meta.changes !== 1) return false;

  const row = await db.prepare(
    `SELECT operation_id, tenant_id, product_space_id, end_user_id, security_generation, attempt_count
       FROM product_account_security_outbox WHERE operation_id = ? AND status = 'processing' AND lease_token = ?`
  ).bind(operationId, leaseToken).first<SecurityOperation>();
  if (!row) return false;

  let errorCode: string | null = null;
  try {
    const doName = await getDOName("produser", `${row.product_space_id}:${row.end_user_id}`, row.tenant_id, env.PLATFORM_SECRET);
    const id = env.PRODUCT_USER_DO.idFromName(doName);
    const response = await env.PRODUCT_USER_DO.get(id).fetch(new Request("http://do/sessions/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    if (!response.ok) errorCode = `session_store_http_${response.status}`;
  } catch {
    errorCode = "session_store_unavailable";
  }

  if (!errorCode) {
    await db.prepare(
      `UPDATE product_account_security_outbox SET status = 'completed', completed_at = datetime('now'),
         updated_at = datetime('now'), lease_token = NULL, lease_until = NULL, last_error_code = NULL
       WHERE operation_id = ? AND status = 'processing' AND lease_token = ?`
    ).bind(operationId, leaseToken).run();
    return true;
  }

  const retrySeconds = Math.min(3600, 30 * 2 ** Math.min(row.attempt_count - 1, 7));
  await db.prepare(
    `UPDATE product_account_security_outbox SET status = 'pending', next_attempt_at = datetime('now', ?),
         updated_at = datetime('now'), lease_token = NULL, lease_until = NULL, last_error_code = ?
       WHERE operation_id = ? AND status = 'processing' AND lease_token = ?`
  ).bind(`+${retrySeconds} seconds`, errorCode, operationId, leaseToken).run();
  return false;
}

/** The account generation rejects stale sessions immediately; this retries DO row cleanup. */
export async function dispatchPendingProductAccountSecurityOutbox(
  db: Db,
  env: ProductAccountSecurityDispatcherEnv,
  limit = 25,
): Promise<{ completed: number; deferred: number }> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const due = await db.prepare(
    `SELECT operation_id FROM product_account_security_outbox
      WHERE status = 'pending' AND next_attempt_at <= datetime('now')
         OR status = 'processing' AND lease_until <= datetime('now')
      ORDER BY next_attempt_at, created_at, operation_id LIMIT ?`
  ).bind(boundedLimit).all<{ operation_id: string }>();
  let completed = 0;
  let deferred = 0;
  for (const row of due.results ?? []) {
    if (await dispatchOne(db, env, row.operation_id)) completed++;
    else deferred++;
  }
  await db.prepare(
    `DELETE FROM product_account_security_outbox WHERE operation_id IN (
       SELECT operation_id FROM product_account_security_outbox
        WHERE status = 'completed' AND completed_at < datetime('now', '-30 days') LIMIT 100
     )`
  ).run();
  return { completed, deferred };
}
