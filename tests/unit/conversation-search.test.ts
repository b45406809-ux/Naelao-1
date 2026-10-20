// conversation.search — the "go and look" half of compaction.
//
// A model told "this conversation is compacted, search rather than guess" is only as good as the
// search. The property that matters most here is the negative one: when something genuinely was
// not discussed, the op must say so plainly, because a vague empty result is exactly what invites
// a model to invent a memory instead.

import { describe, expect, it } from "vitest";
import { conversation, scoreMessage } from "../../workers/agents/src/script-engine/prebuilt/conversation.js";
import type { PrebuiltOpContext } from "../../workers/agents/src/script-engine/prebuilt/index.js";

const search = conversation.operations["conversation.search"]!;

function makeCtx(messages: Array<{ role: string; content: string }>, opts: { failing?: boolean; noSession?: boolean } = {}) {
  const calls: string[] = [];
  const stored = messages.map((message, i) => ({ ...message, id: `m-${i}` }));
  const ctx = {
    env: {
      spaceId: "space-1",
      agentId: "agent-1",
      tenantId: "tenant-1",
      platformSecret: "secret",
      scriptsBucket: {} as R2Bucket,
      ...(!opts.noSession ? { currentSessionId: "sess-1" } : {}),
      spacesWorker: {
        async fetch(req: Request) {
          const url = new URL(req.url);
          calls.push(`${url.pathname}${url.search}`);
          if (opts.failing) return new Response("nope", { status: 500 });
          const beforeId = url.searchParams.get("before_id");
          const cursor = beforeId ? stored.findIndex((message) => message.id === beforeId) : stored.length;
          const limit = Number(url.searchParams.get("limit") ?? 50);
          return Response.json({ data: stored.slice(Math.max(0, cursor - limit), cursor) });
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

  it("clamps negative and non-finite result limits to a valid small range", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ role: "user", content: `sourdough note ${i}` }));
    const { ctx } = makeCtx(many);
    const negative = (await search({ query: "sourdough", session_id: "sess-1", limit: -3 }, ctx)) as { results: unknown[] };
    expect(negative.results).toHaveLength(1);
    const invalid = (await search({ query: "sourdough", session_id: "sess-1", limit: "NaN" }, ctx)) as { results: unknown[] };
    expect(invalid.results).toHaveLength(5);
  });

  it("pages through older transcript messages instead of silently searching only the newest 50", async () => {
    const many = Array.from({ length: 126 }, (_, i) => ({ role: "user", content: `ordinary note ${i}` }));
    many[3] = { role: "user", content: "The original launch phrase was blue lantern." };
    const { ctx, calls } = makeCtx(many);
    const r = (await search({ query: "blue lantern", session_id: "sess-1" }, ctx)) as {
      searched_messages: number;
      results: Array<{ position: string; excerpt: string }>;
    };
    expect(r.searched_messages).toBe(126);
    expect(r.results[0]?.excerpt).toContain("blue lantern");
    expect(r.results[0]?.position).toBe("4 of 126");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("before_id=m-26");
  });

  it("does not claim a miss is conclusive after reaching its transcript safety bound", async () => {
    const many = Array.from({ length: 10_050 }, (_, i) => ({ role: "user", content: `routine update ${i}` }));
    const { ctx } = makeCtx(many);
    const r = (await search({ query: "unmentioned phrase", session_id: "sess-1" }, ctx)) as {
      searched_messages: number;
      results: unknown[];
      note?: string;
    };
    expect(r.searched_messages).toBe(10_000);
    expect(r.results).toHaveLength(0);
    expect(r.note).toContain("Search older history by passing before_id");
  });

  it("supports bounded scans with an explicit older-page cursor", async () => {
    const many = Array.from({ length: 126 }, (_, i) => ({ role: "user", content: `ordinary note ${i}` }));
    many[3] = { role: "user", content: "The original launch phrase was blue lantern." };
    const { ctx } = makeCtx(many);
    const page1 = await search({ query: "blue lantern", session_id: "sess-1", scan_limit: 50 }, ctx) as { results: unknown[]; next_cursor?: string; exhausted: boolean };
    expect(page1.results).toHaveLength(0);
    expect(page1.next_cursor).toBe("m-76");
    expect(page1.exhausted).toBe(false);
    const page2 = await search({ query: "blue lantern", session_id: "sess-1", scan_limit: 50, before_id: page1.next_cursor }, ctx) as { results: unknown[]; next_cursor?: string };
    expect(page2.results).toHaveLength(0);
    expect(page2.next_cursor).toBe("m-26");
    const page3 = await search({ query: "blue lantern", session_id: "sess-1", before_id: page2.next_cursor }, ctx) as { results: Array<{ excerpt: string }>; exhausted: boolean };
    expect(page3.results[0]?.excerpt).toContain("blue lantern");
    expect(page3.exhausted).toBe(true);
  });

  it("chains selected excerpts through document processing and preserves source message ids", async () => {
    const { ctx } = makeCtx(TRANSCRIPT);
    const nested: Array<{ name: string; params: Record<string, unknown> }> = [];
    (ctx as unknown as { run: typeof ctx.run }).run = async (name, params) => {
      nested.push({ name, params });
      return { text: "49 USD was the agreed price." };
    };
    const research = conversation.operations["conversation.research"]!;
    const result = await research({ query: "price 49 dollars", session_id: "sess-1", process: "summarize", limit: 1 }, ctx) as {
      derived: { text: string };
      derivation: { kind: string; source_message_ids: string[] };
    };
    expect(nested).toHaveLength(1);
    expect(nested[0]?.name).toBe("document.summarize");
    expect(String(nested[0]?.params.text)).toContain("m-2");
    expect(result.derived.text).toContain("49 USD");
    expect(result.derivation).toMatchObject({ kind: "summarize", source_message_ids: ["m-2"] });
  });
});

