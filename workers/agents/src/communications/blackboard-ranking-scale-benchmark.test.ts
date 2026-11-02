import { describe, expect, it } from "vitest";
import { rankSharedCards, type SharedProjectCard } from "./blackboard-domain.js";

const PAGE_SIZE = 100;

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
}

function buildCards(count: number): SharedProjectCard[] {
  return Array.from({ length: count }, (_, index) => ({
    projectId: `project-${String(index).padStart(5, "0")}`,
    summary: `Project summary case-${String(index).padStart(5, "0")}`,
    capabilities: [],
    evidence: [],
    updatedAt: "2026-11-02T00:00:00.000Z",
  }));
}

describe("blackboard ranking scale experiment", () => {
  it("quantifies page-order misses versus ranking the complete visible card set", () => {
    const scales = [100, 1_000, 10_000];
    const queriesPerScale = 100;
    const metrics = scales.map((cardCount) => {
      const cards = buildCards(cardCount);
      const queryCount = Math.min(queriesPerScale, cardCount);
      let firstPageExactHits = 0;
      let completeSetExactHits = 0;
      const pagesToTarget: number[] = [];
      const pageRankMs: number[] = [];
      const fullRankMs: number[] = [];

      for (let queryIndex = 0; queryIndex < queryCount; queryIndex++) {
        const targetIndex = Math.floor((queryIndex * cardCount) / queryCount);
        const target = cards[targetIndex];
        if (!target) throw new Error("blackboard_scale_target_missing");
        const query = `case-${String(targetIndex).padStart(5, "0")}`;

        const pageStarted = performance.now();
        const firstPage = rankSharedCards(query, cards.slice(0, PAGE_SIZE));
        pageRankMs.push(performance.now() - pageStarted);
        if (firstPage.some(({ card }) => card.projectId === target.projectId))
          firstPageExactHits++;

        const fullStarted = performance.now();
        const allCards = rankSharedCards(query, cards);
        fullRankMs.push(performance.now() - fullStarted);
        if (allCards[0]?.card.projectId === target.projectId)
          completeSetExactHits++;

        pagesToTarget.push(Math.floor(targetIndex / PAGE_SIZE) + 1);
      }

      return {
        cards: cardCount,
        queries: queryCount,
        firstPageExactRecall: firstPageExactHits / queryCount,
        allVisibleTop1ExactRecall: completeSetExactHits / queryCount,
        meanPagesToTarget: pagesToTarget.reduce((sum, page) => sum + page, 0) / queryCount,
        firstPageRankMsP50: percentile(pageRankMs, 0.5),
        firstPageRankMsP95: percentile(pageRankMs, 0.95),
        allVisibleRankMsP50: percentile(fullRankMs, 0.5),
        allVisibleRankMsP95: percentile(fullRankMs, 0.95),
      };
    });

    expect(metrics.every((item) => item.allVisibleTop1ExactRecall === 1)).toBe(true);
    expect(metrics.find((item) => item.cards === 10_000)?.firstPageExactRecall).toBe(0.01);
    expect(metrics.find((item) => item.cards === 10_000)?.meanPagesToTarget).toBe(50.5);
    console.log(JSON.stringify({
      schemaVersion: 1,
      kind: "blackboard_page_order_scale_experiment",
      evidenceClass: "unit_synthetic_card_corpus",
      pageSize: PAGE_SIZE,
      metrics,
      caveats: [
        "Synthetic sorted card IDs and exact lexical labels; no D1, model, provider, or production latency is measured.",
        "The first-page arm models one current blackboard.cards page; callers can request later pages using next_cursor.",
        "All-visible recall is a lexical ranking ceiling, not an independent relevance or user-utility score.",
      ],
    }));
  });
});
