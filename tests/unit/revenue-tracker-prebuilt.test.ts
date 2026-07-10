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

// F-26: revenue-tracker now keeps only payments whose paid/created timestamp falls inside the
// snapshot period. Tests default their payments to "now" (current calendar month) unless they set
// created_at explicitly; a helper stamps a current-month timestamp on any payment missing one.
type TestPayment = { status?: string; final_amount?: number; amount?: number; subtotal?: number; created_at?: string | number; paid_at?: string | number };
function stampNow(pages: TestPayment[][]): TestPayment[][] {
  const now = new Date().toISOString();
  return pages.map((page) => page.map((p) => (p.created_at === undefined && p.paid_at === undefined ? { ...p, created_at: now } : p)));
}

function makeEnv(opts: {
  servers?: Array<{ id: string; name: string }>;
  paymentPages?: TestPayment[][];
  spacesResponder?: (call: Call) => unknown;
  stampCurrentMonth?: boolean;
}) {
  const { servers = [{ id: "srv-whop", name: "whop" }], paymentPages: rawPages = [[]], spacesResponder, stampCurrentMonth = true } = opts;
  const paymentPages = stampCurrentMonth ? stampNow(rawPages) : rawPages;
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
    const { env, spacesCalls } = makeEnv({ paymentPages: [[{ status: "paid", final_amount: 1000, created_at: "2026-03-15T12:00:00Z" }]] });
    await revenueTracker.operations["revenue.track_whop"]!({ period: "2026-03" }, { env, run: noopRun });
    expect((spacesCalls[0]!.body as { period: string }).period).toBe("2026-03");
    expect((spacesCalls[0]!.body as { revenue_cents: number }).revenue_cents).toBe(1000);
  });

  it("F-26: only counts payments INSIDE the snapshot period, not all-time revenue", async () => {
    const { env, spacesCalls, hubCalls } = makeEnv({
      stampCurrentMonth: false,
      paymentPages: [[
        { status: "paid", final_amount: 1000, created_at: "2026-03-05T00:00:00Z" }, // in period
        { status: "paid", final_amount: 2000, created_at: "2026-03-28T00:00:00Z" }, // in period
        { status: "paid", final_amount: 9999, created_at: "2026-02-27T00:00:00Z" }, // BEFORE period
        { status: "paid", final_amount: 8888, created_at: "2026-04-01T00:00:00Z" }, // AFTER period (exclusive end)
        { status: "paid", final_amount: 7777, created_at: 1740787200 },             // unix secs = 2025-03-01, out
      ]],
    });
    await revenueTracker.operations["revenue.track_whop"]!({ period: "2026-03" }, { env, run: noopRun });
    // Only the two March 2026 payments count.
    expect((spacesCalls[0]!.body as { revenue_cents: number }).revenue_cents).toBe(3000);
    // The request also carries a server-side created-at range for the period.
    const callInput = (hubCalls.find((c) => /tools\/call$/.test(c.url))!.body as { input: Record<string, number> }).input;
    expect(callInput["created_at[gte]"]).toBe(Math.floor(Date.UTC(2026, 2, 1) / 1000));
    expect(callInput["created_at[lt]"]).toBe(Math.floor(Date.UTC(2026, 3, 1) / 1000));
  });

  it("F-26: skips a payment with no parseable timestamp (conservative — understates, never over-bills)", async () => {
    const { env, spacesCalls } = makeEnv({
      stampCurrentMonth: false,
      paymentPages: [[{ status: "paid", final_amount: 5000 }]], // no created_at/paid_at at all
    });
    await revenueTracker.operations["revenue.track_whop"]!({ period: "2026-03" }, { env, run: noopRun });
    expect((spacesCalls[0]!.body as { revenue_cents: number }).revenue_cents).toBe(0);
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
