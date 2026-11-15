import type { AgentsEnv } from "../index.js";
import { createVaultProxy } from "../script-engine/vault-proxy.js";
import { createOpenRouterAudio } from "../voice/openrouter-audio.js";
import { createVoiceAudioAdmission, type VoiceUsageRecord } from "../voice/audio-usage-admission.js";
import { TelnyxExtensionVoiceUsageJournal } from "./telnyx-extension-voice-runtime.js";

/** Reconcile only receipts whose stream has ended or whose pinned session deadline has elapsed.
 * This settles/releases durable reservations; it never admits a call or issues a provider request
 * other than the existing usage lookup for a recorded generation ID. */
export async function sweepTelnyxExtensionAudioUsage(env: AgentsEnv, limit = 10): Promise<{ examined: number; settled: number; unresolved: number }> {
  if (!env.BILLING_WORKER || !env.CREDENTIALS_WORKER) return { examined: 0, settled: 0, unresolved: 0 };
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.PLATFORM_DB.prepare(`SELECT DISTINCT s.session_id,s.call_ref,s.tenant_id,s.space_id,s.project_id,
      s.extension_installation_id,s.expires_at
    FROM assistant_telnyx_extension_stream_sessions s
    JOIN assistant_telnyx_extension_calls c ON c.call_control_id=s.call_control_id AND c.binding_id=s.binding_id
    WHERE (s.state='ended' OR s.expires_at<=? OR c.state='ended' OR c.state='indeterminate')
      AND EXISTS (SELECT 1 FROM assistant_telnyx_extension_audio_usage u WHERE u.session_id=s.session_id
        AND json_extract(u.record_json,'$.state') IN ('reserving','held','pending','settle_retry'))
    ORDER BY s.expires_at,s.session_id LIMIT ?`)
    .bind(now, Math.min(25, Math.max(1, Number.isSafeInteger(limit) ? limit : 10)))
    .all<{ session_id: string; call_ref: string; tenant_id: string; space_id: string; project_id: string | null;
      extension_installation_id: string; expires_at: number }>();
  let settled = 0, unresolved = 0, examined = 0;
  for (const row of rows.results ?? []) {
    examined++;
    const journal = new TelnyxExtensionVoiceUsageJournal(env.PLATFORM_DB, row.session_id, row.call_ref);
    const vault = createVaultProxy({ credentialsWorker: env.CREDENTIALS_WORKER, platformSecret: env.PLATFORM_SECRET,
      tenantId: row.tenant_id, spaceId: row.space_id, agentId: row.extension_installation_id,
      ...(row.project_id ? { projectId: row.project_id } : {}), runId: `telnyx-${row.call_ref}`, purpose: "assistant-audio" });
    const audio = createOpenRouterAudio({ vault, credentialName: "llm_byok_active::openrouter",
      authorize: async () => { throw new Error("telnyx_voice_reconciliation_only"); } });
    const admission = createVoiceAudioAdmission({ tenantId: row.tenant_id, spaceId: row.space_id, callId: row.call_ref,
      secret: env.PLATFORM_SECRET, billingWorker: env.BILLING_WORKER, maxCostUsd: 100, journal,
      stillAllowed: async () => false,
      resolveGeneration: (id, fallbackTokens) => audio.resolveGeneration(id, fallbackTokens) });
    const result = await admission.reconcile().catch(() => ({ settled: 0, unresolved: 1 }));
    settled += result.settled;
    unresolved += result.unresolved;
    // Surface old unresolved provider outcomes without retaining transcripts or audio.
    if (result.unresolved) {
      const entries = await journal.list<VoiceUsageRecord>({ prefix: `voice-audio:${row.call_ref}:` }).catch(() => new Map());
      const oldest = [...entries.values()].filter(entry => !["settled", "released", "denied"].includes(entry.state))
        .reduce((value, entry) => Math.min(value, entry.updatedAt), Number.POSITIVE_INFINITY);
      if (Number.isFinite(oldest) && now * 1000 - oldest > 60 * 60 * 1000)
        console.warn("telnyx_extension_audio_usage_attention", { sessionId: row.session_id, unresolved: result.unresolved });
    }
  }
  return { examined, settled, unresolved };
}
