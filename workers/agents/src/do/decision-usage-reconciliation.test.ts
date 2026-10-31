import { describe, expect, it, vi } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

describe("durable OpenRouter decision usage reconciliation", () => {
  it("recovers a committed bill after a lost acknowledgement across a Durable Object restart", async () => {
    const now = Date.now();
    const reservationId = "run-1:decision:stable-hash";
    const key = `decision-reservation:${reservationId}`;
    const kv = new Map<string, unknown>([[key, {
      status: "reconciling", model: "cloudflare/clef-flash", inputPrice: 0.000001, outputPrice: 0.000001,
      priceSnapshotAt: new Date(now - 1000).toISOString(), reservationId, runId: "run-1", spaceId: "space-1",
      projectId: "project-1", tenantId: "tenant-1", maxCredits: 100, maxTokens: 500, reservedAt: now - 5000,
      providerGenerationId: "gen-dec-abc", nextReconcileAt: 0,
    }]]);
    const sqlStorage = createDOStorage();
    const storage = {
      ...sqlStorage,
      get: async (storageKey: string) => kv.get(storageKey),
      put: async (storageKey: string, value: unknown) => { kv.set(storageKey, value); },
      list: async ({ prefix, limit = 1000 }: { prefix?: string; limit?: number }) => new Map([...kv.entries()].filter(([storageKey]) => storageKey.startsWith(prefix ?? "")).slice(0, limit)),
    };
    let remoteStatus = "held";
    let billingSettlements = 0;
    const billing = { fetch: vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/status")) return Response.json({ status: remoteStatus, ...(remoteStatus === "settled" ? { generation_id: "gen-dec-abc", cost_credits: 3 } : {}), max_tokens: 500, max_credits: 100, created_at: new Date(now - 5000).toISOString() });
      if (path.endsWith("/settle")) {
        billingSettlements++;
        remoteStatus = "settled"; // D1 transaction committed before its response was lost.
        return new Response("acknowledgement lost", { status: 503 });
      }
      throw new Error(`unexpected_billing_route:${path}`);
    }) };
    let projectSettleCalls = 0;
    const spaces = { fetch: vi.fn(async (request: Request) => {
      const body = await request.json() as { action?: string; credits?: number; reservation_id?: string };
      if (body.action === "settle_reservation") {
        projectSettleCalls++;
        expect(body).toMatchObject({ credits: 3, reservation_id: reservationId });
      }
      return Response.json({ settled: true });
    }) };
    const openRouterFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("id")).toBe("gen-dec-abc");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-openrouter-key");
      return Response.json({ data: { id: "gen-dec-abc", model: "cloudflare/clef-flash", tokens_prompt: 300, tokens_completion: 20, total_cost: 0.0003, created_at: new Date(now).toISOString() } });
    });
    vi.stubGlobal("fetch", openRouterFetch);
    const createAgent = () => new NaelaoAgentDO({ storage, id: { toString: () => "agent-do" } } as never, {
      PLATFORM_SECRET: "test-platform-secret", OPENROUTER_API_KEY: "test-openrouter-key", BILLING_WORKER: billing, SPACES_WORKER: spaces,
    } as never);
    try {
      // First process validates provider usage and submits the settlement. D1 commits, but the
      // service acknowledgement is lost, so the host retains its durable reconciliation row.
      await (createAgent() as unknown as { reconcileDecisionReservations(): Promise<void> }).reconcileDecisionReservations();
      expect(remoteStatus).toBe("settled");
      expect(kv.get(key)).toMatchObject({ status: "uncertain", providerGenerationId: "gen-dec-abc" });
      expect(projectSettleCalls).toBe(0);

      // A fresh DO instance recovers the committed D1 receipt, settles project spend once,
      // and persists completion without querying or charging OpenRouter again.
      await (createAgent() as unknown as { reconcileDecisionReservations(): Promise<void> }).reconcileDecisionReservations();
      expect(kv.get(key)).toMatchObject({ status: "settled", providerGenerationId: "gen-dec-abc", credits: 3 });
      expect(billingSettlements).toBe(1);
      expect(projectSettleCalls).toBe(1);
      expect(openRouterFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
