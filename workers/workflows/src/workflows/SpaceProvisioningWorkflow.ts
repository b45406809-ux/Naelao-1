/**
 * SpaceProvisioningWorkflow
 *
 * CF Workflow that provisions a new Space end-to-end:
 *   1. Validate space + org subscription in D1
 *   2. Warm the SpaceDO via SPACES_WORKER internal endpoint
 *   3. Log Vectorize namespace note (shared index — no per-space namespace)
 *   4. Flip space status to 'active' in D1
 *   5. Emit space.provisioned event to EVENTS_QUEUE
 *
 * Gap IDs fulfilled: G-C01, G-C02 (async provisioning)
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { readBoundedResponseText } from "@naelao/http";
import type { Env } from "../env";

export interface ProvisioningParams {
  spaceId: string;
  tenantId: string;
  spaceTypeId: string;
  orgId: string;
}

export class SpaceProvisioningWorkflow extends WorkflowEntrypoint<Env, ProvisioningParams> {
  async run(
    event: WorkflowEvent<ProvisioningParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const params = event.payload;

    // ── Step 1: Validate space + active subscription ────────────────────────
    // G-BC03: Per-step retry with exponential backoff for transient failures
    const networkRetry = {
      retries: { limit: 3, delay: 1000, backoff: "exponential" as const },
      timeout: 30_000,
    };

    await step.do("validate-space", networkRetry, async () => {
      // Confirm the space record exists and belongs to the expected tenant
      const space = await this.env.PLATFORM_DB.prepare(
        `SELECT id, status FROM spaces WHERE id = ? AND tenant_id = ? AND spacetype_id = ?`
      )
        .bind(params.spaceId, params.tenantId, params.spaceTypeId)
        .first<{ id: string; status: string }>();

      if (!space) {
        throw new Error(
          `Space ${params.spaceId} not found for tenant ${params.tenantId} with spaceTypeId ${params.spaceTypeId}`,
        );
      }

      // Confirm org has an active (or trialing) subscription
      const subscription = await this.env.PLATFORM_DB.prepare(
        `SELECT id, status FROM subscriptions WHERE org_id = ? AND status IN ('active', 'trialing')`
      )
        .bind(params.orgId)
        .first<{ id: string; status: string }>();

      if (!subscription) {
        throw new Error(
          `Org ${params.orgId} does not have an active subscription — cannot provision space`,
        );
      }

      return { spaceId: space.id, spaceStatus: space.status, subscriptionStatus: subscription.status };
    });

    // ── Step 2: Init SpaceDO via SPACES_WORKER ──────────────────────────────
    await step.do("init-space-do", networkRetry, async () => {
      const resp = await this.env.SPACES_WORKER.fetch(
        `https://spaces-worker/internal/spaces/${params.spaceId}/init`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Secret": "workflow-internal",
          },
          body: JSON.stringify({ tenantId: params.tenantId }),
        },
      );

      if (!resp.ok) {
        let text = "";
        try { text = (await readBoundedResponseText(resp, 8 * 1024)).slice(0, 300); } catch { text = "response_body_unavailable"; }
        throw new Error(`SpaceDO init failed (${resp.status}): ${text}`);
      }

      return { ok: true };
    });

    // ── Step 3: Vectorize namespace note ─────────────────────────────────────
    // CF free/paid plans use a single shared Vectorize index filtered by spaceId.
    // No per-space namespace creation is needed — document this for observability.
    await step.do("init-vectorize-namespace", networkRetry, async () => {
      console.log(
        `[SpaceProvisioning] Space ${params.spaceId}: Vectorize uses shared index ` +
          `filtered by space_id field — no per-space namespace to create.`,
      );
      return { note: "shared-index" };
    });

    // ── Step 4: Flip space status to active ──────────────────────────────────
    await step.do("update-status", networkRetry, async () => {
      await this.env.PLATFORM_DB.prepare(
        `UPDATE spaces
         SET status = 'active', updated_at = datetime('now')
         WHERE id = ? AND status != 'active'`
      )
        .bind(params.spaceId)
        .run();

      return { status: "active" };
    });

    // ── Step 5: Emit provisioned event ────────────────────────────────────────
    await step.do("emit-event", networkRetry, async () => {
      const eventPayload = {
        type: "space.provisioned",
        spaceId: params.spaceId,
        tenantId: params.tenantId,
        orgId: params.orgId,
        timestamp: new Date().toISOString(),
      };

      await this.env.EVENTS_QUEUE.send(eventPayload);

      return { sent: true, eventType: "space.provisioned" };
    });
  }
}
