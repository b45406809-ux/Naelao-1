import { describe, expect, it, vi } from "vitest";
import {
  assertCustomerBotToolAllowed,
  createCustomerBotContext,
} from "./customer-bot-context.js";

describe("CustomerBotContext quarantine", () => {
  it("physically contains only customer-safe capabilities", () => {
    const context = createCustomerBotContext({
      searchKnowledge: vi.fn(),
      getCannedResponse: vi.fn(),
      getAppointmentAvailability: vi.fn(),
      escalateToHuman: vi.fn(),
    });
    expect(Object.keys(context).sort()).toEqual([
      "cannedResponses",
      "escalateToHuman",
      "executionTier",
      "knowledge",
      "primaryCalendar",
    ]);
    for (const forbidden of [
      "Bash",
      "bash",
      "cli",
      "fs",
      "git",
      "vault",
      "browser",
      "container",
    ]) {
      expect(forbidden in context).toBe(false);
    }
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("rejects unsafe operations and tiers", () => {
    expect(() =>
      assertCustomerBotToolAllowed("knowledge.search", 2)
    ).not.toThrow();
    expect(() => assertCustomerBotToolAllowed("container.exec", 2)).toThrow(
      "customer_bot_capability_denied"
    );
    expect(() => assertCustomerBotToolAllowed("knowledge.search", 3)).toThrow(
      "customer_bot_capability_denied"
    );
  });
});
