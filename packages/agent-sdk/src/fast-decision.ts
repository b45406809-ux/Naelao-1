/** Typed, text-free System One decisions shared by deterministic policy and model providers. */
export type FastDecisionProvider = "deterministic" | "jev" | "laya" | "clef";

export interface FastDecisionMeta {
  provider: FastDecisionProvider;
  policyCode: string;
  confidence?: number;
  model?: string;
  latencyMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ChoiceDecision<T extends string> extends FastDecisionMeta {
  kind: "choice";
  value: T;
  probabilities?: Readonly<Record<T, number>>;
}

export interface ScoreDecision extends FastDecisionMeta {
  kind: "score";
  value: number;
  probabilities?: Readonly<Record<string, number>>;
}

export interface NoulDecision extends FastDecisionMeta {
  kind: "noul";
  value: boolean;
  probability?: number;
}

export type FastDecision<T extends string = string> = ChoiceDecision<T> | ScoreDecision | NoulDecision;

export function deterministicChoice<T extends string>(value: T, policyCode: string): ChoiceDecision<T> {
  return Object.freeze({ kind: "choice", value, provider: "deterministic", policyCode });
}

export function deterministicScore(value: number, policyCode: string): ScoreDecision {
  if (!Number.isFinite(value)) throw new Error("fast_decision_score_must_be_finite");
  return Object.freeze({ kind: "score", value, provider: "deterministic", policyCode });
}

export function deterministicNoul(value: boolean, policyCode: string): NoulDecision {
  return Object.freeze({ kind: "noul", value, provider: "deterministic", policyCode });
}

export type SystemOneState = string | Record<string, unknown> | readonly unknown[];
export type SystemOneInstructions = string | Record<string, unknown> | readonly unknown[];

export interface FastDecisionGateway {
  choice<T extends string>(input: { state: SystemOneState; instructions: SystemOneInstructions; criteria: Readonly<Record<T, SystemOneInstructions | null>>; policyCode: string }): Promise<ChoiceDecision<T>>;
  score(input: { state: SystemOneState; instructions: SystemOneInstructions; criteria: readonly SystemOneInstructions[]; policyCode: string }): Promise<ScoreDecision>;
  noul(input: { state: SystemOneState; instructions: SystemOneInstructions; criteria?: { true?: SystemOneInstructions; false?: SystemOneInstructions }; policyCode: string; threshold?: number }): Promise<NoulDecision>;
  /** Optional single-pass runtime prediction. Implementations must return false on uncertainty. */
  preflightRuntime?(state: SystemOneState): Promise<{ needsContainer: boolean; needsBrowser: boolean; confidence: number } | undefined>;
}

export interface SystemOneClientOptions {
  /** Exact Jev-compatible endpoint. Laya uses the same `/v1/systemone` wire contract. */
  endpoint?: string;
  apiKey?: string;
  model?: string;
  provider?: "jev" | "laya" | "clef";
  /** Workers AI Clef binding. Supplied only for an explicitly selected cloud route. */
  runClef?: (model: string, input: Record<string, unknown>) => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  onDecision?: (event: {
  provider: "jev" | "laya" | "clef";
    policyCode: string;
    model: string;
    latencyMs: number;
    usage: { inputTokens: number; outputTokens: number };
  }) => void;
}

type SystemOneAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number };

interface SystemOneResponse {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

const DEFAULT_JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

function boundedProbability(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`system_one_invalid_${field}`);
  return value;
}

function probabilities(value: unknown, allowed?: ReadonlySet<string>): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("system_one_invalid_probabilities");
  const result: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    if (allowed && !allowed.has(key)) throw new Error("system_one_unexpected_probability_key");
    result[key] = boundedProbability(probability, "probability");
  }
  if (allowed && [...allowed].some((key) => !(key in result))) throw new Error("system_one_missing_probability_key");
  const sum = Object.values(result).reduce((total, probability) => total + probability, 0);
  if (Object.keys(result).length === 0 || Math.abs(sum - 1) > 0.02) throw new Error("system_one_invalid_probability_sum");
  return result;
}

