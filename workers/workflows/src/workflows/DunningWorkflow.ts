/** Durable billing notice workflow for a provider-reported platform-plan payment failure. */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.js";
import { notifyCurrentPaymentFailure, type PlatformDunningEvent, type ProductUserDunningEvent } from "./dunning-recovery.js";

export type DunningParams = (
  | (PlatformDunningEvent & { scope: "platform_subscription" })
  | (ProductUserDunningEvent & { scope: "product_user_subscription" })
) & { workflow_id: string };

export class DunningWorkflow extends WorkflowEntrypoint<Env, DunningParams> {
  async run(event: WorkflowEvent<DunningParams>, step: WorkflowStep): Promise<void> {
    const result = await step.do("notify-current-billing-recipient", async () =>
      notifyCurrentPaymentFailure(this.env, event.payload),
    );
    console.log("billing_dunning_workflow_completed", {
      provider: event.payload.provider,
      notified: result.notified,
      skipped: "skipped" in result ? result.skipped : undefined,
    });
  }
}
