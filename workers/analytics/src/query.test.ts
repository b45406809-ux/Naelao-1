import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuntimeEconomicsMetrics } from "./query.js";

describe("runtime economics metrics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps the private agent-event aggregate without inventing cost or margin", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain("FROM naelao_agent_events");
      expect(String(init?.body)).toContain("blob1 = 'tool.execution'");
      expect(String(init?.body)).toContain("INTERVAL 30 DAY");
      return new Response(JSON.stringify({
        data: [{
          sample_count: "100",
          tier_1: "55",
          tier_2: "40",
          tier_3: "1",
          tier_4: "1",
          tier_5: "1",
          tier_6: "2",
          tier_1_2_share: "0.95",
          tier_6_share: "0.02",
          success_rate: "0.98",
          average_duration_ms: "12.5",
          p50_duration_ms: "3",
          p95_duration_ms: "48",
          tier_1_2_p95_duration_ms: "4.2",
          total_tokens: "321",
        }],
        meta: [], rows: 1,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRuntimeEconomicsMetrics("account", "token", 30)).resolves.toEqual({
      periodDays: 30,
      sampleCount: 100,
      tierCounts: { "1": 55, "2": 40, "3": 1, "4": 1, "5": 1, "6": 2 },
      tierOneTwoShare: 0.95,
      tierSixShare: 0.02,
      successRate: 0.98,
      averageDurationMs: 12.5,
      p50DurationMs: 3,
      p95DurationMs: 48,
      tierOneTwoP95DurationMs: 4.2,
      totalTokens: 321,
    });
  });

  it("rejects an oversized Analytics Engine response from its declared byte length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(4 * 1024 * 1024 + 1) },
    })));
    await expect(getRuntimeEconomicsMetrics("account", "token", 30)).rejects.toThrow("response_too_large");
  });
});
