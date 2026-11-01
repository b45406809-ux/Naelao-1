import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rankSharedCards } from "./blackboard-domain.js";
import { evaluateBlackboardRankings } from "./blackboard-ranking-evaluation.js";
import {
  blackboardRankingCards,
  blackboardRankingHoldoutQueries,
  blackboardRankingQueries,
} from "./blackboard-ranking-fixtures.js";

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
});
