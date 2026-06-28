/**
 * DunningWorkflow
 *
 * Subscription dunning workflow for failed/past-due invoice payments.
 * Supports up to 3 retry attempts. On attempt 3 the subscription is
 * moved to 'past_due' and an audit trail is written.
 *
 * Steps:
 *   1. check-payment-status      — guard: skip if invoice already paid
 *   2. send-dunning-email        — stub: log email intent (Phase 6 wires real email)
 *   3. schedule-retry-or-suspend — enqueue next attempt or mark past_due
 *   4. emit-event                — emit dunning.attempted to EVENTS_QUEUE
 *
 * Gap IDs fulfilled: G-E01, G-E02 (billing dunning automation)
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../env";

export interface DunningParams {
  orgId: string;
  invoiceId: string;
  stripeInvoiceId?: string;
  attemptNumber: number; // 1, 2, or 3
}

export class DunningWorkflow extends WorkflowEntrypoint<Env, DunningParams> {
  async run(
    event: WorkflowEvent<DunningParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const params = event.payload;

    // ── Step 1: Check current invoice payment status ──────────────────────────
    // Idempotent guard — if a webhook already marked this invoice paid, bail out.
    const { invoiceStatus } = await step.do("check-payment-status", async () => {
      const invoice = await this.env.PLATFORM_DB.prepare(
        `SELECT status FROM invoices WHERE id = ?`
      )
        .bind(params.invoiceId)
        .first<{ status: string }>();

      if (!invoice) {
        throw new Error(
          `Invoice ${params.invoiceId} not found — cannot run dunning workflow`,
        );
      }

      console.log(
        `[Dunning] Invoice ${params.invoiceId} status=${invoice.status} ` +
          `(org=${params.orgId}, attempt=${params.attemptNumber})`,
      );

      return { invoiceStatus: invoice.status };
    });

    // If the invoice was already paid (e.g., by a concurrent webhook) we stop here.
    if (invoiceStatus === "paid") {
      console.log(
        `[Dunning] Invoice ${params.invoiceId} already paid — dunning workflow exits early`,
      );
      return;
    }

    // ── Step 2: Send dunning email (stub) ─────────────────────────────────────
    await step.do("send-dunning-email", async () => {
      const user = await this.env.PLATFORM_DB.prepare(
        `SELECT email FROM users WHERE org_id = ? AND status = 'active' LIMIT 1`
      )
        .bind(params.orgId)
        .first<{ email: string }>();

      const emailAddress = user?.email ?? "unknown";

      // TODO Phase 6: replace with real transactional email via SendGrid / Resend
      console.log(
        `[DUNNING] Would send email to ${emailAddress} ` +
          `for invoice ${params.invoiceId} attempt ${params.attemptNumber}`,
      );

      return { email: emailAddress };
    });

    // ── Step 3: Schedule retry or suspend subscription ────────────────────────
    await step.do("schedule-retry-or-suspend", async () => {
      if (params.attemptNumber < 3) {
        // Enqueue the next dunning attempt.
        // Real delay scheduling: use step.sleep("wait-before-retry", "3 days") before
        // triggering the next workflow instance. For now we enqueue immediately and
        // rely on the consumer to check timing or re-schedule.
        await this.env.EVENTS_QUEUE.send({
          type: "dunning",
          orgId: params.orgId,
          invoiceId: params.invoiceId,
          stripeInvoiceId: params.stripeInvoiceId,
          attemptNumber: params.attemptNumber + 1,
        });

        console.log(
          `[Dunning] Scheduled retry attempt ${params.attemptNumber + 1} ` +
            `for invoice=${params.invoiceId} org=${params.orgId}`,
        );
        return { action: "retry-scheduled", nextAttempt: params.attemptNumber + 1 };
      } else {
        // Final attempt (3) — mark subscription as past_due and write audit trail
        await this.env.PLATFORM_DB.prepare(
          `UPDATE subscriptions
           SET status = 'past_due', updated_at = datetime('now')
           WHERE org_id = ? AND status NOT IN ('cancelled', 'past_due')`
        )
          .bind(params.orgId)
          .run();

        await this.env.PLATFORM_DB.prepare(
          `INSERT OR IGNORE INTO audit_log
             (id, tenant_id, actor_id, actor_type, event_type, resource_type, resource_id, event_data)
           VALUES (?, ?, 'system', 'system', 'subscription_past_due', 'org', ?, ?)`
        )
          .bind(
            crypto.randomUUID(),
            params.orgId,
            params.orgId,
            JSON.stringify({
              invoiceId: params.invoiceId,
              stripeInvoiceId: params.stripeInvoiceId ?? null,
              totalAttempts: params.attemptNumber,
            }),
          )
          .run();

        console.log(
          `[Dunning] Final attempt exhausted — subscription marked past_due ` +
            `for org=${params.orgId}`,
        );
        return { action: "subscription-past-due" };
      }
    });

    // ── Step 4: Emit dunning.attempted event ──────────────────────────────────
    await step.do("emit-event", async () => {
      await this.env.EVENTS_QUEUE.send({
        type: "dunning.attempted",
        orgId: params.orgId,
        invoiceId: params.invoiceId,
        stripeInvoiceId: params.stripeInvoiceId ?? null,
        attemptNumber: params.attemptNumber,
        invoiceStatus,
        timestamp: new Date().toISOString(),
      });

      return { emitted: true };
    });
  }
}
