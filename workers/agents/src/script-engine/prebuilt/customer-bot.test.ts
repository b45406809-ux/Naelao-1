import { describe, expect, it } from "vitest";
import { customerBot } from "./customer-bot.js";

function context(fetch: (request: Request) => Promise<Response> = async () => Response.json({ ok: true })) {
  const requests: Request[] = [];
  return {
    requests,
    ctx: {
      env: {
        tenantId: "tenant-a", spaceId: "space-a", platformSecret: "secret",
        knowledgeWorker: { fetch: async (request: Request) => { requests.push(request); return fetch(request); } },
        spacesWorker: { fetch: async (request: Request) => { requests.push(request); return fetch(request); } },
      },
      run: async () => undefined,
    } as never,
  };
}

describe("customer bot bounded operations", () => {
  it("sends calendar parameters using the SpaceDO endpoint contract", async () => {
    const state = context();
    await customerBot.operations["customer.appointment_availability"]!({ start_at: "2026-11-01T09:00:00Z", end_at: "2026-11-01T10:00:00Z" }, state.ctx);
    const url = new URL(state.requests[0]!.url);
    expect(url.pathname).toBe("/internal/primary-calendar/availability");
    expect(url.searchParams.get("start_date")).toBe("2026-11-01T09:00:00Z");
    expect(url.searchParams.get("end_date")).toBe("2026-11-01T10:00:00Z");
    expect(url.searchParams.has("start_at")).toBe(false);
  });

  it("validates the calendar range before calling the service", async () => {
    const state = context();
    await expect(customerBot.operations["customer.appointment_availability"]!({ start_at: "bad", end_at: "2026-11-01" }, state.ctx))
      .rejects.toThrow("calendar_availability_range_invalid");
    await expect(customerBot.operations["customer.appointment_availability"]!({ start_at: "2026-11-02", end_at: "2026-11-01" }, state.ctx))
      .rejects.toThrow("calendar_availability_range_invalid");
    expect(state.requests).toHaveLength(0);
  });

  it("bounds FAQ search requests and rejects invalid limits", async () => {
    const state = context();
    await customerBot.operations["customer.faq_search"]!({ query: "  refund policy  ", top_k: 20 }, state.ctx);
    const url = new URL(state.requests[0]!.url);
    expect(url.searchParams.get("q")).toBe("refund policy");
    expect(url.searchParams.get("top_k")).toBe("8");
    await expect(customerBot.operations["customer.faq_search"]!({ query: "x".repeat(4_097) }, state.ctx))
      .rejects.toThrow("faq_search_query_invalid");
    await expect(customerBot.operations["customer.faq_search"]!({ query: "hello", top_k: -1 }, state.ctx))
      .rejects.toThrow("faq_search_limit_invalid");
    expect(state.requests).toHaveLength(1);
  });

  it("does not expose inherited canned-response keys and caps escalation notes", async () => {
    await expect(customerBot.operations["customer.canned_response"]!({ key: "toString" }, context().ctx))
      .rejects.toThrow("unknown_canned_response");
    const state = context();
    await expect(customerBot.operations["customer.escalate"]!({ reason: "x".repeat(2_001) }, state.ctx))
      .rejects.toThrow("customer_escalation_reason_invalid");
    expect(await customerBot.operations["customer.escalate"]!({ reason: "  need help  " }, state.ctx))
      .toEqual({ escalated: true, reason: "need help" });
  });
});
