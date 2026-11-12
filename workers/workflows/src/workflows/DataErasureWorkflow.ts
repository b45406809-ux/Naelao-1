/**
 * DataErasureWorkflow
 *
 * Organization data-erasure workflow. Permanently removes the data covered by its cleanup steps.
 * It includes a 24-hour delay after suspension. The owner may cancel during that window; a
 * conditional request claim arbitrates cancellation against destructive cleanup.
 *
 * Steps:
 *   1. record-erasure-request  — insert audit_log entry
 *   2. suspend-org             — suspend org + all its spaces
 *   [24-hour cooling-off sleep]
 *   3. delete-spaces-data      — erase space D1, R2, Vectorize, ProductUserDO and provider state
 *   4. delete-user-pii         — anonymize user email / password_hash
 *   5. cancel-subscription     — mark subscription cancelled
 *   6. emit-completed          — audit log + emit org.erased and analytics correction events
 *
 * Gap IDs fulfilled: G-D01, G-D02, G-D03 (GDPR erasure pipeline)
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { mintInternalToken } from "@naelao/http";
import type { Env } from "../env";
import {
  anonymizeOrgUsers,
  claimErasureRequest,
  deleteKvPrefix,
  deleteR2Prefix,
  erasureAuditId,
  eraseOrgOperationalRecords,
  eraseSpaceD1Records,
  eraseSpaceDurableState,
  eraseSpaceKnowledgeDocumentResources,
  eraseSpaceKnowledgePrefixes,
  invalidateSpaceKnowledgeCaches,
  eraseSpaceR2Prefixes,
  eraseSpacesInSteps,
  eraseWorkspaceCoordinatorsForSpace,
  eraseTenantExportKeys,
  validateBlueprintExportKey,
} from "./erasure-cleanup.js";

export interface ErasureParams {
  orgId: string;
  requestedBy: string; // userId who triggered the erasure
  reason: string;
  requestId: string;
}

export class DataErasureWorkflow extends WorkflowEntrypoint<Env, ErasureParams> {
  async run(
    event: WorkflowEvent<ErasureParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const params = event.payload;

    const requestIsPending = await step.do("verify-erasure-request", async () => {
      const request = await this.env.PLATFORM_DB.prepare(
        `SELECT id FROM gdpr_requests
         WHERE id = ? AND tenant_id = ? AND requested_by = ? AND request_type = 'erasure' AND status = 'pending'`,
      ).bind(params.requestId, params.orgId, params.requestedBy).first<{ id: string }>();
      return Boolean(request);
    });
    if (!requestIsPending) return;

    // ── Step 1: Record erasure request in audit log ──────────────────────────
    await step.do("record-erasure-request", async () => {
      const auditId = erasureAuditId("requested", params.requestId);
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

      console.log("data_erasure_request_recorded");
      return { auditId };
    });

    // ── Step 2: Suspend org + spaces ─────────────────────────────────────────
    const holdPlaced = await step.do("suspend-org", async () => {
      await this.env.PLATFORM_DB.prepare(
        `UPDATE orgs SET status = 'suspended', suspension_reason = 'erasure'
         WHERE id = ? AND status = 'active' AND suspension_reason IS NULL
           AND EXISTS (SELECT 1 FROM gdpr_requests WHERE id = ? AND tenant_id = ? AND status = 'pending')`
      )
        .bind(params.orgId, params.requestId, params.orgId)
        .run();
      const request = await this.env.PLATFORM_DB.prepare(
        "SELECT id FROM gdpr_requests WHERE id = ? AND tenant_id = ? AND status = 'pending'",
      ).bind(params.requestId, params.orgId).first<{ id: string }>();
      if (!request) return false;
      const org = await this.env.PLATFORM_DB.prepare(
        "SELECT status, suspension_reason FROM orgs WHERE id = ?",
      ).bind(params.orgId).first<{ status: string; suspension_reason: string | null }>();
      if (org?.status !== "suspended" || org.suspension_reason !== "erasure") {
        throw new Error("Organization has an independent suspension hold");
      }

      await this.env.PLATFORM_DB.prepare(
        `UPDATE spaces SET status = 'suspended', suspension_reason = 'erasure', updated_at = datetime('now')
         WHERE tenant_id = ? AND status = 'active'
           AND EXISTS (SELECT 1 FROM gdpr_requests WHERE id = ? AND tenant_id = ? AND status = 'pending')`
      )
        .bind(params.orgId, params.requestId, params.orgId)
        .run();

      const stillPending = await this.env.PLATFORM_DB.prepare(
        "SELECT id FROM gdpr_requests WHERE id = ? AND tenant_id = ? AND status = 'pending'",
      ).bind(params.requestId, params.orgId).first<{ id: string }>();
      if (!stillPending) {
        await this.env.PLATFORM_DB.batch([
          this.env.PLATFORM_DB.prepare("UPDATE orgs SET status = 'active', suspension_reason = NULL WHERE id = ? AND status = 'suspended' AND suspension_reason = 'erasure'").bind(params.orgId),
          this.env.PLATFORM_DB.prepare("UPDATE spaces SET status = 'active', suspension_reason = NULL, updated_at = datetime('now') WHERE tenant_id = ? AND status = 'suspended' AND suspension_reason = 'erasure'").bind(params.orgId),
        ]);
        return false;
      }

      console.log("data_erasure_suspension_complete");
      return true;
    });
    if (!holdPlaced) return;

    // ── Delayed deletion: 24 hours ────────────────────────────────────────────
    // Owners can cancel during this delay; the status claim below arbitrates cancellation
    // against duplicate workflow deliveries before any destructive work begins.
    await step.sleep("cooling-off", "24 hours");

    const ownsErasure = await step.do("claim-erasure-request", async () => {
      return claimErasureRequest(this.env.PLATFORM_DB, params.orgId, params.requestedBy, params.requestId);
    });
    if (!ownsErasure) return;

    // ── Step 3: Delete space data (R2, Vectorize, D1) ────────────────────────
    await step.do("delete-usage-events", async () => {
      await this.env.PLATFORM_DB.prepare(
        `DELETE FROM usage_events WHERE org_id = ?`
      )
        .bind(params.orgId)
        .run();
    });

    // Checkpoint by Space instead of holding one Workflow step across the entire tenant.
    // A retry resumes at the current Space rather than replaying every prior Space cleanup.
    const spacesProcessed = await eraseSpacesInSteps(
      this.env.PLATFORM_DB,
      params.orgId,
      step,
      async (spaceId) => {
        const activeKnowledgeMutation = await this.env.PLATFORM_DB.prepare(`SELECT document_id FROM kb_document_mutation_leases
          WHERE space_id=? AND lease_until>? LIMIT 1`).bind(spaceId, new Date().toISOString()).first<{ document_id: string }>();
        if (activeKnowledgeMutation) throw new Error("Knowledge mutation is still active during Space erasure");
        let afterDocumentId = "";
        for (;;) {
          const { results: docs } = await this.env.PLATFORM_DB.prepare(
            `SELECT id, project_id, chunk_count FROM kb_documents
             WHERE space_id = ? AND id > ? ORDER BY id LIMIT 100`,
          ).bind(spaceId, afterDocumentId)
            .all<{ id: string; project_id: string | null; chunk_count: number | null }>();
          if (docs.length === 0) break;
          for (const document of docs) {
            await eraseSpaceKnowledgeDocumentResources(spaceId, document, this.env.KB_BUCKET, this.env.KB_VECTORS);
          }
          const nextDocumentId = docs[docs.length - 1]?.id;
          if (!nextDocumentId || nextDocumentId <= afterDocumentId) throw new Error("Invalid document erasure pagination cursor");
          afterDocumentId = nextDocumentId;
        }
        await eraseSpaceKnowledgePrefixes(spaceId, this.env.KB_BUCKET);
        const cacheCleanup = await step.do(`invalidate-knowledge-cache-${spaceId.slice(0, 48)}`, () =>
          invalidateSpaceKnowledgeCaches({
            tenantId: params.orgId, spaceId, platformSecret: this.env.PLATFORM_SECRET,
            knowledgeWorker: this.env.KNOWLEDGE_WORKER,
          }));
        if (cacheCleanup.cleanupPending) console.info("knowledge_cache_expiry_cleanup_pending");

        let workspaceCursor: string | undefined;
        let workspacePage = 0;
        do {
          const page = await step.do(`erase-workspace-coordinators-${spaceId.slice(0, 48)}-${workspacePage}`, () => eraseWorkspaceCoordinatorsForSpace({
            tenantId: params.orgId,
            spaceId,
            jurisdiction: this.env.DATA_JURISDICTION === "eu" ? "eu" : "global",
            platformSecret: this.env.PLATFORM_SECRET,
            spacesWorker: this.env.SPACES_WORKER,
            agentsWorker: this.env.AGENTS_WORKER,
            ...(workspaceCursor ? { after: workspaceCursor } : {}),
          }));
          if (page.hasMore && (!page.nextCursor || page.nextCursor === workspaceCursor)) throw new Error("Invalid workspace erasure pagination cursor");
          workspaceCursor = page.nextCursor ?? undefined;
          workspacePage++;
          if (!page.hasMore) break;
        } while (true);

        await step.do(`erase-space-do-${spaceId.slice(0, 48)}`, () => eraseSpaceDurableState({
          tenantId: params.orgId,
          spaceId,
          requestId: params.requestId,
          platformSecret: this.env.PLATFORM_SECRET,
          spacesWorker: this.env.SPACES_WORKER,
        }));

        await eraseSpaceR2Prefixes(params.orgId, spaceId, this.env.ARTIFACT_R2_BUCKET,
          this.env.REPOSITORY_OBJECTS, this.env.SCRIPTS_R2);
        let afterExportId = "";
        for (;;) {
          const { results: exports } = await this.env.PLATFORM_DB.prepare(
            `SELECT id, artifact_key FROM blueprint_export_jobs
             WHERE space_id = ? AND tenant_id = ? AND id > ? ORDER BY id LIMIT 100`,
          ).bind(spaceId, params.orgId, afterExportId).all<{ id: string; artifact_key: string }>();
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
          ).bind(spaceId, afterRowId).all<{ row_id: number; document_id: string; chunk_index: number }>();
          if (chunks.length === 0) break;
          for (let start = 0; start < chunks.length; start += 100) {
            await this.env.KB_VECTORS.deleteByIds(chunks.slice(start, start + 100)
              .map((chunk) => `${chunk.document_id}_chunk_${chunk.chunk_index}`));
          }
          afterRowId = chunks[chunks.length - 1]!.row_id;
        }

        // Remove every tenant-owned searchable/session record, including parent summaries
        // that are not covered by the session table's cascade.
        const productUserErasure = await this.env.SPACES_WORKER.fetch(new Request(
          `https://spaces.internal/internal/tenant/${encodeURIComponent(params.orgId)}/spaces/${encodeURIComponent(spaceId)}/product-users/erase`,
          { method: "DELETE", headers: {
            "x-naelao-tenant-id": params.orgId,
            "x-naelao-internal-token": await mintInternalToken(this.env.PLATFORM_SECRET, params.orgId),
          } },
        ));
        if (!productUserErasure.ok) throw new Error(`Product-user erasure failed with status ${productUserErasure.status}`);
        const businessServiceErasure = await this.env.SPACES_WORKER.fetch(new Request(
          `https://spaces.internal/internal/tenant/${encodeURIComponent(params.orgId)}/spaces/${encodeURIComponent(spaceId)}/domains/erase`,
          { method: "DELETE", headers: {
            "x-naelao-tenant-id": params.orgId,
            "x-naelao-internal-token": await mintInternalToken(this.env.PLATFORM_SECRET, params.orgId),
          } },
        ));
        if (!businessServiceErasure.ok) throw new Error(`Space-domain erasure failed with status ${businessServiceErasure.status}`);
        await eraseSpaceD1Records(this.env.PLATFORM_DB, spaceId, this.env.SCRIPTS_R2, params.orgId);

        console.log("data_erasure_space_cleanup_complete");
      },
    );
    console.log("data_erasure_workspace_cleanup_complete", { spacesProcessed });

    await step.do("erase-tenant-blueprint-artifacts", async () => {
      // New certified templates are tenant-namespaced. Keep marketplace fork receipts in D1 for
      // existing licensees, but remove the erased publisher's source exports and certificates.
      await deleteR2Prefix(this.env.SCRIPTS_R2, `blueprints/${params.orgId}/`);
      await deleteR2Prefix(this.env.SCRIPTS_R2, `conformance-jobs/${params.orgId}/`);
      return { tenantArtifactsErased: true };
    });

    // ── Step 4: Anonymize user PII ────────────────────────────────────────────
    await step.do("delete-user-pii", async () => {
      // Preserve IDs needed by retained audit records, but remove credentials and direct PII.
      await anonymizeOrgUsers(this.env.PLATFORM_DB, params.orgId);
      await eraseOrgOperationalRecords(this.env.PLATFORM_DB, params.orgId, this.env.SCRIPTS_R2);

      console.log("data_erasure_identity_anonymization_complete");
      return { piiErased: true };
    });

    // ── Step 4b: Clear KV cache for the erased org ────────────────────────────
    // G-AZ34: Delete all CF KV cached responses scoped to this tenant.
    // QUOTA_CACHE keys follow the pattern: {orgId}:* (quota entries, config, etc.)
    await step.do("clear-kv-cache", async () => {
      const deleted = await deleteKvPrefix(this.env.QUOTA_CACHE, `${params.orgId}:`);

      console.log("data_erasure_cache_cleanup_complete", { deleted });
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

      console.log("data_erasure_subscription_cancelled");
      return { subscriptionCancelled: true };
    });

    // ── Step 6: Emit erasure-completed event ──────────────────────────────────
    await step.do("emit-completed", async () => {
      // Final audit log entry
      const completionAuditId = erasureAuditId("completed", params.requestId);
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

      await this.env.PLATFORM_DB.prepare(
        "UPDATE gdpr_requests SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'processing'",
      ).bind(new Date().toISOString(), new Date().toISOString(), params.requestId, params.orgId).run();

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

      console.log("data_erasure_completed");
      return { completionAuditId, emitted: true };
    });
  }
}
