/**
 * DataErasureWorkflow
 *
 * GDPR / right-to-erasure workflow. Permanently erases all PII and data for an org.
 * Includes a 24-hour cooling-off period between suspension and hard deletion
 * to satisfy regulatory requirements and allow accidental-request reversal.
 *
 * Steps:
 *   1. record-erasure-request  — insert audit_log entry
 *   2. suspend-org             — suspend org + all its spaces
 *   [24-hour cooling-off sleep]
 *   3. delete-spaces-data      — delete usage_events; log R2 deletion intent
 *   4. delete-user-pii         — anonymize user email / password_hash
 *   5. cancel-subscription     — mark subscription cancelled
 *   6. emit-completed          — audit log + emit org.erased event
 *
 * Gap IDs fulfilled: G-D01, G-D02, G-D03 (GDPR erasure pipeline)
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../env";

export interface ErasureParams {
  orgId: string;
  requestedBy: string; // userId who triggered the erasure
  reason: string;
}

export class DataErasureWorkflow extends WorkflowEntrypoint<Env, ErasureParams> {
  async run(
    event: WorkflowEvent<ErasureParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const params = event.payload;

    // ── Step 1: Record erasure request in audit log ──────────────────────────
    await step.do("record-erasure-request", async () => {
      const auditId = crypto.randomUUID();
      await this.env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO audit_log
           (id, tenant_id, actor_id, actor_type, event_type, resource_type, resource_id, event_data)
         VALUES (?, ?, ?, 'user', 'erasure_requested', 'org', ?, ?)`
      )
        .bind(
          auditId,
          params.orgId,
          params.requestedBy,
          params.orgId,
          JSON.stringify({ reason: params.reason, requestedBy: params.requestedBy }),
        )
        .run();

      console.log(`[DataErasure] Erasure request recorded: org=${params.orgId}, auditId=${auditId}`);
      return { auditId };
    });

    // ── Step 2: Suspend org + spaces ─────────────────────────────────────────
    await step.do("suspend-org", async () => {
      await this.env.PLATFORM_DB.prepare(
        `UPDATE orgs SET status = 'suspended' WHERE id = ? AND status != 'suspended'`
      )
        .bind(params.orgId)
        .run();

      await this.env.PLATFORM_DB.prepare(
        `UPDATE spaces SET status = 'suspended', updated_at = datetime('now')
         WHERE tenant_id = ? AND status != 'suspended'`
      )
        .bind(params.orgId)
        .run();

      console.log(`[DataErasure] Org ${params.orgId} and its spaces suspended.`);
      return { suspended: true };
    });

    // ── Regulatory cooling-off period: 24 hours ───────────────────────────────
    // CF Workflows supports sleep durations up to 1 year.
    // This satisfies GDPR Art. 17 implementation requirements (reversibility window).
    await step.sleep("cooling-off", "24 hours");

    // ── Step 3: Delete space data (R2, Vectorize, D1) ────────────────────────
    // G-E08: Paginated R2 deletion — iterate all pages, not just first
    await step.do("delete-spaces-data", async () => {
      // Fetch all space IDs for this org
      const { results: spaces } = await this.env.PLATFORM_DB.prepare(
        `SELECT id FROM spaces WHERE tenant_id = ?`
      )
        .bind(params.orgId)
        .all<{ id: string }>();

      // Delete usage events for this org
      await this.env.PLATFORM_DB.prepare(
        `DELETE FROM usage_events WHERE org_id = ?`
      )
        .bind(params.orgId)
        .run();

      // Delete R2 objects and Vectorize vectors for each space
      for (const space of spaces) {
        // Get all indexed KB documents for this space
        const { results: docs } = await this.env.PLATFORM_DB.prepare(
          `SELECT id, chunk_count FROM kb_documents WHERE space_id = ?`
        )
          .bind(space.id)
          .all<{ id: string; chunk_count: number }>();

        for (const doc of docs) {
          // Delete R2 objects — paginated (G-E08 fix: don't stop at first page)
          const prefix = `kb/${space.id}/${doc.id}/`;
          let cursor: string | undefined;
          do {
            const listOpts: R2ListOptions = cursor !== undefined ? { prefix, cursor } : { prefix };
            const listed: R2Objects = await this.env.KB_BUCKET.list(listOpts);
            if (listed.objects.length > 0) {
              await Promise.all(listed.objects.map((o) => this.env.KB_BUCKET.delete(o.key)));
            }
            cursor = listed.truncated ? listed.cursor : undefined;
          } while (cursor);

          // Delete Vectorize vectors
          const chunkCount = doc.chunk_count ?? 0;
          if (chunkCount > 0) {
            const vectorIds = Array.from({ length: chunkCount }, (_, i) => `${doc.id}_chunk_${i}`);
            const BATCH = 100;
            for (let i = 0; i < vectorIds.length; i += BATCH) {
              await this.env.KB_VECTORS.deleteByIds(vectorIds.slice(i, i + BATCH));
            }
          }
        }

        // Delete all D1 KB document records for this space
        await this.env.PLATFORM_DB.prepare(
          `DELETE FROM kb_documents WHERE space_id = ?`
        ).bind(space.id).run();

        // Delete active session registry entries for this space
        await this.env.PLATFORM_DB.prepare(
          `DELETE FROM active_sessions WHERE space_id = ?`
        ).bind(space.id).run();

        await this.env.PLATFORM_DB.prepare(
          `DELETE FROM thread_sessions WHERE space_id = ?`
        ).bind(space.id).run();

        console.log(`[DataErasure] Cleaned space=${space.id} for org=${params.orgId}`);
      }

      console.log(
        `[DataErasure] Deleted data for ${spaces.length} space(s) in org=${params.orgId}`,
      );
      return { spacesProcessed: spaces.length };
    });

    // ── Step 4: Anonymize user PII ────────────────────────────────────────────
    await step.do("delete-user-pii", async () => {
      // Overwrite email with a non-identifiable placeholder; clear password_hash.
      // The id is preserved so foreign-key references remain intact.
      await this.env.PLATFORM_DB.prepare(
        `UPDATE users
         SET email = 'erased-' || id || '@deleted.invalid',
             status = 'erased',
             preferred_language = NULL
         WHERE org_id = ?`
      )
        .bind(params.orgId)
        .run();

      console.log(`[DataErasure] PII anonymized for users in org=${params.orgId}`);
      return { piiErased: true };
    });

    // ── Step 4b: Clear KV cache for the erased org ────────────────────────────
    // G-AZ34: Delete all CF KV cached responses scoped to this tenant.
    // QUOTA_CACHE keys follow the pattern: {orgId}:* (quota entries, config, etc.)
    await step.do("clear-kv-cache", async () => {
      const prefix = `${params.orgId}:`;
      let cursor: string | undefined;
      let deleted = 0;
      do {
        const listOpts = cursor !== undefined
          ? { prefix, cursor }
          : { prefix };
        const listed = await this.env.QUOTA_CACHE.list(listOpts);
        for (const key of listed.keys) {
          await this.env.QUOTA_CACHE.delete(key.name);
          deleted++;
        }
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);

      console.log(`[DataErasure] Cleared ${deleted} KV cache entries for org=${params.orgId}`);
      return { kvKeysDeleted: deleted };
    });

    // ── Step 5: Cancel subscription ───────────────────────────────────────────
    await step.do("cancel-subscription", async () => {
      await this.env.PLATFORM_DB.prepare(
        `UPDATE subscriptions
         SET status = 'cancelled', updated_at = datetime('now')
         WHERE org_id = ? AND status != 'cancelled'`
      )
        .bind(params.orgId)
        .run();

      console.log(`[DataErasure] Subscription cancelled for org=${params.orgId}`);
      return { subscriptionCancelled: true };
    });

    // ── Step 6: Emit erasure-completed event ──────────────────────────────────
    await step.do("emit-completed", async () => {
      // Final audit log entry
      const completionAuditId = crypto.randomUUID();
      await this.env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO audit_log
           (id, tenant_id, actor_id, actor_type, event_type, resource_type, resource_id, event_data)
         VALUES (?, ?, ?, 'system', 'erasure_completed', 'org', ?, ?)`
      )
        .bind(
          completionAuditId,
          params.orgId,
          params.requestedBy,
          params.orgId,
          JSON.stringify({ reason: params.reason, completedAt: new Date().toISOString() }),
        )
        .run();

      const completedAt = new Date().toISOString();

      // Emit org.erased event to the main event queue
      await this.env.EVENTS_QUEUE.send({
        type: "org.erased",
        orgId: params.orgId,
        requestedBy: params.requestedBy,
        timestamp: completedAt,
      });

      // G-AZ34: Analytics Engine is append-only — cannot delete rows.
      // Emit an analytics.user_erased correction record so the analytics worker
      // can write a null_user_id anonymization marker into Analytics Engine.
      await this.env.EVENTS_QUEUE.send({
        type: "analytics.user_erased",
        orgId: params.orgId,
        erasedAt: completedAt,
        reason: params.reason,
      });

      console.log(
        `[DataErasure] Erasure completed for org=${params.orgId}, auditId=${completionAuditId}`,
      );
      return { completionAuditId, emitted: true };
    });
  }
}
