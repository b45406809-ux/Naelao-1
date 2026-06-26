import type { Env } from "./env.js";

export { SpaceProvisioningWorkflow } from "./workflows/SpaceProvisioningWorkflow.js";
export { DataErasureWorkflow } from "./workflows/DataErasureWorkflow.js";
export { KbIngestionWorkflow } from "./workflows/KbIngestionWorkflow.js";
export { DunningWorkflow } from "./workflows/DunningWorkflow.js";
export { QueueHealthWorkflow } from "./workflows/QueueHealthWorkflow.js";
export { queue } from "./queue-consumer.js";

export default {
  queue: (await import("./queue-consumer.js")).queue as ExportedHandlerQueueHandler<Env>,
  scheduled: async (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // G-BE03: Trigger QueueHealthWorkflow on cron schedule (every 30min)
    if (env.QUEUE_HEALTH) {
      ctx.waitUntil(
        env.QUEUE_HEALTH.create({
          params: { triggeredAt: new Date(controller.scheduledTime).toISOString() },
        })
      );
    }
  },
} satisfies ExportedHandler<Env>;
