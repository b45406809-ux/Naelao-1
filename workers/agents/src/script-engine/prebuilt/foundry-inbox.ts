/** Owner-reviewed feature requests for a worker's current Space. Submission records a request;
 * it never changes code, publishes a template, or creates a worker. */
import type { PrebuiltScript } from "./index.js";
import { mintInternalToken } from "@naelao/http";

const boundedText = (value: unknown, name: string, max: number, required = true): string => {
  if (typeof value !== "string") {
    if (!required && value === undefined) return "";
    throw new Error(`${name} must be text`);
  }
  const text = value.trim();
  if ((required && !text) || text.length > max) throw new Error(`${name} must be non-empty and at most ${max} characters`);
  return text;
};

export const foundryInbox: PrebuiltScript = {
  name: "foundry-inbox",
  description: "Submit a bounded feature request to this Space's owner-reviewed inbox. Requests do not change code or create workers.",
  domain: "knowledge",
  requires_tier: 1,
  paramHints: {
    "foundry.request": "title (required, <=160 chars), problem (required, <=3000), workflow (required, <=3000), evidence (optional string[] of <=10 short references). Creates a request for owner review only.",
  },
  operations: {
    async "foundry.request"(args, ctx) {
      if (!ctx.env.spacesWorker) throw new Error("foundry inbox unavailable: Spaces Worker binding is missing");
      if (!ctx.env.runId || !ctx.env.agentId) throw new Error("foundry request requires an identified agent run");
      const title = boundedText(args["title"], "title", 160);
      const problem = boundedText(args["problem"], "problem", 3000);
      const workflow = boundedText(args["workflow"], "workflow", 3000);
      const evidenceValue = args["evidence"];
      if (evidenceValue !== undefined && (!Array.isArray(evidenceValue) || evidenceValue.length > 10 || evidenceValue.some((item) => typeof item !== "string" || item.trim().length > 300))) {
        throw new Error("evidence must be an array of at most 10 references, each at most 300 characters");
      }
      const actor = { agent_id: ctx.env.agentId, run_id: ctx.env.runId, ...(ctx.env.userId ? { user_id: ctx.env.userId } : {}) };
      const response = await ctx.env.spacesWorker.fetch(new Request(`http://spaces-worker/internal/spaces/${encodeURIComponent(ctx.env.spaceId)}/foundry/requests`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": ctx.env.tenantId,
          "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
          "x-naelao-agent-id": ctx.env.agentId,
          "x-naelao-run-id": ctx.env.runId,
          ...(ctx.env.userId ? { "x-naelao-user-id": ctx.env.userId } : {}),
        },
        body: JSON.stringify({ ...actor, title, problem, workflow, evidence: evidenceValue ?? [] }),
      }));
      if (!response.ok) throw new Error(`foundry request failed: HTTP ${response.status}`);
      return response.json();
    },
  },
};
