export interface BlackboardRankingCase {
  id: string;
  relevantProjectIds: readonly string[];
  baselineOrder: readonly string[];
  candidateOrder: readonly string[];
}

export interface RankingMetrics {
  cases: number;
  meanReciprocalRank: number;
  meanRecallAtK: number;
  meanNdcgAtK: number;
}

export interface PairedRankingEvaluation {
  schemaVersion: 1;
  evidenceClass: "ranking-evaluator-harness";
  seed: number;
  k: number;
  bootstrapSamples: number;
  baseline: RankingMetrics;
  candidate: RankingMetrics;
  pairedDelta: {
    meanReciprocalRank: number;
    meanRecallAtK: number;
    meanNdcgAtK: number;
    meanReciprocalRank95Ci: [number, number];
    meanRecallAtK95Ci: [number, number];
    meanNdcgAtK95Ci: [number, number];
  };
}

type PerCaseMetrics = Pick<
  RankingMetrics,
  "meanReciprocalRank" | "meanRecallAtK" | "meanNdcgAtK"
>;

function validateCases(cases: readonly BlackboardRankingCase[]): void {
  if (!cases.length) throw new Error("blackboard_eval_cases_empty");
  const ids = new Set<string>();
  for (const item of cases) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      ids.has(item.id)
    )
      throw new Error("blackboard_eval_case_id_invalid");
    ids.add(item.id);
    for (const [name, values] of [
      ["relevant", item.relevantProjectIds],
      ["baseline", item.baselineOrder],
      ["candidate", item.candidateOrder],
    ] as const) {
      if (
        !Array.isArray(values) ||
        values.some((value) => typeof value !== "string" || !value.trim()) ||
        new Set(values).size !== values.length
      ) {
        throw new Error(`blackboard_eval_${name}_ids_invalid`);
      }
    }
    if (!item.relevantProjectIds.length)
      throw new Error("blackboard_eval_relevance_empty");
  }
}

function measureCase(
  relevantIds: readonly string[],
  ranking: readonly string[],
  k: number
): PerCaseMetrics {
  const relevant = new Set(relevantIds);
  const firstRelevantRank = ranking.findIndex((projectId) =>
    relevant.has(projectId)
  );
  const meanReciprocalRank =
    firstRelevantRank < 0 ? 0 : 1 / (firstRelevantRank + 1);
  const top = ranking.slice(0, k);
  const hits = top.filter((projectId) => relevant.has(projectId)).length;
  const meanRecallAtK = hits / relevant.size;
  const dcg = top.reduce(
    (sum, projectId, index) =>
      sum + (relevant.has(projectId) ? 1 / Math.log2(index + 2) : 0),
    0
  );
  const idealRelevantCount = Math.min(relevant.size, k);
  const idealDcg = Array.from(
    { length: idealRelevantCount },
    (_, index) => 1 / Math.log2(index + 2)
  ).reduce((sum, value) => sum + value, 0);
  return {
    meanReciprocalRank,
    meanRecallAtK,
    meanNdcgAtK: idealDcg ? dcg / idealDcg : 0,
  };
}

function aggregate(values: readonly PerCaseMetrics[]): RankingMetrics {
  const count = values.length;
  return {
    cases: count,
    meanReciprocalRank:
      values.reduce((sum, item) => sum + item.meanReciprocalRank, 0) / count,
    meanRecallAtK:
      values.reduce((sum, item) => sum + item.meanRecallAtK, 0) / count,
    meanNdcgAtK:
      values.reduce((sum, item) => sum + item.meanNdcgAtK, 0) / count,
  };
}

function randomFor(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function bootstrapMean95(
  deltas: readonly number[],
  seed: number,
  samples: number
): [number, number] {
  const random = randomFor(seed);
  const means = Array.from({ length: samples }, () => {
    let total = 0;
    for (let index = 0; index < deltas.length; index++)
      total += deltas[Math.floor(random() * deltas.length)] ?? 0;
    return total / deltas.length;
  }).sort((a, b) => a - b);
  const low = means[Math.floor((samples - 1) * 0.025)] ?? 0;
  const high = means[Math.floor((samples - 1) * 0.975)] ?? 0;
  return [low, high];
}

/** Paired ranking metrics; this evaluates labels and order only, never provider quality or task success. */
export function evaluateBlackboardRankings(
  cases: readonly BlackboardRankingCase[],
  options: { k?: number; seed?: number; bootstrapSamples?: number } = {}
): PairedRankingEvaluation {
  validateCases(cases);
  const k = options.k ?? 5;
  const seed = options.seed ?? 0x4e41454c;
  const bootstrapSamples = options.bootstrapSamples ?? 2000;
  if (!Number.isSafeInteger(k) || k < 1 || k > 100)
    throw new Error("blackboard_eval_k_invalid");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff)
    throw new Error("blackboard_eval_seed_invalid");
  if (
    !Number.isSafeInteger(bootstrapSamples) ||
    bootstrapSamples < 100 ||
    bootstrapSamples > 100_000
  )
    throw new Error("blackboard_eval_bootstrap_samples_invalid");

  const baselineValues = cases.map((item) =>
    measureCase(item.relevantProjectIds, item.baselineOrder, k)
  );
  const candidateValues = cases.map((item) =>
    measureCase(item.relevantProjectIds, item.candidateOrder, k)
  );
  const paired = (key: keyof PerCaseMetrics) =>
    cases.map(
      (_, index) =>
        (candidateValues[index]?.[key] ?? 0) -
        (baselineValues[index]?.[key] ?? 0)
    );
  const mrrDeltas = paired("meanReciprocalRank");
  const recallDeltas = paired("meanRecallAtK");
  const ndcgDeltas = paired("meanNdcgAtK");
  const mean = (values: readonly number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    schemaVersion: 1,
    evidenceClass: "ranking-evaluator-harness",
    seed,
    k,
    bootstrapSamples,
    baseline: aggregate(baselineValues),
    candidate: aggregate(candidateValues),
    pairedDelta: {
      meanReciprocalRank: mean(mrrDeltas),
      meanRecallAtK: mean(recallDeltas),
      meanNdcgAtK: mean(ndcgDeltas),
      meanReciprocalRank95Ci: bootstrapMean95(
        mrrDeltas,
        seed,
        bootstrapSamples
      ),
      meanRecallAtK95Ci: bootstrapMean95(
        recallDeltas,
        seed ^ 0x9e3779b9,
        bootstrapSamples
      ),
      meanNdcgAtK95Ci: bootstrapMean95(
        ndcgDeltas,
        seed ^ 0x85ebca6b,
        bootstrapSamples
      ),
    },
  };
}
