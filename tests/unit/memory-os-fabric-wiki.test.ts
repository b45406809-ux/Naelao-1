import { describe, it, expect, beforeEach } from "vitest";
import { initMemorySchema, buildMemoryStore } from "../../workers/agents/src/script-engine/memory-os.js";
import type { MemoryStore } from "../../workers/agents/src/script-engine/types.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Memory OS Layer 4 (Fabric) + Layer 6 (LLM Wiki) — spec "6-Layer Memory OS", byte ~148161.
// Runs against a REAL in-memory SQLite engine (node:sqlite) rather than a hand-rolled fake,
// so the actual fabric_store/wiki_store schema + queries are exercised.

function makeStore(): MemoryStore {
  const sql = createDOSqlStorage();
  initMemorySchema(sql as never);
  return buildMemoryStore({ sql: sql as never, spaceId: "space-1" });
}

describe("Memory OS Layer 4 (Fabric) — cross-session consolidation", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = makeStore();
  });

  it("records a session summary and recalls it by keyword", async () => {
    await store.recordFabric({
      userId: "u1",
      sessionId: "sess-1",
      summary: "Helped the customer set up their WhatsApp business bot and connect billing.",
      keyInsights: ["prefers WhatsApp over email", "billing already connected"],
    });

    const results = await store.recallFabric({ userId: "u1", text: "WhatsApp business bot" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.sessionId).toBe("sess-1");
    expect(results[0]!.score).toBeGreaterThan(0.7); // spec's surgicalRecall floor
  });

  it("filters out irrelevant fabric entries below the score floor", async () => {
    await store.recordFabric({ userId: "u1", sessionId: "sess-1", summary: "Discussed pricing tiers for the enterprise plan." });
    const results = await store.recallFabric({ userId: "u1", text: "unrelated topic about kayaking" });
    expect(results).toHaveLength(0);
  });

  it("briefFabric returns recent sessions without needing a query", async () => {
    await store.recordFabric({ userId: "u1", sessionId: "sess-1", summary: "First session summary." });
    await store.recordFabric({ userId: "u1", sessionId: "sess-2", summary: "Second session summary." });
    const brief = await store.briefFabric("u1", 5);
    expect(brief.length).toBe(2);
    expect(brief[0]!.sessionId).toBe("sess-2"); // most recent first
  });

  it("scopes fabric entries per user — one user never sees another's summaries", async () => {
    await store.recordFabric({ userId: "u1", sessionId: "sess-1", summary: "User one's private session about their taxes." });
    const otherUser = await store.recallFabric({ userId: "u2", text: "taxes" });
    expect(otherUser).toHaveLength(0);
  });
});

describe("Memory OS Layer 6 (LLM Wiki) — auto-curated concept vault", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = makeStore();
  });

  it("upserts a concept and looks it up by name", async () => {
    await store.upsertWikiConcept({
      userId: "u1",
      concept: "escrow_period",
      definition: "The 14-day hold before a seller's payout is released.",
      relationships: ["payout", "seller"],
    });
    const article = await store.lookupWikiConcept("u1", "escrow_period");
    expect(article?.definition).toContain("14-day hold");
    expect(article?.relationships).toContain("payout");
  });

  it("re-upserting the same concept refreshes the definition rather than duplicating it", async () => {
    await store.upsertWikiConcept({ userId: "u1", concept: "vip_tier", definition: "v1 definition" });
    await store.upsertWikiConcept({ userId: "u1", concept: "vip_tier", definition: "v2 definition, corrected" });
    const article = await store.lookupWikiConcept("u1", "vip_tier");
    expect(article?.definition).toBe("v2 definition, corrected");
  });

  it("returns null for an unknown concept", async () => {
    const article = await store.lookupWikiConcept("u1", "does_not_exist");
    expect(article).toBeNull();
  });

  it("searchWiki matches by concept name or definition text", async () => {
    await store.upsertWikiConcept({ userId: "u1", concept: "refund_window", definition: "30 days from purchase date." });
    await store.upsertWikiConcept({ userId: "u1", concept: "shipping_zone", definition: "Determines delivery time." });
    const results = await store.searchWiki({ userId: "u1", text: "refund" });
    expect(results).toHaveLength(1);
    expect(results[0]!.concept).toBe("refund_window");
  });
});
