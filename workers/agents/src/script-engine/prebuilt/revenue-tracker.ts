/**
 * revenue-tracker — the Whop-native business revenue tracker (go-live monetization pass).
 *
 * Problem: a business whose real sales happen on a platform Naelao never custodies money
 * through (most commonly Whop) has no natural point for the P0-5 wallet-settlement mechanism
 * (settleOrderToWallet) to apply — there is no Naelao checkout, no Naelao webhook, no ledger
 * entry Naelao ever sees. This is the fix: periodically read the business's OWN reported gross
 * revenue (read-only) and store a snapshot the billing worker can bill a builder-configured cut
 * % against (see docs/spec-appendix for the full surcharge design).
 *
 * Deliberately does NOT invent a new credential or connector mechanism — Whop is already
 * reachable through the existing mcp-connector prebuilt exactly as any other connector is
 * (`mcp.register("whop", ..., credential_name: "whop_api_key")` once, then this reads its
 * `list_payments` op). This prebuilt reuses mcp-connector's own hub-request helpers rather than
 * going through a second script.run hop, so the credential-resolution/SSRF-guard/audit-trail
 * machinery mcp-hub already owns is exercised identically to every other connector call.
 *
 * Gross revenue only, never profit — profit/COGS is builder-self-reported and independently
 * unverifiable, so it is deliberately never exposed as a billing basis (see the surcharge design
 * doc for the full reasoning).
 *
 * Whop's exact `list_payments` response shape (field names for amount/status/paid-at) should be
 * verified against current Whop API docs before this handles real production traffic — matching
 * connector-whop's own header comment precedent ("verify against current Whop docs before
 * enabling writes in production") for exactly this kind of live-API assumption. This tries a
 * short list of plausible field names and skips anything it can't confidently parse as cents,
 * rather than guessing and reporting a wrong number.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { hubFetch, resolveServerId } from "./mcp-connector.js";
import { mintInternalToken } from "@naelao/http";

interface WhopPayment {
  status?: string;
  // Plausible amount field names across Whop API versions — cents, integer.
  final_amount?: number;
  amount?: number;
  subtotal?: number;
  // F-26: plausible created/paid timestamp field names — used to keep only payments inside the
  // period being snapshotted. Whop returns either an ISO string or a unix-seconds integer.
  created_at?: string | number;
  paid_at?: string | number;
  settled_at?: string | number;
}

/** Sum only payments that look genuinely completed — skip anything pending/failed/refunded so a
 *  period's revenue reflects money the business actually received, not attempted charges. */
function isCompletedPayment(p: WhopPayment): boolean {
  const status = (p.status ?? "").toLowerCase();
  return status === "" || status === "paid" || status === "completed" || status === "succeeded";
}

function extractAmountCents(p: WhopPayment): number | null {
  const raw = p.final_amount ?? p.amount ?? p.subtotal;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.round(raw);
}

/** F-26: parse a Whop timestamp (ISO string or unix seconds) to epoch millis, or null if absent. */
function extractPaidAtMs(p: WhopPayment): number | null {
  const raw = p.paid_at ?? p.settled_at ?? p.created_at;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000; // secs vs ms
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** F-26: the [start, end) epoch-ms bounds of a "YYYY-MM" period (UTC). */
function periodBounds(period: string): { startMs: number; endMs: number } {
  const [y, m] = period.split("-").map((n) => parseInt(n, 10));
  const startMs = Date.UTC(y!, m! - 1, 1);
  const endMs = Date.UTC(m! === 12 ? y! + 1 : y!, m! === 12 ? 0 : m!, 1);
  return { startMs, endMs };
}

async function fetchWhopRevenueThisPeriod(ctx: PrebuiltOpContext, period: string): Promise<number> {
  const serverId = await resolveServerId(ctx, "whop");
  const { startMs, endMs } = periodBounds(period);
  let totalCents = 0;
  // Bounded pagination — a v1 cap, not a promise of exhaustive historical accuracy. A business
  // with more than this many payments in one month needs a more scalable tracking mechanism than
  // a synchronous prebuilt call; documented limitation, not a silent undercount hazard (partial
  // data would understate revenue, which understates the builder's cut too — the conservative
  // direction if this cap is ever actually hit).
  const MAX_PAGES = 5;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = (await hubFetch(ctx, `/mcp-servers/${serverId}/tools/call`, {
      method: "POST",
      // Matches mcp-connector's mcp.call contract exactly (tool_name/input) — this bypasses that
      // op only to avoid a second script.run hop, not to invent a different hub request shape.
      // F-26: also request a server-side created-at range so the API returns only this period's
      // payments where it supports it (field names per Whop docs may vary — this is best-effort;
      // the client-side window filter below is the AUTHORITATIVE guarantee regardless).
      body: {
        tool_name: "list_payments",
        input: {
          page, per: 100, status: "paid",
          "created_at[gte]": Math.floor(startMs / 1000),
          "created_at[lt]": Math.floor(endMs / 1000),
        },
      },
    })) as { data?: WhopPayment[] } | WhopPayment[];
    const payments = Array.isArray(result) ? result : (result.data ?? []);
    if (payments.length === 0) break;

    for (const p of payments) {
      if (!isCompletedPayment(p)) continue;
      // F-26 (root cause): the previous version summed EVERY completed payment across all time,
      // so each monthly snapshot was the business's all-time revenue — re-billed the cut every
      // month. Only count a payment whose paid/created timestamp falls INSIDE the snapshot period.
      // A payment with no parseable timestamp is skipped (conservative: understates, never
      // over-bills) rather than assumed in-period.
      const paidAtMs = extractPaidAtMs(p);
      if (paidAtMs === null || paidAtMs < startMs || paidAtMs >= endMs) continue;
      const cents = extractAmountCents(p);
      if (cents !== null) totalCents += cents;
    }
    if (payments.length < 100) break; // last page
  }
  return totalCents;
}

async function postSnapshot(ctx: PrebuiltOpContext, period: string, revenueCents: number): Promise<unknown> {
  if (!ctx.env.spacesWorker) throw new Error("revenue-tracker unavailable: spaces worker binding not configured");
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(`http://spaces-worker/spaces/${ctx.env.spaceId}/revenue-tracking`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": token,
      },
      body: JSON.stringify({ period, provider: "whop", revenue_cents: revenueCents }),
    })
  );
  if (!resp.ok) throw new Error(`revenue-tracker: failed to record snapshot (${resp.status})`);
  return resp.json();
}

export const revenueTracker: PrebuiltScript = {
  name: "revenue-tracker",
  description:
    "Track a business's own reported revenue on external platforms (Whop) that Naelao never " +
    "custodies money through, so a builder-configured revenue-cut % can be billed as a surcharge.",
  domain: "commerce",
  requires_tier: 2,
  operations: {
    // revenue.track_whop — pull this calendar month's (or an explicit period's) completed Whop
    // payments and record the snapshot. Read-only against Whop; the only write is the SpaceDO
    // snapshot itself.
    "revenue.track_whop": async (args, ctx) => {
      const period = typeof args["period"] === "string" && /^\d{4}-\d{2}$/.test(args["period"])
        ? (args["period"] as string)
        : new Date().toISOString().slice(0, 7);

      const revenueCents = await fetchWhopRevenueThisPeriod(ctx, period);
      return postSnapshot(ctx, period, revenueCents);
    },
  },
};
