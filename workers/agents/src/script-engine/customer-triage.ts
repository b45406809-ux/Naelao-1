import {
  deterministicChoice,
  deterministicNoul,
  type ChoiceDecision,
  type FastDecisionGateway,
  type NoulDecision,
} from "@naelao/agent-sdk";

export type CustomerMessageCategory = "billing" | "sales" | "support" | "cancellation" | "other";

export interface CustomerMessageTriage {
  category: CustomerMessageCategory;
  urgent: boolean;
  categoryDecision: ChoiceDecision<CustomerMessageCategory>;
  urgencyDecision: NoulDecision;
}

function deterministicTriage(message: string): CustomerMessageTriage {
  const category: CustomerMessageCategory = /\b(refund|invoice|bill(?:ed|ing)?|charge|payment)\b/i.test(message)
    ? "billing"
    : /\b(cancel|unsubscribe|close (?:my|the) account)\b/i.test(message)
      ? "cancellation"
      : /\b(price|pricing|quote|buy|purchase|demo)\b/i.test(message)
        ? "sales"
        : /\b(error|broken|bug|issue|help|support|cannot|can't|failed?)\b/i.test(message)
          ? "support"
          : "other";
  const urgent = /\b(urgent|asap|immediately|emergency|outage|down|today|deadline)\b/i.test(message);
  return {
    category,
    urgent,
    categoryDecision: deterministicChoice(category, "customer_triage_keywords_v1"),
    urgencyDecision: deterministicNoul(urgent, "customer_urgency_keywords_v1"),
  };
}

/** OpenRouter decision triage with an explicit deterministic fallback. Moderation remains a separate gate. */
export async function triageCustomerMessage(
  message: string,
  sentry?: Pick<FastDecisionGateway, "choice" | "noul">
): Promise<CustomerMessageTriage> {
  const fallback = deterministicTriage(message);
  if (!sentry) return fallback;
  try {
    const [categoryDecision, urgencyDecision] = await Promise.all([
      sentry.choice<CustomerMessageCategory>({
        state: { message },
        instructions: "Which business queue should handle this customer message?",
        criteria: {
          billing: "Payments, charges, invoices, refunds, or account credit.",
          sales: "Pricing, quotes, demos, upgrades, or purchase intent.",
          support: "Product usage, bugs, outages, access, or technical help.",
          cancellation: "Cancellation, unsubscribe, account closure, or retention request.",
          other: "A message that does not fit the other queues.",
        },
        policyCode: "customer_triage_v1",
      }),
      sentry.noul({
        state: { message },
        instructions: "Does this customer message need prompt human attention because it is time-sensitive, high-impact, or describes an active outage or emergency?",
        criteria: {
          true: "Explicit urgency, material customer harm, active outage, imminent deadline, or emergency.",
          false: "Routine request that can follow the normal queue.",
        },
        policyCode: "customer_urgency_v1",
        threshold: 0.7,
      }),
    ]);
    return { category: categoryDecision.value, urgent: urgencyDecision.value, categoryDecision, urgencyDecision };
  } catch {
    return fallback;
  }
}
