import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";

type RevocationRow = {
  operation_id: string;
  operation_status: string;
  tenant_id: string;
  account_id: string;
  provider: string;
  service_id: string;
  request_json: string;
  reconcile_attempts: number;
  agentport_account_id: string | null;
  agentport_link_status: string | null;
};

function retryDelaySeconds(attempt: number) {
  return Math.min(3_600, 60 * 2 ** Math.min(Math.max(0, attempt), 6));
}

async function agentPortRevoke(env: AgentsEnv, tenantId: string, accountId: string) {
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

/** Retries only exact AgentPort account revocations already admitted and journaled by the owner routes. */
export async function sweepManagedAgentPortShareRevocations(env: AgentsEnv, now = new Date(), limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("agentport_revocation_sweep_limit_invalid");
  const at = now.toISOString();
  const due = await env.PLATFORM_DB.prepare(`SELECT o.operation_id,o.status AS operation_status,o.tenant_id,o.account_id,o.provider,o.service_id,o.request_json,
      o.reconcile_attempts,m.agentport_account_id,m.agentport_link_status
    FROM managed_service_operations o JOIN managed_service_accounts m
      ON m.id=o.account_id AND m.tenant_id=o.tenant_id
    WHERE o.operation_name='agentport_revoke' AND o.provider IN ('telnyx','higgsfield')
      AND ((o.status='uncertain' AND o.next_reconcile_at IS NOT NULL AND o.next_reconcile_at<=?)
        OR (o.status='running' AND o.lease_until IS NOT NULL AND o.lease_until<=?)
        OR (o.status='pending' AND o.created_at<=datetime(?,'-2 minutes')))
    ORDER BY COALESCE(o.next_reconcile_at,o.lease_until),o.created_at LIMIT ?`)
    .bind(at, at, at, limit).all<RevocationRow>();
  const result = { checked: due.results.length, reconciled: 0, deferred: 0, failed: 0 };

  for (const row of due.results) {
    const claimed = await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,
        next_reconcile_at=NULL,last_reconciled_at=?,reconcile_attempts=reconcile_attempts+1,updated_at=?
      WHERE operation_id=? AND tenant_id=? AND operation_name='agentport_revoke'
        AND ((status='uncertain' AND next_reconcile_at IS NOT NULL AND next_reconcile_at<=?)
          OR (status='running' AND lease_until IS NOT NULL AND lease_until<=?)
          OR (status='pending' AND created_at<=datetime(?,'-2 minutes')))`)
      .bind(new Date(now.getTime() + 120_000).toISOString(), at, at, row.operation_id, row.tenant_id, at, at, at).run();
    if (claimed.meta.changes !== 1) { result.deferred++; continue; }

    let expectedAccountId: string | null = null;
    try {
      const request = JSON.parse(row.request_json) as Record<string, unknown>;
      if (typeof request.agentportAccountId === "string") expectedAccountId = request.agentportAccountId;
    } catch { /* malformed journal is held below */ }
    if (expectedAccountId && expectedAccountId === row.agentport_account_id && row.agentport_link_status === "revoked") {
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='complete',lease_until=NULL,
          provider_operation_ref=?,error_code=NULL,next_reconcile_at=NULL,updated_at=?
        WHERE operation_id=? AND tenant_id=? AND status='running'`)
        .bind(expectedAccountId, at, row.operation_id, row.tenant_id).run();
      result.reconciled++;
      continue;
    }
    const allowedLinkStates = row.operation_status === "pending"
      ? ["active","unknown","revoking"] : ["unknown","revoking"];
    if (!expectedAccountId || !row.agentport_account_id || expectedAccountId !== row.agentport_account_id
      || !allowedLinkStates.includes(row.agentport_link_status ?? "")) {
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',lease_until=NULL,
          error_code='agentport_revoke_target_changed',next_reconcile_at=NULL,updated_at=?
        WHERE operation_id=? AND tenant_id=? AND status='running'`)
        .bind(at, row.operation_id, row.tenant_id).run();
      result.deferred++;
      continue;
    }

    try {
      await agentPortRevoke(env, row.tenant_id, expectedAccountId);
      const account = await env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET agentport_link_status='revoked',updated_at=?
        WHERE id=? AND tenant_id=? AND agentport_account_id=? AND agentport_link_status IN ('active','unknown','revoking')`)
        .bind(at, row.account_id, row.tenant_id, expectedAccountId).run();
      if (account.meta.changes !== 1) throw new Error("agentport_revoke_target_changed");
      const saved = await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='complete',lease_until=NULL,
          provider_operation_ref=?,error_code=NULL,next_reconcile_at=NULL,updated_at=?
        WHERE operation_id=? AND tenant_id=? AND status='running'`)
        .bind(expectedAccountId, at, row.operation_id, row.tenant_id).run();
      if (saved.meta.changes !== 1) throw new Error("agentport_revoke_operation_changed");
      result.reconciled++;
    } catch (error) {
      const attempt = row.reconcile_attempts + 1;
      const retryAt = new Date(now.getTime() + retryDelaySeconds(attempt) * 1_000).toISOString();
      const message = error instanceof Error ? error.message : "agentport_revoke_reconciliation_failed";
      const code = /^[a-z][a-z0-9_:-]{1,120}$/.test(message) ? message : "agentport_revoke_reconciliation_failed";
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET agentport_link_status='unknown',updated_at=?
        WHERE id=? AND tenant_id=? AND agentport_account_id=? AND agentport_link_status IN ('active','unknown','revoking')`)
        .bind(at, row.account_id, row.tenant_id, expectedAccountId).run().catch(() => undefined);
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='uncertain',lease_until=NULL,error_code=?,
          next_reconcile_at=?,last_reconciled_at=?,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='running'`)
        .bind(code, retryAt, at, at, row.operation_id, row.tenant_id).run().catch(() => undefined);
      result.failed++;
    }
  }
  return result;
}
