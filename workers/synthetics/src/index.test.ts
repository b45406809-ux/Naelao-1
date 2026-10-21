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
  it("records a failed probe once per outage while tolerating telemetry outages", async () => {
    const inserted: unknown[][] = [];
    const failureEvents: unknown[][] = [];
    const failureIds = new Set<string>();
    const states = new Map<string, { failure: number; updated: string }>();
    const env = {
      PLATFORM_API_URL: "https://api.example.test",
      PLATFORM_DB: {
        prepare: (sql: string) => ({
          run: async () => {},
          bind: (...values: unknown[]) => ({
            run: async () => {
              if (sql.includes("INSERT INTO synthetic_results")) inserted.push(values);
              if (sql.includes("INSERT OR IGNORE INTO platform_failures") && !failureIds.has(String(values[0]))) {
                failureIds.add(String(values[0]));
                failureEvents.push(values);
              }
            },
            first: async () => {
              if (sql.includes("INSERT INTO synthetic_check_state")) {
                const [name, failure, updated] = values as [string, number, string];
                const previous = states.get(name);
                if (!previous || previous.failure !== failure) states.set(name, { failure, updated: `${updated}:${states.size}:${failureEvents.length}` });
                return !previous || previous.failure !== failure ? { failure_active: failure } : null;
              }
              if (sql.includes("SELECT updated_at FROM synthetic_check_state")) {
                const state = states.get(String(values[0]));
                return state?.failure === 1 ? { updated_at: state.updated } : null;
              }
              return null;
            },
          }),
        }),
      } as never,
      ANALYTICS: {
        writeDataPoint: () => {
          throw new Error("analytics unavailable");
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
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]?.[1]).toContain('"check_name":"platform_dependencies"');
    expect(failureEvents[0]?.[0]).toContain("synthetic:platform_dependencies:");

    await runSyntheticCycle(env, async (input) => String(input).endsWith("/health")
      ? new Response("ok", { status: 200 })
      : new Response("still unavailable", { status: 503 }));
    expect(failureEvents).toHaveLength(1);

    await runSyntheticCycle(env, async () => new Response("ok", { status: 200 }));
    await runSyntheticCycle(env, async (input) => String(input).endsWith("/health")
      ? new Response("ok", { status: 200 })
      : new Response("unavailable", { status: 503 }));
    expect(failureEvents).toHaveLength(2);
  });

  it("bounds network errors before recording operator failure details", async () => {
    const failureEvents: unknown[][] = [];
    const failureIds = new Set<string>();
    const states = new Map<string, { failure: number; updated: string }>();
    const env = {
      PLATFORM_API_URL: "https://api.example.test",
      PLATFORM_DB: {
        prepare: (sql: string) => ({ run: async () => {}, bind: (...values: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT OR IGNORE INTO platform_failures") && !failureIds.has(String(values[0]))) {
              failureIds.add(String(values[0]));
              failureEvents.push(values);
            }
          },
          first: async () => {
            if (sql.includes("INSERT INTO synthetic_check_state")) {
              const name = String(values[0]);
              const failure = Number(values[1]);
              const updated = String(values[2]);
              const previous = states.get(name);
              if (!previous || previous.failure !== failure) states.set(name, { failure, updated: `${updated}:${states.size}:${failureEvents.length}` });
              return !previous || previous.failure !== failure ? { failure_active: failure } : null;
            }
            if (sql.includes("SELECT updated_at FROM synthetic_check_state")) {
              const state = states.get(String(values[0]));
              return state?.failure === 1 ? { updated_at: state.updated } : null;
            }
            return null;
          },
        }) }),
      } as never,
    } as unknown as Parameters<typeof runSyntheticCycle>[0];
    const results = await runSyntheticCycle(env, async () => { throw new Error(`<script>${"x".repeat(1000)}`); });
    expect(results.every((result) => result.error?.length === 500)).toBe(true);
    expect(failureEvents).toHaveLength(2);
    const payload = JSON.parse(String(failureEvents[0]?.[1])) as { error: string };
    expect(payload.error.length).toBe(500);
    expect(String(failureEvents[0]?.[2]).length).toBeLessThan(600);
  });

  it("keeps failed probe results when D1 is unavailable", async () => {
    const env = {
      PLATFORM_API_URL: "https://api.example.test",
      PLATFORM_DB: {
        prepare: () => ({
          run: async () => { throw new Error("D1 unavailable"); },
          bind: () => ({
            run: async () => {
              throw new Error("D1 unavailable");
            },
            first: async () => { throw new Error("D1 unavailable"); },
          }),
        }),
      } as never,
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
