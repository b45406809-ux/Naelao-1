import type { AgentsEnv } from "../index.js";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import { channelPreferences, scopeAccess, type CommunicationIdentity, type CommunicationScope } from "./core.js";
import type { AssistantPhoneBinding } from "./phones.js";
import { observeTelnyxSmsCost } from "./telnyx-send.js";

/** A bounded, durable hourly sweep. Claims survive worker crashes and retries perform only
 * provider reads. Never use this as a payment ledger or auto-release uncertain sends. */
export async function sweepTelnyxSmsCosts(env: AgentsEnv, now = Math.floor(Date.now() / 1000)) {
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO assistant_telnyx_cost_polls(action_id,status,next_at,updated_at)
    SELECT a.id,CASE WHEN a.created_at<datetime('now','-9 days') THEN 'expired' ELSE 'pending' END,?,? FROM assistant_phone_actions a JOIN assistant_phone_bindings b ON b.id=a.binding_id
    JOIN assistant_communication_identities i ON i.id=b.identity_id
    WHERE b.provider='telnyx' AND b.payer='byo' AND b.status='active' AND i.status='active'
      AND a.kind='sms' AND a.status='sent' AND a.provider_sid IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM assistant_telnyx_cost_polls p WHERE p.action_id=a.id)
    ORDER BY a.created_at DESC,a.id LIMIT 200`).bind(now, now).run();
  const due = await env.PLATFORM_DB.prepare(`SELECT action_id FROM assistant_telnyx_cost_polls
    WHERE (status='pending' AND next_at<=?) OR (status='running' AND lease_until<=?) ORDER BY next_at,action_id LIMIT 8`)
    .bind(now, now).all<{ action_id: string }>();
  await Promise.all(due.results.map(async ({ action_id }) => {
    const claim = await env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_cost_polls SET status='running',attempts=attempts+1,lease_until=?,updated_at=?
      WHERE action_id=? AND ((status='pending' AND next_at<=?) OR (status='running' AND lease_until<=?))`)
      .bind(now + 120, now, action_id, now, now).run();
    if (!claim.meta.changes) return;
    let status: "pending" | "observed" | "held" | "expired" = "pending", error: string | null = null;
    let exhausted = false;
    try {
      const row = await env.PLATFORM_DB.prepare(`SELECT a.binding_id,a.created_at,p.attempts FROM assistant_phone_actions a
        JOIN assistant_telnyx_cost_polls p ON p.action_id=a.id WHERE a.id=?`).bind(action_id)
        .first<{ binding_id: string; created_at: string; attempts: number }>();
      if (!row) return;
      const created = Date.parse(row.created_at.replace(" ", "T") + (row.created_at.includes("T") ? "" : "Z"));
      exhausted = row.attempts >= 96 || !Number.isFinite(created) || created < (now - 9 * 86400) * 1000;
      if (exhausted) {
        await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_cost_polls SET status='expired',lease_until=NULL,last_error='provider_window_expired',updated_at=? WHERE action_id=? AND status='running' AND lease_until=?")
          .bind(now, action_id, now + 120).run();
        return;
      }
      const binding = await env.PLATFORM_DB.prepare("SELECT * FROM assistant_phone_bindings WHERE id=? AND provider='telnyx' AND payer='byo' AND status='active'")
        .bind(row.binding_id).first<AssistantPhoneBinding>();
      const identity = binding && await env.PLATFORM_DB.prepare("SELECT * FROM assistant_communication_identities WHERE id=? AND status='active'")
        .bind(binding.identity_id).first<CommunicationIdentity>();
      if (!binding || !identity) { status = "held"; error = "binding_unavailable"; }
      else {
        const scope: CommunicationScope = { tenantId: identity.tenant_id, spaceId: identity.space_id, userId: identity.owner_user_id,
          role: "product_end_user", ...(identity.project_id ? { projectId: identity.project_id } : {}) };
        if (!await scopeAccess(env, scope) || !(await channelPreferences(env, scope)).enabled.phone || await isSpaceNetworkEgressDenied(env.PLATFORM_DB, identity.space_id)) {
          status = "held"; error = "scope_or_egress_unavailable";
        } else {
          const result = await observeTelnyxSmsCost(env, identity, binding, action_id);
          if (result.status === "observed") status = "observed";
        }
      }
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "provider_unavailable";
      if (["telnyx_reconciliation_record_mismatch", "telnyx_binding_mismatch", "telnyx_cost_receipt_invalid"].includes(code)) status = "held";
      error = /^[a-z_]{1,80}$/.test(code) ? code : "provider_unavailable";
    }
    await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_cost_polls SET status=?,next_at=?,lease_until=NULL,last_error=?,updated_at=? WHERE action_id=? AND status='running' AND lease_until=?")
      .bind(status, now + 3600, error, now, action_id, now + 120).run();
  }));
}