function usage(value: unknown): { inputTokens: number; outputTokens: number } {
  const raw = value as { input_tokens?: unknown; output_tokens?: unknown } | null;
  if (!Number.isSafeInteger(raw?.input_tokens) || (raw!.input_tokens as number) < 0 || !Number.isSafeInteger(raw?.output_tokens) || (raw!.output_tokens as number) < 0) throw new Error("system_one_invalid_usage");
  return { inputTokens: raw!.input_tokens as number, outputTokens: raw!.output_tokens as number };
}

/** Strict client for the official Jev endpoint and Laya's compatible self-hosted server. */
export class SystemOneDecisionClient implements FastDecisionGateway {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly provider: "jev" | "laya" | "clef";
  private readonly runClef: SystemOneClientOptions["runClef"];
  private readonly fetcher: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly onDecision: SystemOneClientOptions["onDecision"];

  constructor(options: SystemOneClientOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_JEV_ENDPOINT;
    this.apiKey = options.apiKey;
    this.model = options.model ?? (options.provider === "clef" ? "@cf/cloudflare/clef-flash" : "jev-latest");
    this.provider = options.provider ?? "jev";
    this.runClef = options.runClef;
    if (this.provider === "clef" && !this.runClef) throw new Error("system_one_clef_binding_required");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.onDecision = options.onDecision;
  }

  private observe(policyCode: string, meta: Omit<FastDecisionMeta, "policyCode">): void {
    if (!this.onDecision || !meta.model || meta.latencyMs === undefined || !meta.usage || meta.provider === "deterministic") return;
    this.onDecision({ provider: meta.provider, policyCode, model: meta.model, latencyMs: meta.latencyMs, usage: meta.usage });
  }

