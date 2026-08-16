// conversation.search — the "go and look" half of compaction.
//
// A model told "this conversation is compacted, search rather than guess" is only as good as the
// search. The property that matters most here is the negative one: when something genuinely was
// not discussed, the op must say so plainly, because a vague empty result is exactly what invites
// a model to invent a memory instead.

import { describe, it, expect } from "vitest";
import { conversation, scoreMessage } from "../../workers/agents/src/script-engine/prebuilt/conversation.js";
import type { PrebuiltOpContext } from "../../workers/agents/src/script-engine/prebuilt/index.js";

const search = conversation.operations["conversation.search"]!;

function makeCtx(messages: Array<{ role: string; content: string }>, opts: { failing?: boolean } = {}) {
  const calls: string[] = [];
  const ctx = {
    env: {
      spaceId: "space-1",
      agentId: "agent-1",
      tenantId: "tenant-1",
      platformSecret: "secret",
      scriptsBucket: {} as R2Bucket,
      spacesWorker: {
        async fetch(req: Request) {
          calls.push(new URL(req.url).pathname);
          if (opts.failing) return new Response("nope", { status: 500 });
          return Response.json({ data: messages });
        },
      } as unknown as Fetcher,
    },
    run: async () => ({}),
  } as unknown as PrebuiltOpContext;
  return { ctx, calls };
}

const TRANSCRIPT = [
  { role: "user", content: "I want to sell a course about sourdough baking on Whop." },
  { role: "assistant", content: "Understood. I'll set up a Whop storefront for the sourdough course." },
  { role: "user", content: "Price it at 49 dollars and pay out to my Revolut account." },
  { role: "assistant", content: "Noted: price 49 USD, payouts to Revolut." },
  { role: "user", content: "Also add a discount code called EARLYBIRD." },
];

describe("conversation.search — finds what the summary dropped", () => {
  it("finds an earlier detail and reports where in the conversation it was", async () => {
    const { ctx } = makeCtx(TRANSCRIPT);
    const r = (await search({ query: "Revolut payout", session_id: "sess-1" }, ctx)) as {
      ok: boolean;
      results: Array<{ excerpt: string; position: string; role: string }>;
      searched_messages: number;
    };
    expect(r.ok).toBe(true);
    expect(r.searched_messages).toBe(5);
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]?.excerpt).toContain("Revolut");
    // Position lets the model say "early in the conversation" rather than faking precision.
    expect(r.results[0]?.position).toMatch(/\d+ of 5/);
  });

  it("ranks the most relevant message first", async () => {
    const { ctx } = makeCtx(TRANSCRIPT);
    const r = (await search({ query: "EARLYBIRD discount code", session_id: "sess-1" }, ctx)) as {
      results: Array<{ excerpt: string }>;
    };
    expect(r.results[0]?.excerpt).toContain("EARLYBIRD");
  });

  it("says plainly when something was never discussed", async () => {
    // The whole point: an unambiguous "not here" is what stops a model inventing a memory.
    const { ctx } = makeCtx(TRANSCRIPT);
    const r = (await search({ query: "shipping address warehouse", session_id: "sess-1" }, ctx)) as {
      ok: boolean;
      results: unknown[];
      note?: string;
    };
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(0);
    expect(r.note).toContain("not discussed");
  });

  it("caps how many results it returns", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `sourdough note ${i}` }));
    const { ctx } = makeCtx(many);
    const r = (await search({ query: "sourdough", session_id: "sess-1", limit: 50 }, ctx)) as { results: unknown[] };
    expect(r.results.length).toBeLessThanOrEqual(20);
  });
});

describe("conversation.search — degrades honestly", () => {
  it("requires a query rather than returning arbitrary messages", async () => {
    const { ctx } = makeCtx(TRANSCRIPT);
    await expect(search({ session_id: "sess-1" }, ctx)).rejects.toThrow(/requires 'query'/);
  });

  it("explains what it needs when no session is given", async () => {
    const { ctx, calls } = makeCtx(TRANSCRIPT);
    const r = (await search({ query: "anything" }, ctx)) as { ok: boolean; reason: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("session_id");
    expect(calls).toHaveLength(0);
  });

  it("returns an empty search rather than throwing when the transcript can't be loaded", async () => {
    // A failed lookup must not blow up the run — the agent should be able to say it couldn't
    // check, which is different from saying the thing never happened.
    const { ctx } = makeCtx(TRANSCRIPT, { failing: true });
    const r = (await search({ query: "Revolut", session_id: "sess-1" }, ctx)) as {
      ok: boolean;
      results: unknown[];
      note?: string;
    };
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(0);
    expect(r.note).toContain("No stored messages");
  });
});

describe("conversation.search — scoring", () => {
  it("scores a whole-word match above a substring match", () => {
    const whole = scoreMessage({ role: "user", content: "the invoice is ready" }, ["invoice"]);
    // A plural is a substring hit; note that this is NOT a stemmer — "invoicing" would not match.
    const partial = scoreMessage({ role: "user", content: "all invoices are ready" }, ["invoice"]);
    expect(whole).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(0);
  });

  it("scores an unrelated message at zero", () => {
    expect(scoreMessage({ role: "user", content: "completely unrelated text" }, ["invoice"])).toBe(0);
  });

  it("does not let filler words create false matches", () => {
    // Without stop-word filtering, "what did we say about the thing" would match every message.
    expect(scoreMessage({ role: "user", content: "the a and it was" }, ["the", "and", "was"])).toBe(0);
  });
});

// The op itself is real and well-tested (above) — the actual gap, found while verifying this end
// to end, was that neither Space Assistant profile ever listed "conversation" as a callable
// script, so conversation-context.ts's own pre-compaction notice ("run conversation.search to
// look it up") instructed the model to call something it structurally could not reach.
describe("conversation is reachable by both Space Assistant profiles", () => {
  it("DEFAULT_NAELAO_AGENT lists the conversation script", async () => {
    const { DEFAULT_NAELAO_AGENT } = await import("../../workers/agents/src/script-engine/profiles.js");
    expect(DEFAULT_NAELAO_AGENT.config.scripts.prebuilt).toContain("conversation");
  });

  it("LAUNCHPAD_ASSISTANT_PROFILE lists the conversation script", async () => {
    const { LAUNCHPAD_ASSISTANT_PROFILE } = await import("../../workers/agents/src/script-engine/profiles.js");
    expect(LAUNCHPAD_ASSISTANT_PROFILE.config.scripts.prebuilt).toContain("conversation");
  });

  it("conversation.search is auto-approved under guided mode — a read of the agent's own already-stored transcript", async () => {
    const { LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED } = await import("../../workers/agents/src/script-engine/profiles.js");
    expect(LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED).toContain("conversation.search");
  });
});
