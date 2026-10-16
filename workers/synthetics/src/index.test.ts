import { describe, expect, it } from "vitest";
import { buildSyntheticChecks, runSyntheticCycle } from "./index";

describe("synthetic check targets", () => {
  it("uses distinct router and backend dependency probes", () => {
    const checks = buildSyntheticChecks("https://api.example.test/");
    expect(checks).toEqual([
      { name: "router_health", url: "https://api.example.test/health" },
      {
        name: "platform_dependencies",
        url: "https://api.example.test/health/dependencies",
      },
    ]);
    expect(new Set(checks.map((check) => check.url)).size).toBe(checks.length);
  });
});

describe("synthetic monitoring cycle", () => {
  it("records and alerts on a failed dependency probe while tolerating telemetry outages", async () => {
    const inserted: unknown[][] = [];
    const alerts: unknown[] = [];
    const env = {
      PLATFORM_API_URL: "https://api.example.test",
      PLATFORM_DB: {
        prepare: () => ({
          bind: (...values: unknown[]) => ({
            run: async () => {
              inserted.push(values);
            },
          }),
        }),
      } as never,
      ANALYTICS: {
        writeDataPoint: () => {
          throw new Error("analytics unavailable");
        },
      },
      NOTIFICATIONS_QUEUE: {
        send: async (message: unknown) => {
          alerts.push(message);
        },
      },
    } as unknown as Parameters<typeof runSyntheticCycle>[0];
    const results = await runSyntheticCycle(env, async (input) => {
      const url = String(input);
      return url.endsWith("/health")
        ? new Response("ok", { status: 200 })
        : new Response("unavailable", { status: 503 });
    });

    expect(results.map(({ success, status }) => ({ success, status }))).toEqual(
      [
        { success: true, status: 200 },
        { success: false, status: 503 },
      ]
    );
    expect(inserted).toHaveLength(2);
    expect(inserted[1]?.[1]).toBe("platform_dependencies");
    expect(inserted[1]?.[5]).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      subject: "Synthetic check failed: platform_dependencies",
    });
  });

  it("keeps a failed result when the result database and alert queue are unavailable", async () => {
    const env = {
      PLATFORM_API_URL: "https://api.example.test",
      PLATFORM_DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              throw new Error("D1 unavailable");
            },
          }),
        }),
      } as never,
      NOTIFICATIONS_QUEUE: {
        send: async () => {
          throw new Error("queue unavailable");
        },
      },
    } as unknown as Parameters<typeof runSyntheticCycle>[0];
    const results = await runSyntheticCycle(env, async () => {
      throw new Error("network unavailable");
    });
    expect(results).toHaveLength(2);
    expect(
      results.every((result) => !result.success && result.status === 0)
    ).toBe(true);
    expect(
      results.every((result) => result.error === "network unavailable")
    ).toBe(true);
  });
});
