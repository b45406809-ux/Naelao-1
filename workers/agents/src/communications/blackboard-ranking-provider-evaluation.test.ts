import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { PrebuiltOpContext } from "../script-engine/prebuilt/index.js";
import { spaceBlackboard } from "../script-engine/prebuilt/space-blackboard.js";
import type { SharedProjectCard } from "./blackboard-domain.js";
import { evaluateBlackboardRankings } from "./blackboard-ranking-evaluation.js";
import {
  blackboardRankingCards,
  blackboardRankingQueries,
} from "./blackboard-ranking-fixtures.js";
import {
  asBlackboardRankingCases,
  buildBlackboardRankingPrompt,
  getBlackboardCandidateSets,
  parseBlackboardRankingScores,
} from "./blackboard-ranking-provider-evaluation.js";

const LIVE_ENABLED = process.env.NAELAO_RUN_LIVE_BLACKBOARD_RANKING === "true";
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const PROVIDER_TIMEOUT_MS = 20_000;

function expectedCandidates(): Map<string, Set<string>> {
  return getBlackboardCandidateSets(blackboardRankingCards);
}

function classifyFailure(status: number): string {
  if (status === 429) return "quota_or_rate_limited";
  if (status === 401 || status === 403) return "credential_or_access_denied";
  if (status >= 500) return "provider_unavailable";
  return "provider_error";
}

async function requestModelScores(provider: "gemini" | "groqcloud"): Promise<{
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

  const prompt = buildBlackboardRankingPrompt();
  let rejectedCredentialAttempts = 0;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (!key) throw new Error("provider_secret_missing");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    const started = performance.now();
    try {
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
        /^(quota_or_rate_limited|credential_or_access_denied|provider_unavailable|provider_error):\d+$/.test(
          error.message
        )
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
  scores: ReturnType<typeof parseBlackboardRankingScores>
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
  for (const query of blackboardRankingQueries) {
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
  const result = evaluateBlackboardRankings(
    asBlackboardRankingCases(orders, cards),
    { k: 5, seed: 0x4242, bootstrapSamples: 5000 }
  );
  return result;
}

async function writeLiveReport(report: unknown): Promise<void> {
  const path = process.env.NAELAO_LIVE_BLACKBOARD_REPORT;
  if (!path) return;
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

describe("blackboard provider ranking evaluation harness", () => {
  it("keeps the scoring prompt free of relevance labels and bounds model candidates", () => {
    const prompt = buildBlackboardRankingPrompt();
    expect(prompt).toContain('"queryId":"customs-classification"');
    expect(prompt).not.toContain("relevantProjectIds");
    expect(prompt).not.toContain("labelOracleCeiling");
    for (const candidateSet of expectedCandidates().values())
      expect(candidateSet.size).toBeLessThanOrEqual(5);
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
  });

  it.skipIf(!LIVE_ENABLED)(
    "runs one bounded free-tier ranking call per approved test provider",
    async () => {
      const providers = ["gemini", "groqcloud"] as const;
      const results: Array<Record<string, unknown>> = [];
      for (const provider of providers) {
        const enabled =
          process.env[
            `NAELAO_BLACKBOARD_${provider === "gemini" ? "GEMINI" : "GROQ"}_ALLOWED`
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
          const response = await requestModelScores(provider);
          const candidateSets = expectedCandidates();
          const parsed = parseBlackboardRankingScores(
            response.raw,
            candidateSets
          );
          const result = await evaluateProductionReranker(
            provider,
            response.model,
            parsed
          );
          results.push({
            provider,
            model: response.model,
            state: "completed",
            inferenceRequests: 1,
            latencyMs: response.latencyMs,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            keySlot: response.keySlot,
            rejectedCredentialAttempts: response.rejectedCredentialAttempts,
            providerReportedCostUsd: null,
            measuredCostUsd: null,
            baseline: result.baseline,
            modelCandidate: result.candidate,
            pairedDelta: result.pairedDelta,
            queries: blackboardRankingQueries.length,
            cards: blackboardRankingCards.length,
            candidatesPerQueryMaximum: 5,
            searchQueriesEvaluated: blackboardRankingQueries.length,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          const reason =
            error instanceof Error
              ? error.message.slice(0, 100)
              : "provider_evaluation_failed";
          const preflightBlocked = [
            "provider_not_eligible_from_prior_smoke",
            "provider_secret_missing",
            "free_tier_not_confirmed",
            "approved_free_model_not_configured",
          ].includes(reason);
          results.push({
            provider,
            model:
              provider === "gemini"
                ? GEMINI_MODEL
                : process.env.GROQ_FREE_MODEL_ID || null,
            state: "blocked",
            reason,
            inferenceRequests: preflightBlocked
              ? 0
              : reason.startsWith("blackboard_provider_") ||
                  reason === "provider_response_content_missing"
                ? 1
                : null,
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
          maxSuccessfulInferenceRequestsPerProvider: 1,
          maxCredentialAccessRetries: 3,
          maxOutputTokens: 2048,
          paidSpendLimitEnforcedUsd: null,
          freeTierApprovalRequired: true,
        },
        dataset: "space-blackboard-relevance-v1",
        noRelevanceLabelsSentToProviders: true,
        providers: results,
        limitations: [
          "The corpus contains 28 synthetic hand-labeled queries and 16 synthetic cards; results are exploratory, not independently validated or representative of user traffic.",
          "The model scores are supplied to the same bounded production blackboard reranker; provider usage and latency are from one batched API request per eligible provider.",
          "The test uses Gemini and GroqCloud directly and does not alter or replace OpenRouter Decisions production routing.",
          "Provider billing receipts are unavailable in this test; cost is null and is not inferred from token usage.",
          "A free-tier flag is an operator assertion. The harness does not guarantee provider billing or remaining quota; it stops and records provider rate limits.",
        ],
      };
      await writeLiveReport(report);
      console.log(`blackboard_provider_ranking=${JSON.stringify(report)}`);
      expect(results).toHaveLength(2);
    }
  );
});
