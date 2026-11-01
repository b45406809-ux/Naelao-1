import { describe, expect, it } from "vitest";
import {
  evaluateBlackboardRankings,
  type BlackboardRankingCase,
} from "./blackboard-ranking-evaluation.js";

describe("paired blackboard ranking evaluator", () => {
  it("compares paired lexical and candidate rankings with MRR, Recall@K and nDCG@K", () => {
    const cases: BlackboardRankingCase[] = [
      {
        id: "q1",
        relevantProjectIds: ["a", "b"],
        baselineOrder: ["x", "a", "b"],
        candidateOrder: ["a", "b", "x"],
      },
      {
        id: "q2",
        relevantProjectIds: ["c"],
        baselineOrder: ["c", "z"],
        candidateOrder: ["c", "z"],
      },
    ];
    const result = evaluateBlackboardRankings(cases, {
      k: 2,
      bootstrapSamples: 1000,
    });
    expect(result.evidenceClass).toBe("ranking-evaluator-harness");
    expect(result.baseline).toMatchObject({
      cases: 2,
      meanReciprocalRank: 0.75,
      meanRecallAtK: 0.75,
    });
    expect(result.candidate).toMatchObject({
      cases: 2,
      meanReciprocalRank: 1,
      meanRecallAtK: 1,
      meanNdcgAtK: 1,
    });
    expect(result.pairedDelta.meanReciprocalRank).toBe(0.25);
    expect(result.pairedDelta.meanRecallAtK).toBe(0.25);
    expect(result.pairedDelta.meanReciprocalRank95Ci[0]).toBeGreaterThanOrEqual(
      0
    );
  });

  it("returns a deterministic zero-effect interval for unchanged paired rankings", () => {
    const cases = Array.from(
      { length: 12 },
      (_, index): BlackboardRankingCase => ({
        id: `q-${index}`,
        relevantProjectIds: [`p-${index}`],
        baselineOrder: [`p-${index}`, `other-${index}`],
        candidateOrder: [`p-${index}`, `other-${index}`],
      })
    );
    const first = evaluateBlackboardRankings(cases, {
      seed: 91,
      bootstrapSamples: 1000,
    });
    const second = evaluateBlackboardRankings(cases, {
      seed: 91,
      bootstrapSamples: 1000,
    });
    expect(first).toEqual(second);
    expect(first.pairedDelta.meanReciprocalRank95Ci).toEqual([0, 0]);
    expect(first.pairedDelta.meanRecallAtK95Ci).toEqual([0, 0]);
    expect(first.pairedDelta.meanNdcgAtK95Ci).toEqual([0, 0]);
  });

  it("rejects malformed labels, duplicated rankings, invalid K and undersized bootstrap samples", () => {
    const base: BlackboardRankingCase = {
      id: "q",
      relevantProjectIds: ["p"],
      baselineOrder: ["p"],
      candidateOrder: ["p"],
    };
    expect(() => evaluateBlackboardRankings([])).toThrow(
      "blackboard_eval_cases_empty"
    );
    expect(() =>
      evaluateBlackboardRankings([{ ...base, candidateOrder: ["p", "p"] }])
    ).toThrow("blackboard_eval_candidate_ids_invalid");
    expect(() =>
      evaluateBlackboardRankings([{ ...base, relevantProjectIds: [] }])
    ).toThrow("blackboard_eval_relevance_empty");
    expect(() => evaluateBlackboardRankings([base], { k: 0 })).toThrow(
      "blackboard_eval_k_invalid"
    );
    expect(() =>
      evaluateBlackboardRankings([base], { bootstrapSamples: 99 })
    ).toThrow("blackboard_eval_bootstrap_samples_invalid");
  });
});
