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
import { activateSpaceForActiveTenant } from "./space-provisioning-state.js";

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

    const eligible = await step.do("validate-space", networkRetry, async () => {
      // Confirm the Space and its organization are still active enough to provision.
      const space = await this.env.PLATFORM_DB.prepare(
        `SELECT s.id, s.status FROM spaces s
         JOIN orgs o ON o.id = s.tenant_id AND o.status = 'active'
         WHERE s.id = ? AND s.tenant_id = ? AND s.spacetype_id = ? AND o.id = ? AND s.status = 'provisioning'`
      )
        .bind(params.spaceId, params.tenantId, params.spaceTypeId, params.orgId)
        .first<{ id: string; status: string }>();

      if (!space) {
        console.warn(`[SpaceProvisioning] Space or active tenant no longer eligible: ${params.spaceId}`);
        return false;
      }

      // Confirm org has an active (or trialing) subscription
      const subscription = await this.env.PLATFORM_DB.prepare(
        `SELECT id, status FROM subscriptions WHERE org_id = ? AND status IN ('active', 'trialing')`
      )
        .bind(params.orgId)
        .first<{ id: string; status: string }>();

      if (!subscription) {
        console.warn(`[SpaceProvisioning] Org ${params.orgId} has no active subscription`);
        return false;
      }

      return true;
    });
    if (!eligible) return;

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
    const activated = await step.do("update-status", networkRetry, async () => {
      return activateSpaceForActiveTenant(this.env.PLATFORM_DB, params);
    });
    if (!activated) {
      console.warn(`[SpaceProvisioning] Activation lost tenant/space status race: ${params.spaceId}`);
      return;
    }

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
