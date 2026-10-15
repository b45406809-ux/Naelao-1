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
    expect(() => assertCustomerBotToolAllowed("knowledge.search", 0)).toThrow(
      "customer_bot_capability_denied"
    );
  });

  it("allows task-scoped attachment reading but never project-shared attachment copying", () => {
    expect(() => assertCustomerBotToolAllowed("attachment.list", 1)).not.toThrow();
    expect(() => assertCustomerBotToolAllowed("attachment.read", 2)).not.toThrow();
    expect(() => assertCustomerBotToolAllowed("attachment.ocr", 2)).not.toThrow();
    expect(() => assertCustomerBotToolAllowed("attachment.describe", 2)).not.toThrow();
    expect(() => assertCustomerBotToolAllowed("attachment.copy", 1)).toThrow("customer_bot_capability_denied");
  });
});
