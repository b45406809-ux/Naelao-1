import { assertCustomerBotToolAllowed } from "@naelao/agent-sdk";
import type { PrebuiltScript } from "./index.js";
import { mintInternalToken } from "@naelao/http";

async function headers(
  ctx: Parameters<NonNullable<PrebuiltScript["operations"][string]>>[1]
) {
  return {
    "x-naelao-tenant-id": ctx.env.tenantId,
    "x-naelao-internal-token": await mintInternalToken(
      ctx.env.platformSecret ?? "",
      ctx.env.tenantId
    ),
  };
}

/** Public-customer operations only. No generic script runner, filesystem, browser or vault. */
export const customerBot: PrebuiltScript = {
  name: "customer-bot",
  description:
    "Quarantined FAQ, canned-response, appointment availability and human escalation tools.",
  domain: "knowledge",
  requires_tier: 2,
  operations: {
    async "customer.faq_search"(args, ctx) {
      assertCustomerBotToolAllowed("knowledge.search", 2);
      if (!ctx.env.knowledgeWorker) throw new Error("knowledge_unavailable");
      const query = String(args["query"] ?? "");
      const response = await ctx.env.knowledgeWorker.fetch(
        new Request(
          `http://knowledge-worker/spaces/${ctx.env.spaceId}/kb/search?q=${encodeURIComponent(query)}&top_k=${Math.min(8, Number(args["top_k"] ?? 5))}`,
          { headers: await headers(ctx) }
        )
      );
      if (!response.ok) throw new Error(`faq_search_failed:${response.status}`);
      return response.json();
    },
    async "customer.canned_response"(args) {
      assertCustomerBotToolAllowed("canned_response.get", 1);
      const responses: Record<string, string> = {
        greeting: "Hello! How can I help you today?",
        human_handoff:
          "I've asked a member of the team to take over this conversation.",
        unavailable:
          "I don't have a verified answer for that yet, so I've asked a human to help.",
      };
      const key = String(args["key"] ?? "");
      if (!(key in responses))
        throw new Error(`unknown_canned_response:${key}`);
      return { key, response: responses[key] };
    },
    async "customer.appointment_availability"(args, ctx) {
      assertCustomerBotToolAllowed("primary_calendar.availability", 2);
      if (!ctx.env.spacesWorker) throw new Error("calendar_unavailable");
      const qs = new URLSearchParams({
        space_id: ctx.env.spaceId,
        start_at: String(args["start_at"] ?? ""),
        end_at: String(args["end_at"] ?? ""),
      });
      const response = await ctx.env.spacesWorker.fetch(
        new Request(
          `http://spaces-worker/internal/primary-calendar/availability?${qs}`,
          { headers: await headers(ctx) }
        )
      );
      if (!response.ok)
        throw new Error(`calendar_availability_failed:${response.status}`);
      return response.json();
    },
    async "customer.escalate"(args) {
      assertCustomerBotToolAllowed("human.escalate", 1);
      return {
        escalated: true,
        reason: String(args["reason"] ?? "Customer requested a human"),
      };
    },
  },
};
