/**
 * DataErasureWorkflow
 *
 * Organization data-erasure workflow. Permanently removes the data covered by its cleanup steps.
 * It includes a 24-hour delay after suspension. A request/cancellation and restoration path is
 * not currently wired, so this delay is not a reversible cooling-off window.
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
import {
  anonymizeOrgUsers,
  deleteKvPrefix,
  eraseOrgOperationalRecords,
  eraseSpaceD1Records,
  eraseSpaceKnowledgeDocumentResources,
  eraseSpaceKnowledgePrefixes,
  eraseSpaceR2Prefixes,
  eraseTenantExportKeys,
  validateBlueprintExportKey,
} from "./erasure-cleanup.js";

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
        `UPDATE spaces SET status = 'suspended', suspension_reason = 'erasure', updated_at = datetime('now')
         WHERE tenant_id = ? AND status = 'active'`
      )
        .bind(params.orgId)
        .run();

      console.log(`[DataErasure] Org ${params.orgId} and its spaces suspended.`);
      return { suspended: true };
    });

    // ── Delayed deletion: 24 hours ────────────────────────────────────────────
    // This is only a delay. There is no cancellation or restoration path yet.
    await step.sleep("cooling-off", "24 hours");

    // ── Step 3: Delete space data (R2, Vectorize, D1) ────────────────────────
    // G-E08: Paginated R2 deletion — iterate all pages, not just first
    await step.do("delete-spaces-data", async () => {
      // Delete usage events for this org
      await this.env.PLATFORM_DB.prepare(
        `DELETE FROM usage_events WHERE org_id = ?`
      )
        .bind(params.orgId)
        .run();

      // Page spaces and documents so a long-lived org cannot force unbounded D1 result arrays.
      let afterSpaceId = "";
      let spacesProcessed = 0;
      for (;;) {
        const { results: spaces } = await this.env.PLATFORM_DB.prepare(
          "SELECT id FROM spaces WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT 100",
        ).bind(params.orgId, afterSpaceId).all<{ id: string }>();
        if (spaces.length === 0) break;
        const nextSpaceId = spaces[spaces.length - 1]?.id;
        if (!nextSpaceId || nextSpaceId <= afterSpaceId) throw new Error("Invalid space erasure pagination cursor");

        for (const space of spaces) {
          let afterDocumentId = "";
          for (;;) {
            const { results: docs } = await this.env.PLATFORM_DB.prepare(
              `SELECT id, project_id, chunk_count FROM kb_documents
               WHERE space_id = ? AND id > ? ORDER BY id LIMIT 100`,
            ).bind(space.id, afterDocumentId)
              .all<{ id: string; project_id: string | null; chunk_count: number | null }>();
            if (docs.length === 0) break;
            for (const document of docs) {
              await eraseSpaceKnowledgeDocumentResources(space.id, document, this.env.KB_BUCKET, this.env.KB_VECTORS);
            }
            const nextDocumentId = docs[docs.length - 1]?.id;
            if (!nextDocumentId || nextDocumentId <= afterDocumentId) throw new Error("Invalid document erasure pagination cursor");
            afterDocumentId = nextDocumentId;
          }
          await eraseSpaceKnowledgePrefixes(space.id, this.env.KB_BUCKET);

          await eraseSpaceR2Prefixes(params.orgId, space.id, this.env.ARTIFACT_R2_BUCKET,
            this.env.REPOSITORY_OBJECTS, this.env.SCRIPTS_R2);
          let afterExportId = "";
          for (;;) {
            const { results: exports } = await this.env.PLATFORM_DB.prepare(
              `SELECT id, artifact_key FROM blueprint_export_jobs
               WHERE space_id = ? AND tenant_id = ? AND id > ? ORDER BY id LIMIT 100`,
            ).bind(space.id, params.orgId, afterExportId).all<{ id: string; artifact_key: string }>();
            if (exports.length === 0) break;
            const scopedKeys = exports.map(({ id, artifact_key }) =>
              validateBlueprintExportKey(params.orgId, id, artifact_key));
            await eraseTenantExportKeys(params.orgId, this.env.SCRIPTS_R2, scopedKeys);
            const nextExportId = exports[exports.length - 1]?.id;
            if (!nextExportId || nextExportId <= afterExportId) throw new Error("Invalid blueprint export pagination cursor");
            afterExportId = nextExportId;
          }

          // Also remove vectors referenced only by the chunk registry (for orphaned/legacy docs).
          let afterRowId = 0;
          for (;;) {
            const { results: chunks } = await this.env.PLATFORM_DB.prepare(
              `SELECT rowid AS row_id, document_id, chunk_index FROM kb_chunks
               WHERE space_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT 1000`
            ).bind(space.id, afterRowId).all<{ row_id: number; document_id: string; chunk_index: number }>();
            if (chunks.length === 0) break;
            for (let start = 0; start < chunks.length; start += 100) {
              await this.env.KB_VECTORS.deleteByIds(chunks.slice(start, start + 100)
                .map((chunk) => `${chunk.document_id}_chunk_${chunk.chunk_index}`));
            }
            afterRowId = chunks[chunks.length - 1]!.row_id;
          }

          // Remove every tenant-owned searchable/session record, including parent summaries
          // that are not covered by the session table's cascade.
          await eraseSpaceD1Records(this.env.PLATFORM_DB, space.id);

          console.log(`[DataErasure] Cleaned space=${space.id} for org=${params.orgId}`);
          spacesProcessed++;
        }
        afterSpaceId = nextSpaceId;
      }

      console.log(
        `[DataErasure] Deleted data for ${spacesProcessed} space(s) in org=${params.orgId}`,
      );
      return { spacesProcessed };
    });

    // ── Step 4: Anonymize user PII ────────────────────────────────────────────
    await step.do("delete-user-pii", async () => {
      // Preserve IDs needed by retained audit records, but remove credentials and direct PII.
      await anonymizeOrgUsers(this.env.PLATFORM_DB, params.orgId);
      await eraseOrgOperationalRecords(this.env.PLATFORM_DB, params.orgId);

      console.log(`[DataErasure] PII anonymized for users in org=${params.orgId}`);
      return { piiErased: true };
    });

    // ── Step 4b: Clear KV cache for the erased org ────────────────────────────
    // G-AZ34: Delete all CF KV cached responses scoped to this tenant.
    // QUOTA_CACHE keys follow the pattern: {orgId}:* (quota entries, config, etc.)
    await step.do("clear-kv-cache", async () => {
      const deleted = await deleteKvPrefix(this.env.QUOTA_CACHE, `${params.orgId}:`);

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
      await this.env.ANALYTICS_QUEUE.send({
        eventType: "user_erased",
        tenantId: params.orgId,
        metadata: { erasedAt: completedAt, reason: params.reason.slice(0, 500) },
      });

      console.log(
        `[DataErasure] Erasure completed for org=${params.orgId}, auditId=${completionAuditId}`,
      );
      return { completionAuditId, emitted: true };
    });
  }
}
