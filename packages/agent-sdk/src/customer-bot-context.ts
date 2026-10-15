import type { CustomerBotContext, CustomerBotServices } from "./types.js";

/**
 * Construct the complete capability object passed to an untrusted customer bot.
 *
 * This is deliberately an allow-list projection, not a redacted RuntimeContext.  Consequently
 * privileged capabilities cannot be recovered with property traversal, destructuring, or prompt
 * injection: they were never captured by this object in the first place.
 */
export function createCustomerBotContext(
  services: CustomerBotServices
): CustomerBotContext {
  const context: CustomerBotContext = {
    executionTier: 2,
    knowledge: Object.freeze({ search: services.searchKnowledge }),
    cannedResponses: Object.freeze({ get: services.getCannedResponse }),
    primaryCalendar: Object.freeze({
      availability: services.getAppointmentAvailability,
    }),
    escalateToHuman: services.escalateToHuman,
  };
  return Object.freeze(context);
}

/** Defense-in-depth at the execution boundary, independent of model instructions. */
export function assertCustomerBotToolAllowed(
  toolName: string,
  requestedTier = 1
): void {
  const allowed = new Set([
    "knowledge.search",
    "canned_response.get",
    "primary_calendar.availability",
    "human.escalate",
    "attachment.list",
    "attachment.inspect",
    "attachment.read",
    "attachment.ocr",
  ]);
  if (!Number.isInteger(requestedTier) || requestedTier < 1 || requestedTier > 2 || !allowed.has(toolName)) {
    throw new Error(`customer_bot_capability_denied:${toolName}`);
  }
}
