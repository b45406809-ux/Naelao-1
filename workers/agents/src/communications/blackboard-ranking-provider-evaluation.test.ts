import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { PrebuiltOpContext } from "../script-engine/prebuilt/index.js";
import { spaceBlackboard } from "../script-engine/prebuilt/space-blackboard.js";
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
import {
  asBlackboardRankingCases,
  buildBlackboardRankingPrompt,
  buildBlackboardRankingPromptForQueries,
  evaluateBlackboardCandidateCoverage,
  getBlackboardCandidateSets,
  getBlackboardPromptCandidateSets,
  parseBlackboardRankingScores,
  rerankAllVisibleBlackboardCards,
  restoreBlackboardRankingScoreIds,
} from "./blackboard-ranking-provider-evaluation.js";

const LIVE_ENABLED = process.env.NAELAO_RUN_LIVE_BLACKBOARD_RANKING === "true";
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const PROVIDER_TIMEOUT_MS = 20_000;
const QUERIES_PER_PROVIDER_REQUEST = 2;
const MAX_PROVIDER_REQUESTS = 16;
const HARD_RANKING_QUERIES = blackboardRankingQueries.filter(
  ({ id }) => id.startsWith("paraphrase-") || id.includes("-vs-")
);
const HOLDOUT_RANKING_QUERIES = blackboardRankingHoldoutQueries;
const LIVE_RANKING_QUERIES = [
  ...HOLDOUT_RANKING_QUERIES,
  ...HARD_RANKING_QUERIES,
];

function expectedCandidates(): Map<string, Set<string>> {
  return getBlackboardCandidateSets(blackboardRankingCards);
}

function classifyFailure(status: number): string {
  if (status === 429) return "quota_or_rate_limited";
  if (status === 401 || status === 403) return "credential_or_access_denied";
  if (status >= 500) return "provider_unavailable";
  return "provider_error";
}

function percentile(
  values: readonly number[],
  fraction: number
): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
    ] ?? null
  );
}

