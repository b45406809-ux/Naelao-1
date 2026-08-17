import { describe, it, expect, vi } from "vitest";
import { approvals } from "../../workers/agents/src/script-engine/prebuilt/approvals.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// Phase 6: lets the Space Assistant see and act on ANOTHER agent's pending approvals, not just
// its own. Drives the real ops against a fake Fetcher that only answers the REAL routes
// (GET/PUT .../sessions/inbox/approvals[/...]) — the exact ones apps/shell's own Approvals inbox
// page calls — so a wrong path/method fails loudly here the same way it would in production.

function fakeAgentsWorker(): { fetcher: Fetcher; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetcher: Fetcher = {
    fetch: async (input: RequestInfo) => {
      const req = input as Request;
      const url = new URL(req.url);
      const body = req.method !== "GET" ? await req.clone().json().catch(() => undefined) : undefined;
      calls.push({ method: req.method, path: url.pathname, body });
      if (req.method === "GET" && url.pathname === "/spaces/space1/sessions/inbox/approvals") {
        return Response.json({
          approvals: [{ id: "appr-1", action_name: "commerce.payout", status: "pending" }],
        });
      }
      if (req.method === "PUT" && url.pathname === "/spaces/space1/sessions/inbox/approvals/appr-1/approve") {
        return Response.json({ approved: true });
      }
      if (req.method === "PUT" && url.pathname === "/spaces/space1/sessions/inbox/approvals/appr-1/reject") {
        return Response.json({ approved: false, reason: (body as { reason?: string })?.reason ?? null });
      }
      // Any other path — including a hand-guessed wrong one — 404s, exactly like the real worker.
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function ctxWith(agentsWorker: Fetcher) {
  const env = {
    spaceId: "space1",
    agentId: "agent1",
    tenantId: "tenant1",
    platformSecret: "test-secret",
    scriptsBucket: {} as R2Bucket,
    agentsWorker,
  } as ScriptEngineEnv;
  return { env, run: vi.fn() };
}

describe("approvals prebuilt — real route contract", () => {
  it("approvals.list hits the real inbox route and returns the pending list", async () => {
    const { fetcher, calls } = fakeAgentsWorker();
    const res = (await approvals.operations["approvals.list"]!({}, ctxWith(fetcher))) as { pending: unknown[]; count: number };
    expect(res.count).toBe(1);
    expect(res.pending).toEqual([{ id: "appr-1", action_name: "commerce.payout", status: "pending" }]);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/spaces/space1/sessions/inbox/approvals" });
  });

  it("approvals.approve PUTs the real approve route for the named id", async () => {
    const { fetcher, calls } = fakeAgentsWorker();
    const res = (await approvals.operations["approvals.approve"]!({ approval_id: "appr-1" }, ctxWith(fetcher))) as { approved: boolean };
    expect(res.approved).toBe(true);
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/spaces/space1/sessions/inbox/approvals/appr-1/approve" });
  });

  it("approvals.decline PUTs the real reject route, carrying an optional reason", async () => {
    const { fetcher, calls } = fakeAgentsWorker();
    const res = (await approvals.operations["approvals.decline"]!({ approval_id: "appr-1", reason: "not this month" }, ctxWith(fetcher))) as {
      approved: boolean;
      reason: string | null;
    };
    expect(res.approved).toBe(false);
    expect(res.reason).toBe("not this month");
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/spaces/space1/sessions/inbox/approvals/appr-1/reject", body: { reason: "not this month" } });
  });

  it("approvals.decline works with no reason at all", async () => {
    const { fetcher, calls } = fakeAgentsWorker();
    await approvals.operations["approvals.decline"]!({ approval_id: "appr-1" }, ctxWith(fetcher));
    expect(calls[0]).toMatchObject({ body: {} });
  });

  it("approvals.approve requires approval_id — throws rather than calling a malformed URL", async () => {
    const { fetcher, calls } = fakeAgentsWorker();
    await expect(approvals.operations["approvals.approve"]!({}, ctxWith(fetcher))).rejects.toThrow(/approval_id/);
    expect(calls.length).toBe(0);
  });

  it("degrades honestly when the agents-worker binding is missing", async () => {
    const env = { spaceId: "space1", tenantId: "tenant1" } as ScriptEngineEnv; // no agentsWorker
    await expect(approvals.operations["approvals.list"]!({}, { env, run: vi.fn() })).rejects.toThrow(/binding not configured/);
  });
});
