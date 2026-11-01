import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type SharedProjectCard,
  rankSharedCards,
} from "./blackboard-domain.js";
import { evaluateBlackboardRankings } from "./blackboard-ranking-evaluation.js";
import {
  blackboardRankingCards,
  blackboardRankingHoldoutQueries,
  blackboardRankingQueries,
} from "./blackboard-ranking-fixtures.js";

const BM25_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "about",
  "what",
  "which",
  "when",
  "where",
  "how",
  "are",
  "was",
  "were",
  "has",
  "have",
  "its",
  "our",
  "their",
  "project",
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 3 && !BM25_STOP_WORDS.has(term));
}

function rankCardsBm25(query: string, cards: readonly SharedProjectCard[]) {
  const documents = cards.map((card) =>
    tokenize(`${card.summary} ${card.capabilities.join(" ")}`)
  );
  const averageLength =
    documents.reduce((sum, doc) => sum + doc.length, 0) /
    Math.max(1, documents.length);
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const queryTerms = new Set(tokenize(query));
  const k1 = 1.2;
  const b = 0.75;
  return cards
    .map((card, index) => {
      const document = documents[index] ?? [];
      const frequencies = new Map<string, number>();
      for (const term of document)
        frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      const score = [...queryTerms].reduce((sum, term) => {
        const tf = frequencies.get(term) ?? 0;
        if (!tf) return sum;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log1p((cards.length - df + 0.5) / (df + 0.5));
        const norm = tf + k1 * (1 - b + b * (document.length / averageLength));
        return sum + idf * ((tf * (k1 + 1)) / norm);
      }, 0);
      return { card, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score || a.card.projectId.localeCompare(b.card.projectId)
    );
}

describe("synthetic Space Blackboard relevance corpus", () => {
  it("records a reproducible lexical baseline and explicit label-oracle ceiling", async () => {
    const cases = blackboardRankingQueries.map((query) => ({
      id: query.id,
      relevantProjectIds: query.relevantProjectIds,
      baselineOrder: rankSharedCards(query.query, blackboardRankingCards).map(
        (item) => item.card.projectId
      ),
      candidateOrder: [
        ...query.relevantProjectIds,
        ...blackboardRankingCards
          .map((card) => card.projectId)
          .filter((projectId) => !query.relevantProjectIds.includes(projectId)),
      ],
    }));
    const baseline = evaluateBlackboardRankings(cases, {
      k: 5,
      seed: 0x4242,
      bootstrapSamples: 5000,
    });
    const report = {
      schemaVersion: 1,
      evidenceClass: "synthetic-hand-labeled-harness-only",
      datasetVersion: "space-blackboard-relevance-v1",
      cards: blackboardRankingCards.length,
      queries: blackboardRankingQueries.length,
      lexicalBaseline: baseline.baseline,
      labelOracleCeiling: baseline.candidate,
      lexicalToOracleDelta: baseline.pairedDelta,
      note: "The oracle is constructed from fixture labels. It is not a model result or an achievable system benchmark.",
    };
    const reportPath = process.env.NAELAO_BLACKBOARD_RELEVANCE_REPORT;
    if (reportPath)
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`blackboard_relevance_fixture=${JSON.stringify(report)}`);

    expect(cases).toHaveLength(28);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    expect(baseline.baseline.cases).toBe(28);
    expect(baseline.candidate.meanReciprocalRank).toBe(1);
    expect(baseline.candidate.meanRecallAtK).toBe(1);
    expect(baseline.candidate.meanNdcgAtK).toBe(1);
  });

  it("measures lexical recall on a separate query-wording holdout", () => {
    const cases = blackboardRankingHoldoutQueries.map((query) => {
      const lexical = rankSharedCards(query.query, blackboardRankingCards).map(
        ({ card }) => card.projectId
      );
      return {
        id: query.id,
        relevantProjectIds: query.relevantProjectIds,
        baselineOrder: lexical,
        candidateOrder: lexical,
      };
    });
    const evaluation = evaluateBlackboardRankings(cases, {
      k: 5,
      seed: 0x484f4c44,
      bootstrapSamples: 5000,
    });
    const relevantCount = blackboardRankingHoldoutQueries.reduce(
      (sum, query) => sum + query.relevantProjectIds.length,
      0
    );
    const lexicalAnyHits = blackboardRankingHoldoutQueries.reduce(
      (sum, query) =>
        sum +
        query.relevantProjectIds.filter((id) =>
          rankSharedCards(query.query, blackboardRankingCards).some(
            ({ card }) => card.projectId === id
          )
        ).length,
      0
    );
    const report = {
      evidenceClass: "synthetic-query-wording-holdout",
      cardsReusedFromTrainingFixture: blackboardRankingCards.length,
      queries: cases.length,
      relevantCardInstances: relevantCount,
      lexicalRelevantAnyRecall: lexicalAnyHits / relevantCount,
      lexicalTopFive: evaluation.baseline,
      limitations: [
        "Queries were authored separately from relevance-v1, but use the same synthetic card catalog and labels are not independently adjudicated.",
        "This evaluates lexical retrieval only; it is not a model result or customer traffic estimate.",
      ],
    };
    console.log(`blackboard_holdout_retrieval=${JSON.stringify(report)}`);

    expect(cases).toHaveLength(16);
    expect(new Set(cases.map(({ id }) => id)).size).toBe(16);
    expect(relevantCount).toBe(16);
    expect(lexicalAnyHits).toBeGreaterThanOrEqual(0);
    expect(lexicalAnyHits).toBeLessThanOrEqual(relevantCount);
    expect(evaluation.baseline.cases).toBe(16);
  });

  it("measures candidate recall and ideal reranking ceiling as the catalog grows", () => {
    const scaleCounts = [16, 64, 256, 1024];
    const result = scaleCounts.map((size) => {
      const distractors: SharedProjectCard[] = Array.from(
        { length: Math.max(0, size - blackboardRankingCards.length) },
        (_, index) => ({
          projectId: `distractor-${String(index + 1).padStart(4, "0")}`,
          summary:
            "General team operations project for planning, status tracking, review, and reporting.",
          capabilities: ["project planning", "status updates", "team reports"],
          evidence: [],
          updatedAt: "2026-11-01T00:00:00.000Z",
        })
      );
      const cards = [...blackboardRankingCards, ...distractors];
      const limits = [5, 20, 50, 100, cards.length].filter(
        (limit, index, all) =>
          limit <= cards.length && all.indexOf(limit) === index
      );
      const candidates = limits.map((limit) => {
        const relevantCount = blackboardRankingHoldoutQueries.reduce(
          (sum, query) => sum + query.relevantProjectIds.length,
          0
        );
        const evaluateStrategy = (strategy: "lexical" | "bm25") => {
          let relevantInstances = 0;
          const cases = blackboardRankingHoldoutQueries.map((query) => {
            const lexical = rankSharedCards(query.query, cards).map(
              ({ card }) => card.projectId
            );
            const strategyOrder =
              strategy === "lexical"
                ? rankSharedCards(query.query, cards, {
                    includeZeroScore: limit === cards.length,
                  }).map(({ card }) => card.projectId)
                : rankCardsBm25(query.query, cards).map(
                    ({ card }) => card.projectId
                  );
            const retrieved =
              limit === cards.length
                ? [...strategyOrder]
                : strategyOrder.slice(0, limit);
            const relevant = new Set(query.relevantProjectIds);
            relevantInstances += query.relevantProjectIds.filter((id) =>
              retrieved.includes(id)
            ).length;
            const idealized = [
              ...retrieved.filter((id) => relevant.has(id)),
              ...retrieved.filter((id) => !relevant.has(id)),
            ];
            return {
              id: query.id,
              relevantProjectIds: query.relevantProjectIds,
              baselineOrder: lexical,
              candidateOrder: idealized,
            };
          });
          const evaluation = evaluateBlackboardRankings(cases, {
            k: 5,
            seed: 0x5343414c,
            bootstrapSamples: 1000,
          });
          return {
            relevantCandidateRecall: relevantInstances / relevantCount,
            boundedRerankerCeiling: evaluation.candidate,
          };
        };
        return {
          candidateLimit: limit,
          lexical: evaluateStrategy("lexical"),
          bm25: evaluateStrategy("bm25"),
        };
      });
      return { catalogCards: cards.length, candidates };
    });
    const report = {
      evidenceClass: "synthetic-scaled-catalog-stress",
      queryCount: blackboardRankingHoldoutQueries.length,
      relevanceLabelsIndependentlyAdjudicated: false,
      distractorsPerCatalog: scaleCounts.map(
        (size) => size - blackboardRankingCards.length
      ),
      result,
      limitations: [
        "The same 16 synthetic relevant cards and query-wording holdout are reused at every size.",
        "Distractors are templated and intentionally overlap generic planning/status terms; this is a stress case, not a traffic distribution.",
        "The idealized reranker knows fixture relevance labels and is an upper bound, not a model result.",
      ],
    };
    console.log(`blackboard_catalog_scale=${JSON.stringify(report)}`);

    expect(result.map(({ catalogCards }) => catalogCards)).toEqual(scaleCounts);
    for (const scale of result) {
      const recalls = scale.candidates.map(
        ({ lexical }) => lexical.relevantCandidateRecall
      );
      expect(recalls).toEqual([...recalls].sort((a, b) => a - b));
      expect(scale.candidates.at(-1)?.lexical.relevantCandidateRecall).toBe(1);
      expect(scale.candidates.at(-1)?.bm25.relevantCandidateRecall).toBe(1);
      for (const candidate of scale.candidates) {
        expect(candidate.bm25.relevantCandidateRecall).toBeGreaterThanOrEqual(
          candidate.lexical.relevantCandidateRecall
        );
      }
    }
  });
});