async function requestModelScores(
  provider: "gemini" | "groqcloud",
  queries: readonly (typeof blackboardRankingQueries)[number][],
  onRequestAttempt: () => void,
  allVisibleCards = false
): Promise<{
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  keySlot: number;
  rejectedCredentialAttempts: number;
  raw: string;
}> {
  const keys =
    (provider === "gemini"
      ? process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY
      : process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY
    )
      ?.split(",")
      .map((key) => key.trim())
      .filter(Boolean)
      .slice(0, 4) ?? [];
  if (!keys.length) throw new Error("provider_secret_missing");
  if (
    process.env[
      `${provider === "gemini" ? "GEMINI" : "GROQ"}_FREE_TIER_CONFIRMED`
    ] !== "true"
  )
    throw new Error("free_tier_not_confirmed");

  const model =
    provider === "gemini"
      ? GEMINI_MODEL
      : process.env.GROQ_FREE_MODEL_ID?.trim() || "";
  if (!model) throw new Error("approved_free_model_not_configured");

  const prompt = buildBlackboardRankingPromptForQueries(queries, {
    allVisibleCards,
  });
  let rejectedCredentialAttempts = 0;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (!key) throw new Error("provider_secret_missing");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    const started = performance.now();
    try {
      onRequestAttempt();
      const response =
        provider === "gemini"
          ? await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
              {
                method: "POST",
                signal: controller.signal,
                headers: {
                  "content-type": "application/json",
                  "x-goog-api-key": key,
                },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }],
                  generationConfig: {
                    maxOutputTokens: 2048,
                    temperature: 0,
                    responseMimeType: "application/json",
                  },
                }),
              }
            )
          : await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST",
              signal: controller.signal,
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${key}`,
              },
              body: JSON.stringify({
                model,
                messages: [{ role: "user", content: prompt }],
                max_completion_tokens: 2048,
                reasoning_effort: "low",
                response_format: { type: "json_object" },
              }),
            });
      if (
        [401, 403, 404].includes(response.status) &&
        index + 1 < keys.length
      ) {
        rejectedCredentialAttempts++;
        continue;
      }
      const latencyMs = Math.round(performance.now() - started);
      if (!response.ok) {
        // Never log provider response bodies; some APIs echo submitted prompt data.
        throw new Error(
          `${classifyFailure(response.status)}:${response.status}`
        );
      }
      const body = (await response.json()) as Record<string, unknown>;
      const raw =
        provider === "gemini"
          ? (
              (
                body.candidates as
                  | Array<{ content?: { parts?: Array<{ text?: unknown }> } }>
                  | undefined
              )?.[0]?.content?.parts ?? []
            )
              .map((part) => (typeof part.text === "string" ? part.text : ""))
              .join("")
          : (
              body.choices as
                | Array<{ message?: { content?: unknown } }>
                | undefined
            )?.[0]?.message?.content;
      if (typeof raw !== "string")
        throw new Error("provider_response_content_missing");
      const usage = (provider === "gemini" ? body.usageMetadata : body.usage) as
        | Record<string, unknown>
        | undefined;
      return {
        model,
        latencyMs,
        keySlot: index + 1,
        rejectedCredentialAttempts,
        inputTokens:
          Number(
            provider === "gemini"
              ? usage?.promptTokenCount
              : usage?.prompt_tokens
          ) || null,
        outputTokens:
          Number(
            provider === "gemini"
              ? usage?.candidatesTokenCount
              : usage?.completion_tokens
          ) || null,
        raw,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "blackboard_provider_request_budget_exhausted" ||
          /^(quota_or_rate_limited|credential_or_access_denied|provider_unavailable|provider_error):\d+$/.test(
            error.message
          ))
      )
        throw error;
      throw new Error(
        error instanceof Error && error.name === "AbortError"
          ? "provider_timeout"
          : error instanceof Error &&
              error.message === "provider_response_content_missing"
            ? error.message
            : "provider_network_or_response_error"
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("credential_or_model_access_denied");
}

async function evaluateProductionReranker(
  provider: string,
  model: string,
  scores: ReturnType<typeof parseBlackboardRankingScores>,
  queries: readonly (typeof blackboardRankingQueries)[number][] = blackboardRankingQueries
) {
  const scoresByQuery = new Map(
    scores.map((item) => [
      item.queryId,
      new Map(item.scores.map((score) => [score.projectId, score.relevance])),
    ])
  );
  const cards = blackboardRankingCards as SharedProjectCard[];
  const cardBySummary = new Map(cards.map((card) => [card.summary, card]));
  const orders = new Map<string, string[]>();
  const searchOperation = spaceBlackboard.operations["blackboard.search"];
  if (!searchOperation)
    throw new Error("blackboard_search_operation_unavailable");
  for (const query of queries) {
    const scoreMap = scoresByQuery.get(query.id);
    if (!scoreMap) throw new Error("provider_evaluation_query_mapping_failed");
    const fetcher = async () =>
      Response.json({ cards, next_cursor: null, truncated: false });
    const score = async (input: { state: { summary: string } }) => {
      const card = cardBySummary.get(input.state.summary);
      if (!card) throw new Error("provider_evaluation_card_mapping_failed");
      const value = scoreMap.get(card.projectId);
      if (value === undefined)
        throw new Error("provider_evaluation_score_missing");
      return { value, provider, model };
    };
    const ctx = {
      env: {
        tenantId: "synthetic-tenant",
        spaceId: "synthetic-space",
        projectId: "synthetic-evaluator",
        userId: "synthetic-evaluator",
        platformSecret: "synthetic-test-only",
        spacesWorker: { fetch: fetcher },
        fastDecision: { score },
      },
    } as unknown as PrebuiltOpContext;
    const output = (await searchOperation(
      { query: query.query, model_triage: true },
      ctx
    )) as { candidates: Array<{ card: SharedProjectCard }> };
    orders.set(
      query.id,
      output.candidates.map(({ card }) => card.projectId)
    );
  }
  return summarizeOrders(orders, queries, cards);
}

function evaluateAllVisibleReranker(
  scores: ReturnType<typeof parseBlackboardRankingScores>,
  queries: readonly (typeof blackboardRankingQueries)[number][]
) {
  const scoresByQuery = new Map(
    scores.map(({ queryId, scores: values }) => [
      queryId,
      new Map(values.map(({ projectId, relevance }) => [projectId, relevance])),
    ])
  );
  const orders = new Map<string, string[]>();
  for (const query of queries) {
    const scoreMap = scoresByQuery.get(query.id);
    if (!scoreMap) throw new Error("provider_evaluation_query_mapping_failed");
    orders.set(
      query.id,
      rerankAllVisibleBlackboardCards(
        query.query,
        blackboardRankingCards,
        scoreMap
      )
    );
  }
  return summarizeOrders(orders, queries, blackboardRankingCards, true);
}

async function evaluateAvailableProviderScores(
  provider: string,
  model: string,
  scores: ReturnType<typeof parseBlackboardRankingScores>
) {
  const scoredQueryIds = new Set(scores.map(({ queryId }) => queryId));
  const completedHardQueries = HARD_RANKING_QUERIES.filter(({ id }) =>
    scoredQueryIds.has(id)
  );
  const completedHoldoutQueries = HOLDOUT_RANKING_QUERIES.filter(({ id }) =>
    scoredQueryIds.has(id)
  );
  const partialMetrics: Record<string, unknown> = {};
  if (completedHardQueries.length) {
    const hard = await evaluateProductionReranker(
      provider,
      model,
      scores,
      completedHardQueries
    );
    const hardExpanded = evaluateAllVisibleReranker(
      scores,
      completedHardQueries
    );
    partialMetrics.hardQueries = {
      completed: completedHardQueries.length,
      baseline: hard.baseline,
      candidate: hard.candidate,
      allVisibleBaseline: hardExpanded.baseline,
      allVisibleCandidate: hardExpanded.candidate,
    };
  }
  if (completedHoldoutQueries.length) {
    const holdout = await evaluateProductionReranker(
      provider,
      model,
      scores,
      completedHoldoutQueries
    );
    const holdoutExpanded = evaluateAllVisibleReranker(
      scores,
      completedHoldoutQueries
    );
    partialMetrics.queryWordingHoldout = {
      completed: completedHoldoutQueries.length,
      total: HOLDOUT_RANKING_QUERIES.length,
      baseline: holdout.baseline,
      candidate: holdout.candidate,
      rankingDiagnostics: holdout.rankingDiagnostics,
      allVisibleBaseline: holdoutExpanded.baseline,
      allVisibleCandidate: holdoutExpanded.candidate,
    };
  }
  return {
    completedHardQueries: completedHardQueries.length,
    completedHoldoutQueries: completedHoldoutQueries.length,
    partialMetrics,
  };
}

function summarizeOrders(
  orders: ReadonlyMap<string, readonly string[]>,
  queries: readonly (typeof blackboardRankingQueries)[number][],
  cards: readonly SharedProjectCard[],
  includeZeroBaseline = false
) {
  const pairedCases = asBlackboardRankingCases(orders, cards, queries, {
    includeZeroBaseline,
  });
  const result = evaluateBlackboardRankings(pairedCases, {
    k: 5,
    seed: 0x4242,
    bootstrapSamples: 5000,
  });
  const strata: Record<string, typeof pairedCases> = {
    single_intent: [],
    multi_project: [],
    paraphrase: [],
  };
  for (const item of pairedCases) {
    const stratum = item.id.startsWith("paraphrase-")
      ? "paraphrase"
      : item.id.includes("-vs-")
        ? "multi_project"
        : "single_intent";
    strata[stratum]?.push(item);
  }
  const stratifiedMetrics = Object.fromEntries(
    Object.entries(strata).map(([name, cases]) => {
      if (!cases.length) return [name, null];
      const metrics = evaluateBlackboardRankings(cases, {
        k: 5,
        seed: 0x4242,
        bootstrapSamples: 1000,
      });
      return [
        name,
        {
          cases: cases.length,
          baseline: metrics.baseline,
          modelCandidate: metrics.candidate,
          pairedDelta: {
            meanReciprocalRank: metrics.pairedDelta.meanReciprocalRank,
            meanRecallAtK: metrics.pairedDelta.meanRecallAtK,
            meanNdcgAtK: metrics.pairedDelta.meanNdcgAtK,
          },
        },
      ];
    })
  );
  return {
    ...result,
    stratifiedMetrics: Object.fromEntries(
      Object.entries(stratifiedMetrics).filter(
        ([, metrics]) => metrics !== null
      )
    ),
    rankingDiagnostics: {
      queriesWithChangedTopFive: pairedCases.filter(
        (item) =>
          item.baselineOrder.slice(0, 5).join("\0") !==
          item.candidateOrder.slice(0, 5).join("\0")
      ).length,
      queriesWithChangedFullOrder: pairedCases.filter(
        (item) =>
          item.baselineOrder.join("\0") !== item.candidateOrder.join("\0")
      ).length,
    },
  };
}

function summarizeProviderScores(
  scores: ReturnType<typeof parseBlackboardRankingScores>
) {
  const distribution = { unrelated: 0, possible: 0, strong: 0 };
  let queriesWithScoreVariation = 0;
  for (const query of scores) {
    const values = new Set(query.scores.map(({ relevance }) => relevance));
    if (values.size > 1) queriesWithScoreVariation++;
    for (const { relevance } of query.scores) {
      if (relevance === 0) distribution.unrelated++;
      else if (relevance === 1) distribution.possible++;
      else distribution.strong++;
    }
  }
  return { distribution, queriesWithScoreVariation };
}

async function writeLiveReport(report: unknown): Promise<void> {
  const path = process.env.NAELAO_LIVE_BLACKBOARD_REPORT;
  if (!path) return;
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

describe("blackboard provider ranking evaluation harness", () => {
  it("keeps the combined hard-query and holdout run inside the provider request budget", () => {
    expect(HARD_RANKING_QUERIES).toHaveLength(12);
    expect(HOLDOUT_RANKING_QUERIES).toHaveLength(16);
    expect(LIVE_RANKING_QUERIES).toHaveLength(28);
    expect(
      Math.ceil(LIVE_RANKING_QUERIES.length / QUERIES_PER_PROVIDER_REQUEST)
    ).toBeLessThanOrEqual(MAX_PROVIDER_REQUESTS);
  });

  it("evaluates completed holdout queries when later requests are unavailable", async () => {
    const queries = HOLDOUT_RANKING_QUERIES.slice(0, 2);
    const partialScores = queries.map((query) => ({
      queryId: query.id,
      scores: blackboardRankingCards.map((card) => ({
        projectId: card.projectId,
        relevance: query.relevantProjectIds.includes(card.projectId)
          ? (2 as const)
          : (0 as const),
      })),
    }));
    const result = await evaluateAvailableProviderScores(
      "test-provider",
      "test-model",
      partialScores
    );
    const holdout = result.partialMetrics.queryWordingHoldout as {
      completed: number;
      candidate: { meanReciprocalRank: number; meanRecallAtK: number };
      allVisibleCandidate: {
        meanReciprocalRank: number;
        meanRecallAtK: number;
      };
    };

    expect(result.completedHoldoutQueries).toBe(2);
    expect(result.completedHardQueries).toBe(0);
    expect(holdout.completed).toBe(2);
    expect(
      holdout.rankingDiagnostics.queriesWithChangedTopFive
    ).toBeGreaterThan(0);
    expect(holdout.candidate.meanReciprocalRank).toBeLessThan(1);
    expect(holdout.candidate.meanRecallAtK).toBeLessThan(1);
    expect(holdout.allVisibleCandidate.meanReciprocalRank).toBe(1);
    expect(holdout.allVisibleCandidate.meanRecallAtK).toBe(1);
  });

  it("keeps the scoring prompt free of relevance labels and bounds model candidates", () => {
    const prompt = buildBlackboardRankingPrompt();
    expect(prompt).toContain('"queryId":"query_001"');
    expect(prompt).not.toContain('"queryId":"customs-classification"');
    expect(prompt).not.toContain('"projectId":"support"');
    expect(prompt).not.toContain("relevantProjectIds");
    expect(prompt).not.toContain("labelOracleCeiling");
    for (const candidateSet of expectedCandidates().values())
      expect(candidateSet.size).toBeLessThanOrEqual(5);
  });

  it("builds independently parseable chunks without leaking labels", () => {
    const firstQuery = blackboardRankingQueries[0];
    if (!firstQuery) throw new Error("blackboard_query_fixture_missing");
    const subset = blackboardRankingQueries.slice(0, 7);
    const prompt = buildBlackboardRankingPromptForQueries(subset);
    expect(prompt).toContain('"queryId":"query_001"');
    expect(prompt).not.toContain('"queryId":"legal-redline"');
    expect(prompt).not.toContain("relevantProjectIds");
    expect(
      getBlackboardCandidateSets(blackboardRankingCards, subset).size
    ).toBe(7);
    const allVisiblePrompt = buildBlackboardRankingPromptForQueries(
      [firstQuery],
      { allVisibleCards: true }
    );
    expect(allVisiblePrompt).toContain('"projectId":"candidate_014"');
    expect(
      getBlackboardCandidateSets(blackboardRankingCards, [firstQuery], {
        allVisibleCards: true,
      }).get(firstQuery.id)?.size
    ).toBe(blackboardRankingCards.length);
    const hardCoverage =
      evaluateBlackboardCandidateCoverage(HARD_RANKING_QUERIES);
    expect(hardCoverage.queries).toBe(12);
    expect(hardCoverage.foundByLexicalAny).toBeLessThan(
      hardCoverage.relevantCards
    );
    const opaqueCandidates = getBlackboardPromptCandidateSets(
      blackboardRankingCards,
      [firstQuery],
      { allVisibleCards: true }
    );
    expect(opaqueCandidates.get("query_001")?.size).toBe(
      blackboardRankingCards.length
    );
    const restored = restoreBlackboardRankingScoreIds(
      [
        {
          queryId: "query_001",
          scores: [{ projectId: "candidate_001", relevance: 2 }],
        },
      ],
      blackboardRankingCards,
      [firstQuery]
    );
    expect(restored[0]?.queryId).toBe(firstQuery.id);
    expect(restored[0]?.scores[0]?.projectId).toBe("customs");
  });

  it("rejects incomplete, invented, duplicate, and invalid model scores", () => {
    const expected = new Map([
      ["q1", new Set(["p1", "p2"])],
      ["q2", new Set(["p3"])],
    ]);
    const valid = JSON.stringify({
      scores: [
        {
          queryId: "q1",
          scores: [
            { projectId: "p1", relevance: 2 },
            { projectId: "p2", relevance: 0 },
          ],
        },
        { queryId: "q2", scores: [{ projectId: "p3", relevance: 1 }] },
      ],
    });
    expect(parseBlackboardRankingScores(valid, expected)).toHaveLength(2);
    expect(() => parseBlackboardRankingScores("not-json", expected)).toThrow(
      "blackboard_provider_response_invalid_json"
    );
    expect(() =>
      parseBlackboardRankingScores(
        JSON.stringify({
          scores: [
            {
              queryId: "q1",
              scores: [
                { projectId: "p1", relevance: 2 },
                { projectId: "p2", relevance: 0 },
              ],
            },
          ],
        }),
        expected
      )
    ).toThrow("blackboard_provider_query_count_mismatch");
    expect(() =>
      parseBlackboardRankingScores(
        JSON.stringify({
          scores: [
            {
              queryId: "q1",
              scores: [
                { projectId: "unknown", relevance: 2 },
                { projectId: "p2", relevance: 0 },
              ],
            },
            { queryId: "q2", scores: [{ projectId: "p3", relevance: 1 }] },
          ],
        }),
        expected
      )
    ).toThrow("blackboard_provider_score_invalid");
    expect(() =>
      parseBlackboardRankingScores(
        JSON.stringify({
          scores: [
            {
              queryId: "q1",
              scores: [
                { projectId: "p1", relevance: 2 },
                { projectId: "p1", relevance: 0 },
              ],
            },
            { queryId: "q2", scores: [{ projectId: "p3", relevance: 1 }] },
          ],
        }),
        expected
      )
    ).toThrow("blackboard_provider_score_invalid");
    expect(() =>
      parseBlackboardRankingScores(
        JSON.stringify({
          scores: [
            {
              queryId: "q1",
              scores: [
                { projectId: "p1", relevance: 3 },
                { projectId: "p2", relevance: 0 },
              ],
            },
            { queryId: "q2", scores: [{ projectId: "p3", relevance: 1 }] },
          ],
        }),
        expected
      )
    ).toThrow("blackboard_provider_score_invalid");
  });

  it("feeds bounded candidate scores through the same production blackboard reranker", async () => {
    const candidateSets = expectedCandidates();
    const scores = blackboardRankingQueries.map((query) => {
      const candidates = candidateSets.get(query.id);
      if (!candidates) throw new Error("fixture_candidate_set_missing");
      return {
        queryId: query.id,
        scores: [...candidates].map((projectId) => ({
          projectId,
          relevance: (query.relevantProjectIds.includes(projectId) ? 2 : 0) as
            | 0
            | 2,
        })),
      };
    });
    const parsed = parseBlackboardRankingScores(
      JSON.stringify({ scores }),
      candidateSets
    );
    const measured = await evaluateProductionReranker(
      "synthetic-test",
      "deterministic-oracle-fixture",
      parsed
    );
    expect(measured.baseline.cases).toBe(28);
    expect(measured.candidate.cases).toBe(28);
    expect(measured.candidate.meanReciprocalRank).toBeGreaterThanOrEqual(
      measured.baseline.meanReciprocalRank
    );
    expect(measured.candidate.meanNdcgAtK).toBeGreaterThanOrEqual(
      measured.baseline.meanNdcgAtK
    );
    expect(measured.stratifiedMetrics.paraphrase.cases).toBe(8);
    expect(measured.stratifiedMetrics.multi_project.cases).toBe(4);
    expect(measured.stratifiedMetrics.single_intent.cases).toBe(16);
  });

  it("shows why a lexical zero-candidate query needs candidate-pool expansion", () => {
    const query = blackboardRankingQueries.find(
      ({ id }) => id === "paraphrase-refund"
    );
    if (!query) throw new Error("blackboard_hard_query_fixture_missing");
    const lexical = rankSharedCards(query.query, blackboardRankingCards);
    expect(
      lexical.some(({ card }) =>
        query.relevantProjectIds.includes(card.projectId)
      )
    ).toBe(false);
    const labelOracleScores = new Map(
      blackboardRankingCards.map((card) => [
        card.projectId,
        query.relevantProjectIds.includes(card.projectId) ? 2 : 0,
      ])
    );
    const expanded = rerankAllVisibleBlackboardCards(
      query.query,
      blackboardRankingCards,
      labelOracleScores
    );
    expect(expanded[0]).toBe("support");
    const [measured] = evaluateBlackboardRankings(
      [
        {
          id: query.id,
          relevantProjectIds: query.relevantProjectIds,
          baselineOrder: rankSharedCards(query.query, blackboardRankingCards, {
            includeZeroScore: true,
          }).map(({ card }) => card.projectId),
          candidateOrder: expanded,
        },
      ],
      { k: 5 }
    ).pairedDelta.meanReciprocalRank95Ci;
    expect(measured).toBeGreaterThan(0);
  });

  it.skipIf(!LIVE_ENABLED)(
    "compares bounded production top-five triage with all-visible candidate scoring on hard queries",
    async () => {
      const providers = ["gemini", "groqcloud"] as const;
      const results: Array<Record<string, unknown>> = [];
      for (const provider of providers) {
        let inferenceRequests = 0;
        const responses: Awaited<ReturnType<typeof requestModelScores>>[] = [];
        const parsed: ReturnType<typeof parseBlackboardRankingScores> = [];
        const enabled =
          process.env[
            `${provider === "gemini" ? "GEMINI" : "GROQ"}_PLAN_CALLS_ALLOWED`
          ] === "true";
        if (!enabled) {
          results.push({
            provider,
            state: "blocked",
            reason: "provider_not_eligible_from_prior_smoke",
          });
          continue;
        }
        const startedAt = Date.now();
        try {
          const chunks: Array<(typeof blackboardRankingQueries)[number][]> = [];
          for (
            let offset = 0;
            offset < LIVE_RANKING_QUERIES.length;
            offset += QUERIES_PER_PROVIDER_REQUEST
          ) {
            chunks.push(
              LIVE_RANKING_QUERIES.slice(
                offset,
                offset + QUERIES_PER_PROVIDER_REQUEST
              )
            );
          }
          const parseableResponseErrors = new Set([
            "blackboard_provider_response_invalid_json",
            "blackboard_provider_response_schema_invalid",
            "blackboard_provider_query_count_mismatch",
            "blackboard_provider_query_invalid",
            "blackboard_provider_candidate_count_mismatch",
            "blackboard_provider_score_entry_invalid",
            "blackboard_provider_score_invalid",
          ]);
          const requestAndParse = async (
            chunk: (typeof blackboardRankingQueries)[number][]
          ): Promise<ReturnType<typeof parseBlackboardRankingScores>> => {
            const response = await requestModelScores(
              provider,
              chunk,
              () => {
                if (inferenceRequests >= MAX_PROVIDER_REQUESTS)
                  throw new Error(
                    "blackboard_provider_request_budget_exhausted"
                  );
                inferenceRequests++;
              },
              true
            );
            responses.push(response);
            const expected = getBlackboardPromptCandidateSets(
              blackboardRankingCards,
              chunk,
              { allVisibleCards: true }
            );
            try {
              const validated = restoreBlackboardRankingScoreIds(
                parseBlackboardRankingScores(response.raw, expected),
                blackboardRankingCards,
                chunk
              );
              parsed.push(...validated);
              return validated;
            } catch (error) {
              const reason = error instanceof Error ? error.message : "";
              const code = reason.split(":", 1)[0] ?? "";
              if (chunk.length > 1 && parseableResponseErrors.has(code)) {
                const middle = Math.ceil(chunk.length / 2);
                return [
                  ...(await requestAndParse(chunk.slice(0, middle))),
                  ...(await requestAndParse(chunk.slice(middle))),
                ];
              }
              throw error;
            }
          };
          for (const chunk of chunks) {
            await requestAndParse(chunk);
          }
          const response = responses[0];
          if (!response) throw new Error("provider_response_missing");
          const result = await evaluateProductionReranker(
            provider,
            response.model,
            parsed,
            HARD_RANKING_QUERIES
          );
          const expandedResult = evaluateAllVisibleReranker(
            parsed,
            HARD_RANKING_QUERIES
          );
          const holdoutResult = await evaluateProductionReranker(
            provider,
            response.model,
            parsed,
            HOLDOUT_RANKING_QUERIES
          );
          const holdoutExpandedResult = evaluateAllVisibleReranker(
            parsed,
            HOLDOUT_RANKING_QUERIES
          );
          const scoringDiagnostics = summarizeProviderScores(parsed);
          results.push({
            provider,
            model: response.model,
            state: "completed",
            inferenceRequests,
            latencyMs: response.latencyMs,
            requestLatencyMs: responses.map(({ latencyMs }) => latencyMs),
            requestLatencyP50Ms: percentile(
              responses.map(({ latencyMs }) => latencyMs),
              0.5
            ),
            requestLatencyP95Ms: percentile(
              responses.map(({ latencyMs }) => latencyMs),
              0.95
            ),
            inputTokens: responses.reduce(
              (total, item) => total + (item.inputTokens ?? 0),
              0
            ),
            outputTokens: responses.reduce(
              (total, item) => total + (item.outputTokens ?? 0),
              0
            ),
            keySlots: [...new Set(responses.map(({ keySlot }) => keySlot))],
            rejectedCredentialAttempts: responses.reduce(
              (total, item) => total + item.rejectedCredentialAttempts,
              0
            ),
            providerReportedCostUsd: null,
            measuredCostUsd: null,
            baseline: result.baseline,
            modelCandidate: result.candidate,
            pairedDelta: result.pairedDelta,
            stratifiedMetrics: result.stratifiedMetrics,
            candidatePoolCoverage:
              evaluateBlackboardCandidateCoverage(HARD_RANKING_QUERIES),
            expandedCandidatePool: {
              baseline: expandedResult.baseline,
              modelCandidate: expandedResult.candidate,
              pairedDelta: expandedResult.pairedDelta,
              stratifiedMetrics: expandedResult.stratifiedMetrics,
              rankingDiagnostics: expandedResult.rankingDiagnostics,
            },
            queryWordingHoldout: {
              baseline: holdoutResult.baseline,
              modelCandidate: holdoutResult.candidate,
              pairedDelta: holdoutResult.pairedDelta,
              allVisibleBaseline: holdoutExpandedResult.baseline,
              allVisibleModelCandidate: holdoutExpandedResult.candidate,
              allVisiblePairedDelta: holdoutExpandedResult.pairedDelta,
              rankingDiagnostics: holdoutResult.rankingDiagnostics,
              queryCount: HOLDOUT_RANKING_QUERIES.length,
              sharedCardCatalog: blackboardRankingCards.length,
              labelsIndependentlyAdjudicated: false,
            },
            queryWordingHoldoutCoverage: evaluateBlackboardCandidateCoverage(
              HOLDOUT_RANKING_QUERIES
            ),
            scoringDiagnostics,
            rankingDiagnostics: result.rankingDiagnostics,
            queries: LIVE_RANKING_QUERIES.length,
            originalHardQueries: HARD_RANKING_QUERIES.length,
            queryWordingHoldoutQueries: HOLDOUT_RANKING_QUERIES.length,
            cards: blackboardRankingCards.length,
            candidatesPerQueryMaximum: blackboardRankingCards.length,
            searchQueriesEvaluated: HARD_RANKING_QUERIES.length,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          const reason =
            error instanceof Error
              ? error.message.slice(0, 100)
              : "provider_evaluation_failed";
          const model =
            responses[0]?.model ??
            (provider === "gemini"
              ? GEMINI_MODEL
              : process.env.GROQ_FREE_MODEL_ID || null);
          const availableResults = await evaluateAvailableProviderScores(
            provider,
            model,
            parsed
          );
          const quotaLimited = reason.startsWith("quota_or_rate_limited");
          results.push({
            provider,
            model,
            state: quotaLimited
              ? parsed.length > 0
                ? "partial_stopped_on_quota"
                : "stopped_on_quota"
              : inferenceRequests > 0
                ? "failed"
                : "blocked",
            reason,
            inferenceRequests,
            completedScoredQueries: parsed.length,
            hardQueriesCompleted: availableResults.completedHardQueries,
            queryWordingHoldoutCompleted:
              availableResults.completedHoldoutQueries,
            partialMetrics: availableResults.partialMetrics,
            requestLatencyP50Ms: percentile(
              responses.map(({ latencyMs }) => latencyMs),
              0.5
            ),
            requestLatencyP95Ms: percentile(
              responses.map(({ latencyMs }) => latencyMs),
              0.95
            ),
            inputTokens: responses.reduce(
              (total, item) => total + (item.inputTokens ?? 0),
              0
            ),
            outputTokens: responses.reduce(
              (total, item) => total + (item.outputTokens ?? 0),
              0
            ),
            providerReportedCostUsd: null,
            providerResponseLogged: false,
            durationMs: Date.now() - startedAt,
          });
        }
      }
      const report = {
        schemaVersion: 1,
        kind: "test_only_blackboard_provider_ranking_eval",
        evidenceClass: "live-free-tier-model-on-synthetic-hand-labeled-corpus",
        generatedAt: new Date().toISOString(),
        budget: {
          maxProviderRequests: MAX_PROVIDER_REQUESTS,
          maxCredentialAccessRetries: 3,
          maxOutputTokens: 2048,
          paidSpendLimitEnforcedUsd: null,
          freeTierApprovalRequired: true,
        },
        dataset: "space-blackboard-relevance-v1",
        noRelevanceLabelsSentToProviders: true,
        providers: results,
        limitations: [
          "The corpus has 16 synthetic shared-project cards and 12 hard hand-labeled queries (8 paraphrases, 4 multi-project); results are exploratory, not independently validated or representative of user traffic.",
          `Each provider receives up to 16 visible candidate cards for 12 original hard queries and 16 separately authored query-wording holdouts. The current blackboard.search operation is exercised with a test Decisions adapter that returns precomputed scores from this live batch for its bounded top five; the all-visible candidate-pool ablation uses the same pure reranking comparator. No live OpenRouter Decisions calls occur in this experiment. Provider use is capped at ${MAX_PROVIDER_REQUESTS} direct test-provider requests; schema-invalid output is split into smaller query groups and rate limits stop further calls.`,
          "The test uses Gemini and GroqCloud directly and does not alter or replace OpenRouter Decisions production routing.",
          "Provider billing receipts are unavailable in this test; cost is null and is not inferred from token usage.",
          "A free-tier flag is an operator assertion. The harness does not guarantee provider billing or remaining quota; it stops and records provider rate limits.",
        ],
      };
      await writeLiveReport(report);
      console.log(`blackboard_provider_ranking=${JSON.stringify(report)}`);
      expect(results).toHaveLength(2);
    },
    720_000
  );
});
