import { assertCustomerBotToolAllowed } from "@naelao/agent-sdk";
import type { PrebuiltScript } from "./index.js";
import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";

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
      const query = typeof args["query"] === "string" ? args["query"].trim() : "";
      if (!query || query.length > 4_096) throw new Error("faq_search_query_invalid");
      const requestedTopK = args["top_k"] === undefined ? 5 : Number(args["top_k"]);
      if (!Number.isSafeInteger(requestedTopK) || requestedTopK < 1) throw new Error("faq_search_limit_invalid");
      const response = await ctx.env.knowledgeWorker.fetch(
        new Request(
          `http://knowledge-worker/spaces/${ctx.env.spaceId}/kb/search?q=${encodeURIComponent(query)}&top_k=${Math.min(8, requestedTopK)}`,
          { headers: await headers(ctx) }
        )
      );
      if (!response.ok) throw new Error(`faq_search_failed:${response.status}`);
      return readBoundedResponseJson(response, 2 * 1024 * 1024);
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
      if (!Object.hasOwn(responses, key))
        throw new Error(`unknown_canned_response:${key}`);
      return { key, response: responses[key] };
    },
    async "customer.appointment_availability"(args, ctx) {
      assertCustomerBotToolAllowed("primary_calendar.availability", 2);
      if (!ctx.env.spacesWorker) throw new Error("calendar_unavailable");
      const startAt = typeof args["start_at"] === "string" ? args["start_at"] : "";
      const endAt = typeof args["end_at"] === "string" ? args["end_at"] : "";
      if (!startAt || !endAt || startAt.length > 64 || endAt.length > 64
        || !Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt)) || Date.parse(startAt) >= Date.parse(endAt))
        throw new Error("calendar_availability_range_invalid");
      const qs = new URLSearchParams({
        space_id: ctx.env.spaceId,
        start_date: startAt,
        end_date: endAt,
      });
      const response = await ctx.env.spacesWorker.fetch(
        new Request(
          `http://spaces-worker/internal/primary-calendar/availability?${qs}`,
          { headers: await headers(ctx) }
        )
      );
      if (!response.ok)
        throw new Error(`calendar_availability_failed:${response.status}`);
      return readBoundedResponseJson(response, 2 * 1024 * 1024);
    },
    async "customer.escalate"(args) {
      assertCustomerBotToolAllowed("human.escalate", 1);
      const reason = typeof args["reason"] === "string" ? args["reason"].trim() : "Customer requested a human";
      if (reason.length > 2_000) throw new Error("customer_escalation_reason_invalid");
      return {
        escalated: true,
        reason: reason || "Customer requested a human",
      };
    },
  },
};