  private async request(question: Record<string, unknown>, state: SystemOneState): Promise<{ answer: SystemOneAnswer; meta: Omit<FastDecisionMeta, "policyCode"> }> {
    const started = Date.now();
    if (this.provider === "clef") {
      const result = await this.runClef!(this.model, {
        model: this.model.replace(/^@cf\/cloudflare\//, ""),
        state,
        questions: { decision: question },
      }) as { answers?: Record<string, unknown>; usage?: unknown };
      const answer = result?.answers?.["decision"] as SystemOneAnswer | undefined;
      if (!answer || typeof answer !== "object") throw new Error("system_one_missing_answer");
      const usageMeta = result.usage === undefined ? {} : { usage: usage(result.usage) };
      return { answer, meta: { provider: "clef", model: this.model, latencyMs: Date.now() - started, ...usageMeta } };
    }
    let response: Response | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, state, questions: { decision: question } }),
      });
      if (response.ok || ![429, 529, 503].includes(response.status) || attempt === this.maxRetries) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1_000)));
    }
    if (!response?.ok) {
      const detail = await response?.text().catch(() => "");
      throw new Error(`system_one_http_${response?.status ?? "network"}${detail ? `:${detail.slice(0, 200)}` : ""}`);
    }
    const payload = await response.json() as Partial<SystemOneResponse>;
    if (typeof payload.model !== "string" || !payload.answers || typeof payload.answers !== "object") throw new Error("system_one_invalid_response");
    const answer = payload.answers["decision"];
    if (!answer || typeof answer !== "object") throw new Error("system_one_missing_answer");
    return { answer, meta: { provider: this.provider, model: payload.model, latencyMs: Date.now() - started, usage: usage(payload.usage) } };
  }

  async choice<T extends string>(input: { state: SystemOneState; instructions: SystemOneInstructions; criteria: Readonly<Record<T, SystemOneInstructions | null>>; policyCode: string }): Promise<ChoiceDecision<T>> {
    const allowed = new Set(Object.keys(input.criteria));
    if (allowed.size < 2 || allowed.size > 255) throw new Error("system_one_choice_requires_2_to_255_options");
    const { answer, meta } = await this.request({ type: "choice", instructions: input.instructions, criteria: input.criteria }, input.state);
    if (answer.type !== "choice" || !allowed.has(answer.choice)) throw new Error("system_one_invalid_choice_answer");
    this.observe(input.policyCode, meta);
    return Object.freeze({ kind: "choice", value: answer.choice as T, probabilities: probabilities(answer.probabilities, allowed) as Record<T, number>, confidence: boundedProbability(answer.confidence, "confidence"), policyCode: input.policyCode, ...meta });
  }

  async score(input: { state: SystemOneState; instructions: SystemOneInstructions; criteria: readonly SystemOneInstructions[]; policyCode: string }): Promise<ScoreDecision> {
    if (input.criteria.length < 2 || input.criteria.length > 10) throw new Error("system_one_score_requires_2_to_10_levels");
    const { answer, meta } = await this.request({ type: "score", instructions: input.instructions, criteria: input.criteria }, input.state);
    if (answer.type !== "score" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > input.criteria.length - 1) throw new Error("system_one_invalid_score_answer");
    const levels = new Set(input.criteria.map((_, index) => String(index)));
    if (!answer.legend || typeof answer.legend !== "object" || [...levels].some((level) => typeof answer.legend[level] !== "string")) throw new Error("system_one_invalid_score_legend");
    this.observe(input.policyCode, meta);
    return Object.freeze({ kind: "score", value: answer.score, probabilities: probabilities(answer.probabilities, levels), confidence: boundedProbability(answer.confidence, "confidence"), policyCode: input.policyCode, ...meta });
  }

  async noul(input: { state: SystemOneState; instructions: SystemOneInstructions; criteria?: { true?: SystemOneInstructions; false?: SystemOneInstructions }; policyCode: string; threshold?: number }): Promise<NoulDecision> {
    const threshold = input.threshold ?? 0.5;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("system_one_invalid_threshold");
    const { answer, meta } = await this.request({ type: "noul", instructions: input.instructions, ...(input.criteria ? { criteria: input.criteria } : {}) }, input.state);
    if (answer.type !== "noul") throw new Error("system_one_invalid_noul_answer");
    const probability = boundedProbability(answer.noul, "noul");
    this.observe(input.policyCode, meta);
    return Object.freeze({ kind: "noul", value: probability >= threshold, probability, confidence: Math.max(probability, 1 - probability), policyCode: input.policyCode, ...meta });
  }

  /** One Clef forward pass predicts whether the current prompt may need expensive runtimes. */
  async preflightRuntime(state: SystemOneState): Promise<{ needsContainer: boolean; needsBrowser: boolean; confidence: number } | undefined> {
    if (this.provider !== "clef") return undefined;
    const result = await this.runClef!(this.model, {
      model: this.model.replace(/^@cf\/cloudflare\//, ""),
      state,
      questions: {
        needsContainer: { type: "noul", instructions: "Could completing this task require executing shell commands, native builds, package installation, or a Linux container?" },
        needsBrowser: { type: "noul", instructions: "Could completing this task require navigating a website or interacting with a browser?" },
      },
    }) as { answers?: Record<string, unknown> };
    const answers = result?.answers;
    const container = answers?.["needsContainer"] as { noul?: unknown } | undefined;
    const browser = answers?.["needsBrowser"] as { noul?: unknown } | undefined;
    const containerProbability = boundedProbability(container?.noul, "noul");
    const browserProbability = boundedProbability(browser?.noul, "noul");
    return {
      needsContainer: containerProbability >= 0.8,
      needsBrowser: browserProbability >= 0.8,
      confidence: Math.max(containerProbability, 1 - containerProbability, browserProbability, 1 - browserProbability),
    };
  }
}
