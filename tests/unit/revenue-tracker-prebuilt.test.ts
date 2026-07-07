import { describe, it, expect } from "vitest";
import { revenueTracker } from "../../workers/agents/src/script-engine/prebuilt/revenue-tracker.js";
import { verifyInternalToken } from "@naelao/http";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// External revenue tracker (go-live monetization pass): reuses the EXISTING mcp-connector
// prebuilt's hub-request helpers (no new credential/connector mechanism) to read a business's own
// Whop payments — a registered "whop" MCP server is a precondition, same as any other connector.
// Gross revenue only (completed payments), a bounded page cap, and honest handling of an
// unrecognized payment shape (skipped, not miscounted).

const PLATFORM_SECRET = "test-platform-secret";

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }

function makeEnv(opts: {
  servers?: Array<{ id: string; name: string }>;
  paymentPages?: Array<{ status?: string; final_amount?: number; amount?: number; subtotal?: number }[]>;
  spacesResponder?: (call: Call) => unknown;
}) {
  const { servers = [{ id: "srv-whop", name: "whop" }], paymentPages = [[]], spacesResponder } = opts;
  const hubCalls: Call[] = [];
  const spacesCalls: Call[] = [];
  let pageIdx = 0;

  const mcpHubWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      const body = await req.clone().json().catch(() => null) as Record<string, unknown> | null;
      hubCalls.push({ method: req.method, url: req.url, headers, body });

      if (req.url.endsWith("/mcp-servers") && req.method === "GET") {
        return Response.json({ data: servers });
      }
      if (/\/mcp-servers\/[^/]+\/tools\/call$/.test(req.url) && req.method === "POST") {
        const params = (body?.["input"] as Record<string, unknown> | undefined) ?? {};
        const page = (params["page"] as number) ?? 1;
        const data = paymentPages[page - 1] ?? [];
        return Response.json({ data });
      }
      return new Response("not found", { status: 404 });
    },
  };

  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      const body = await req.clone().json().catch(() => null);
      const call: Call = { method: req.method, url: req.url, headers, body };
      spacesCalls.push(call);
      return Response.json(spacesResponder ? spacesResponder(call) : { period: (body as { period?: string })?.period, revenue_cents: (body as { revenue_cents?: number })?.revenue_cents, billed: false });
    },
  };

  const env = {
    scriptsBucket: {} as never,
    spaceId: "space-1",
    tenantId: "tenant-1",
    platformSecret: PLATFORM_SECRET,
    mcpHubWorker: mcpHubWorker as unknown as Fetcher,
    spacesWorker: spacesWorker as unknown as Fetcher,
  } as unknown as ScriptEngineEnv;

  return { env, hubCalls, spacesCalls };
}

const noopRun = async () => ({});

describe("revenue-tracker prebuilt — revenue.track_whop", () => {
  it("sums completed payments and posts the snapshot to the current calendar period by default", async () => {
    const { env, spacesCalls } = makeEnv({
      paymentPages: [[{ status: "paid", final_amount: 2000 }, { status: "paid", final_amount: 3000 }]],
    });
    const result = await revenueTracker.operations["revenue.track_whop"]!({}, { env, run: noopRun }) as { revenue_cents?: number };

    expect(spacesCalls).toHaveLength(1);
    expect(spacesCalls[0]!.url).toContain("/spaces/space-1/revenue-tracking");
    const body = spacesCalls[0]!.body as { revenue_cents: number; provider: string; period: string };
    expect(body.revenue_cents).toBe(5000);
    expect(body.provider).toBe("whop");
    expect(body.period).toMatch(/^\d{4}-\d{2}$/);
    expect(await verifyInternalToken(spacesCalls[0]!.headers["x-naelao-internal-token"], "tenant-1", PLATFORM_SECRET)).toBe(true);
    expect(result.revenue_cents).toBe(5000);
  });

  it("uses an explicit period when provided", async () => {
    const { env, spacesCalls } = makeEnv({ paymentPages: [[{ status: "paid", final_amount: 1000 }]] });
    await revenueTracker.operations["revenue.track_whop"]!({ period: "2026-03" }, { env, run: noopRun });
    expect((spacesCalls[0]!.body as { period: string }).period).toBe("2026-03");
  });

  it("skips non-completed payments (pending/failed/refunded)", async () => {
    const { env, spacesCalls } = makeEnv({
      paymentPages: [[
        { status: "paid", final_amount: 1000 },
        { status: "pending", final_amount: 5000 },
        { status: "refunded", final_amount: 9999 },
        { status: "failed", final_amount: 4444 },
      ]],
    });
    await revenueTracker.operations["revenue.track_whop"]!({}, { env, run: noopRun });
    expect((spacesCalls[0]!.body as { revenue_cents: number }).revenue_cents).toBe(1000);
  });

  it("tries plausible amount field names (final_amount, amount, subtotal) and skips an unrecognized shape", async () => {
    const { env, spacesCalls } = makeEnv({
      paymentPages: [[
        { status: "paid", final_amount: 100 },
        { status: "paid", amount: 200 },
        { status: "paid", subtotal: 300 },
        { status: "paid" }, // no recognizable amount field at all — skipped, not counted as 0-changing garbage
      ]],
    });
    await revenueTracker.operations["revenue.track_whop"]!({}, { env, run: noopRun });
    expect((spacesCalls[0]!.body as { revenue_cents: number }).revenue_cents).toBe(600);
  });

  it("paginates until a short page signals the end", async () => {
    const page1 = Array.from({ length: 100 }, () => ({ status: "paid", final_amount: 100 }));
    const page2 = [{ status: "paid", final_amount: 50 }];
    const { env, spacesCalls, hubCalls } = makeEnv({ paymentPages: [page1, page2] });
    await revenueTracker.operations["revenue.track_whop"]!({}, { env, run: noopRun });

    expect((spacesCalls[0]!.body as { revenue_cents: number }).revenue_cents).toBe(100 * 100 + 50);
    // 1 list-servers call + 2 pages of tools/call
    expect(hubCalls.filter((c) => /tools\/call$/.test(c.url))).toHaveLength(2);
  });

  it("stops at the page cap rather than paginating forever against a pathological account", async () => {
    const fullPage = Array.from({ length: 100 }, () => ({ status: "paid", final_amount: 1 }));
    const { env, hubCalls } = makeEnv({ paymentPages: [fullPage, fullPage, fullPage, fullPage, fullPage, fullPage, fullPage] });
    await revenueTracker.operations["revenue.track_whop"]!({}, { env, run: noopRun });
    expect(hubCalls.filter((c) => /tools\/call$/.test(c.url))).toHaveLength(5);
  });

  it("throws a clear error when no 'whop' MCP server is registered for this business", async () => {
    const { env } = makeEnv({ servers: [] });
    await expect(revenueTracker.operations["revenue.track_whop"]!({}, { env, run: noopRun })).rejects.toThrow(/no registered server/i);
  });
});
