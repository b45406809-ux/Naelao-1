import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { Agent37AgentPortEnv } from "./agent37-agentport.js";

type DueRow = {
  id: string;
  operation_status: string;
  tenant_id: string;
  owner_id: string;
  computer_id: string;
  request_json: string;
  reconcile_attempts: number;
  agentport_account_id: string;
  share_status: string;
};

function retryDelaySeconds(attempt: number) {
  return Math.min(3_600, 60 * 2 ** Math.min(Math.max(0, attempt), 6));
}

async function revokeAccount(env: Agent37AgentPortEnv, tenantId: string, accountId: string) {
  if (!env.AGENTPORT_WORKER) throw new Error("agentport_worker_unavailable");
  const response = await env.AGENTPORT_WORKER.fetch(new Request(
    `https://agentport.internal/internal/agentport/accounts/${encodeURIComponent(accountId)}/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentport-tenant-id": tenantId,
        "x-agentport-actor-role": "client_system",
        "x-agentport-actor-id": tenantId,
        "x-agentport-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
      },
      body: "{}",
    },
  ));
  const result = await readBoundedResponseJson<Record<string, unknown>>(response, 64 * 1024);
  if (!response.ok || result.revoked !== true) throw new Error(
    typeof result.error_code === "string" ? `agentport_${result.error_code}` : "agentport_revoke_unconfirmed",
  );
}

/** Reconciles only owner-journaled Agent37 AgentPort revocations and the exact linked account. */
export async function sweepAgent37AgentPortRevocations(env: Agent37AgentPortEnv, now = new Date(), limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("agentport_revocation_sweep_limit_invalid");
  const at = now.toISOString();
  const due = await env.PLATFORM_DB.prepare(`SELECT o.id,o.status AS operation_status,o.tenant_id,o.owner_id,o.computer_id,
      o.request_json,o.reconcile_attempts,s.agentport_account_id,s.status AS share_status
    FROM sandbox_agentport_operations o JOIN sandbox_agentport_shares s
      ON s.tenant_id=o.tenant_id AND s.owner_id=o.owner_id AND s.computer_id=o.computer_id
    WHERE o.operation='revoke'
      AND ((o.status='unknown' AND o.next_reconcile_at IS NOT NULL AND o.next_reconcile_at<=?)
        OR (o.status='pending' AND o.lease_until IS NOT NULL AND o.lease_until<=?)
        OR (o.status='pending' AND o.lease_until IS NULL AND o.created_at<=datetime(?,'-2 minutes')))
    ORDER BY COALESCE(o.next_reconcile_at,o.lease_until,o.created_at),o.created_at LIMIT ?`)
    .bind(at, at, at, limit).all<DueRow>();
  const result = { checked: due.results.length, reconciled: 0, deferred: 0, failed: 0 };

  for (const row of due.results) {
    const claimed = await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_operations SET status='pending',lease_until=?,
        next_reconcile_at=NULL,reconcile_attempts=reconcile_attempts+1,updated_at=?
      WHERE id=? AND tenant_id=? AND operation='revoke'
        AND ((status='unknown' AND next_reconcile_at IS NOT NULL AND next_reconcile_at<=?)
          OR (status='pending' AND lease_until IS NOT NULL AND lease_until<=?)
          OR (status='pending' AND lease_until IS NULL AND created_at<=datetime(?,'-2 minutes')))`)
      .bind(new Date(now.getTime() + 120_000).toISOString(), at, row.id, row.tenant_id, at, at, at).run();
    if (claimed.meta.changes !== 1) { result.deferred++; continue; }

    let expectedAccountId: string | null = null;
    try {
      const request = JSON.parse(row.request_json) as Record<string, unknown>;
      if (typeof request.agentportAccountId === "string") expectedAccountId = request.agentportAccountId;
    } catch { /* malformed operation remains visible as unresolved */ }
    if (expectedAccountId && expectedAccountId === row.agentport_account_id && row.share_status === "revoked") {
      await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_operations SET status='complete',lease_until=NULL,
          error_code=NULL,next_reconcile_at=NULL,updated_at=? WHERE id=? AND tenant_id=? AND status='pending'`)
        .bind(at, row.id, row.tenant_id).run();
      result.reconciled++;
      continue;
    }
    const allowedShareStates = row.operation_status === "pending"
      ? ["active", "pending", "unknown", "revoking"] : ["unknown", "revoking"];
    if (!expectedAccountId || expectedAccountId !== row.agentport_account_id
      || !allowedShareStates.includes(row.share_status)) {
      await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_operations SET status='unknown',lease_until=NULL,
          error_code='agentport_revoke_target_changed',next_reconcile_at=NULL,updated_at=?
        WHERE id=? AND tenant_id=? AND status='pending'`)
        .bind(at, row.id, row.tenant_id).run();
      result.deferred++;
      continue;
    }

    const fenced = await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_shares SET status='revoking',updated_at=?
      WHERE tenant_id=? AND owner_id=? AND computer_id=? AND agentport_account_id=? AND status IN ('active','pending','unknown','revoking')`)
      .bind(at, row.tenant_id, row.owner_id, row.computer_id, expectedAccountId).run();
    if (fenced.meta.changes !== 1) {
      await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_operations SET status='unknown',lease_until=NULL,
          error_code='agentport_revoke_target_changed',next_reconcile_at=NULL,updated_at=?
        WHERE id=? AND tenant_id=? AND status='pending'`).bind(at, row.id, row.tenant_id).run();
      result.deferred++;
      continue;
    }

    try {
      await revokeAccount(env, row.tenant_id, expectedAccountId);
      const revokedAt = new Date().toISOString();
      const saved = await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_shares SET status='revoked',error_code=NULL,
          revoked_at=?,updated_at=? WHERE tenant_id=? AND owner_id=? AND computer_id=? AND agentport_account_id=? AND status='revoking'`)
        .bind(revokedAt, revokedAt, row.tenant_id, row.owner_id, row.computer_id, expectedAccountId).run();
      if (saved.meta.changes !== 1) throw new Error("agentport_revoke_target_changed");
      const operation = await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_operations SET status='complete',lease_until=NULL,
          error_code=NULL,next_reconcile_at=NULL,updated_at=? WHERE id=? AND tenant_id=? AND status='pending'`)
        .bind(revokedAt, row.id, row.tenant_id).run();
      if (operation.meta.changes !== 1) throw new Error("agentport_revoke_operation_changed");
      result.reconciled++;
    } catch (error) {
      const failedAt = new Date();
      const message = error instanceof Error ? error.message : "agentport_revoke_reconciliation_failed";
      const code = /^[a-z][a-z0-9_:-]{1,120}$/.test(message) ? message : "agentport_revoke_reconciliation_failed";
      const retryAt = new Date(now.getTime() + retryDelaySeconds(row.reconcile_attempts + 1) * 1_000).toISOString();
      await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_shares SET status='unknown',error_code=?,updated_at=?
        WHERE tenant_id=? AND owner_id=? AND computer_id=? AND agentport_account_id=? AND status='revoking'`)
        .bind(code, failedAt.toISOString(), row.tenant_id, row.owner_id, row.computer_id, expectedAccountId).run().catch(() => undefined);
      await env.PLATFORM_DB.prepare(`UPDATE sandbox_agentport_operations SET status='unknown',lease_until=NULL,error_code=?,
          next_reconcile_at=?,updated_at=? WHERE id=? AND tenant_id=? AND status='pending'`)
        .bind(code, retryAt, failedAt.toISOString(), row.id, row.tenant_id).run().catch(() => undefined);
      result.failed++;
    }
  }
  return result;
}