describe("conversation.search — degrades honestly", () => {
  it("requires a query rather than returning arbitrary messages", async () => {
    const { ctx } = makeCtx(TRANSCRIPT);
    await expect(search({ session_id: "sess-1" }, ctx)).rejects.toThrow(/requires 'query'/);
  });

  it("explains what it needs when no session is given", async () => {
    const { ctx, calls } = makeCtx(TRANSCRIPT, { noSession: true });
    const r = (await search({ query: "anything" }, ctx)) as { ok: boolean; reason: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("host-authorized conversation thread");
    expect(calls).toHaveLength(0);
  });

  it("reports retrieval failure instead of claiming the detail was never discussed", async () => {
    // A failed lookup must not blow up the run or turn a network failure into a false negative.
    const { ctx } = makeCtx(TRANSCRIPT, { failing: true });
    const r = (await search({ query: "Revolut", session_id: "sess-1" }, ctx)) as {
      ok: boolean;
      searched_messages: number;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(r.searched_messages).toBe(0);
    expect(r.reason).toContain("Transcript service returned 500");
    expect(r.reason).toContain("does not mean");
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

  it("tokenizes non-Latin conversation details so history lookup works across languages", () => {
    expect(scoreMessage({ role: "user", content: "Сохраните кодовое слово: маяк" }, ["маяк"])).toBeGreaterThan(0);
    expect(scoreMessage({ role: "user", content: "東京で会議をします" }, ["東京"])).toBeGreaterThan(0);
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

  it("preconfigures conversation research routing for both assistant profiles", async () => {
    const { DEFAULT_NAELAO_AGENT, LAUNCHPAD_ASSISTANT_PROFILE } = await import("../../workers/agents/src/script-engine/profiles.js");
    expect(DEFAULT_NAELAO_AGENT.config.skills.skills).toContainEqual({ name: "conversation-research-routing", tier: "platform" });
    expect(LAUNCHPAD_ASSISTANT_PROFILE.config.skills.skills).toContainEqual({ name: "conversation-research-routing", tier: "platform" });
  });

  it("conversation.search is auto-approved under guided mode — a read of the agent's own already-stored transcript", async () => {
    const { LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED } = await import("../../workers/agents/src/script-engine/profiles.js");
    expect(LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED).toContain("conversation.search");
  });
});
