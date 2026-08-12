/**
 * What kind of failure was that, and can anything be done about it?
 *
 * An agent that only knows "the run failed" can do nothing useful with that. An agent that knows
 * "the model allowance is spent and resets on its own" versus "the payload was too big for the
 * context window" versus "a script threw" can pick a genuinely different response: wait, compact
 * and retry smaller, or escalate.
 *
 * Pure and DO-agnostic on purpose — the agent DO classifies at the moment of failure, and the
 * diagnostics rollup re-reads the stored classification later. Both need the same vocabulary, and
 * neither should have to re-derive it from free text.
 */

export type FailureKind =
  /** The account's model allowance is spent. Clears on its own when the window resets. */
  | "quota_exhausted"
  /** Too many requests right now. Clears on its own, sooner than a quota. */
  | "rate_limited"
  /** The payload exceeded the model's context window. */
  | "context_overflow"
  /** A Naelao-side cap stopped it: session ceiling, project wallet, credit balance. */
  | "budget_ceiling"
  /** The loop used every step without reaching an answer. */
  | "step_exhaustion"
  /** Parked waiting on a human decision. Not really a failure. */
  | "approval_pending"
  /** The configured model isn't reachable on this account's gateway. */
  | "model_unavailable"
  /** A script or tool call failed. */
  | "tool_error"
  /** Stopped deliberately, mid-run, by the person watching it — not a failure of any kind, and
   *  never something waiting or retrying can fix; only a human decides whether to continue. */
  | "user_cancelled"
  | "unknown";

export interface FailureClassification {
  kind: FailureKind;
  /** Waiting is likely to be enough — nothing to fix, just try again later. */
  clears_on_its_own: boolean;
  /** The agent can plausibly fix this itself: smaller scope, compaction, fewer steps, a different
   *  approach. Distinct from clears_on_its_own — a quota clears but can't be "fixed"; a context
   *  overflow never clears but can be. */
  agent_actionable: boolean;
  /** One line, safe to put in a wake-up brief. */
  summary: string;
}

interface Rule {
  kind: FailureKind;
  clears_on_its_own: boolean;
  agent_actionable: boolean;
  summary: string;
  patterns: RegExp[];
}

/**
 * Ordered — the first match wins, so the more specific patterns come first. A budget ceiling and a
 * provider quota both say "limit"; being told the wrong one sends the agent down the wrong path
 * (waiting for a reset that will never come, or asking the owner for money it doesn't need).
 */
const RULES: Rule[] = [
  {
    kind: "user_cancelled",
    clears_on_its_own: false,
    agent_actionable: false,
    summary: "You stopped this run. Continue picks up from where it left off — nothing is redone.",
    // The loop's own cancellation exit (script-engine/loop.ts) writes this exact string as
    // `result.error` — checked first, ahead of every other rule, since a run stopped mid-step can
    // otherwise carry incidental text (a half-finished tool call, a provider hiccup) that would
    // wrongly match a DIFFERENT rule below and tell the person to just wait, when what actually
    // happened is that THEY stopped it.
    patterns: [/^stopped by you\b/i],
  },
  {
    kind: "budget_ceiling",
    clears_on_its_own: false,
    agent_actionable: false,
    summary: "A spend cap on this space stopped the run — the owner controls this, not the model provider.",
    patterns: [
      /session_budget_ceiling/i,
      /insufficient_credits/i,
      /project_wallet/i,
      /spend[_ ]cap/i,
      /credit balance/i,
      /\bquota_exceeded\b/i,
      /infra_quota_exceeded/i,
    ],
  },
  {
    kind: "quota_exhausted",
    clears_on_its_own: true,
    agent_actionable: false,
    summary: "The account's model allowance is spent for now. It resets on its own — work can resume then.",
    patterns: [
      // Workers AI's own out-of-allowance code, seen live when the free neuron budget runs out.
      /\b4006\b/,
      /out of credits/i,
      /neuron/i,
      /daily limit/i,
      /usage limit/i,
      /allowance/i,
      /billing (?:hard )?limit/i,
    ],
  },
  {
    kind: "rate_limited",
    clears_on_its_own: true,
    agent_actionable: false,
    summary: "Too many requests in a short window. This clears by itself within minutes.",
    patterns: [/rate[_ ]?limit/i, /too many requests/i, /\b429\b/],
  },
  {
    kind: "context_overflow",
    clears_on_its_own: false,
    agent_actionable: true,
    summary: "The request was larger than the model's context window. Compacting or splitting the work fixes this.",
    patterns: [
      /context[_ ](?:window|length|limit)/i,
      /maximum context/i,
      /too many tokens/i,
      /prompt is too long/i,
      /exceeds? .{0,20}token/i,
    ],
  },
  {
    kind: "model_unavailable",
    clears_on_its_own: false,
    agent_actionable: false,
    summary: "The configured model isn't reachable on this account. It needs to be changed in settings.",
    patterns: [/model not found/i, /no such model/i, /invalid provider/i, /model_unavailable/i],
  },
  {
    kind: "step_exhaustion",
    clears_on_its_own: false,
    agent_actionable: true,
    summary: "The run used every step without reaching an answer. Narrower goals, or fewer tools per run, get further.",
    // "no terminal action" is the loop's own wording for a model that spent its turns without
    // ever choosing answer/give_up — the same situation as running out of steps, and equally
    // fixable by narrowing the goal. Seen live; it was landing in `unknown`, which told the
    // assistant it had less to work with than it actually did.
    patterns: [/without reaching an answer/i, /step[_ ]exhaust/i, /max[_ ]?steps/i, /no terminal action/i],
  },
  {
    kind: "approval_pending",
    clears_on_its_own: false,
    agent_actionable: false,
    summary: "Parked waiting on the owner's approval. Nothing is broken — it needs a person.",
    patterns: [/pending[_ ]approval/i, /awaiting[_ ]approval/i, /requires approval/i],
  },
  {
    kind: "tool_error",
    clears_on_its_own: false,
    agent_actionable: true,
    summary: "A script or tool call failed. The script itself is worth reading before retrying.",
    // Matched explicitly below rather than by pattern order — a tool error's text is
    // shape-based ("name.op failed"), not keyword-based, and would otherwise swallow more
    // specific matches that happen to name a tool.
    patterns: [],
  },
  {
    kind: "unknown",
    clears_on_its_own: false,
    agent_actionable: true,
    summary: "The cause isn't recognised. Worth reading the error and the run's own steps before retrying.",
    patterns: [],
  },
];

const BY_KIND = new Map<FailureKind, Rule>(RULES.map((r) => [r.kind, r]));

/**
 * The only kinds that stay trustworthy when the text came from the model itself: each is a fact
 * about THIS run that the loop stamps in its own wording (the user pressed Stop; the run is
 * parked on a human decision), not the model's read on external conditions.
 */
const MODEL_ORIGIN_STRUCTURAL_KINDS: FailureKind[] = ["user_cancelled", "approval_pending"];

/**
 * Classify a failure from whatever text was surfaced, plus an HTTP status when there is one.
 *
 * Deliberately conservative: anything unrecognised is `unknown` with `agent_actionable: true`,
 * because an agent that investigates an unfamiliar error is more useful than one that assumes it
 * is powerless. Never guesses `quota_exhausted` — telling an agent to "just wait" for something
 * that will never clear on its own is the one wrong answer that costs real time.
 */
export function classifyFailure(
  error: string | null | undefined,
  status?: number,
  origin?: "model" | "infrastructure"
): FailureClassification {
  const text = String(error ?? "");

  // A model's own give_up reason is a DESCRIPTION of a situation, never evidence of one. Pattern
  // matching it produced a self-reinforcing paralysis loop, observed live: a give_up that merely
  // mentioned running out of allowance was classified `quota_exhausted` ("clears on its own, do
  // not retry"), the next wake-up's brief relayed that as the agent's present state, so it gave
  // up again — and that give_up classified the same way. The business stayed frozen on a
  // provider that had never run out of anything. Whatever the model says, the fact it reached
  // this point at all means the reasoning call SUCCEEDED, so no self-clearing capacity failure
  // can be in effect right now. Classify as actionable and let it be investigated.
  //
  // Structural markers the loop itself writes (cancellation, an approval it is parked on) are
  // still honoured — those are facts about the run, not the model's opinion about the world.
  if (origin === "model") {
    const trimmedModelText = text.trim();
    if (isFailureKind(trimmedModelText)) return toClassification(BY_KIND.get(trimmedModelText)!);
    for (const kind of MODEL_ORIGIN_STRUCTURAL_KINDS) {
      const rule = BY_KIND.get(kind)!;
      if (rule.patterns.some((p) => p.test(text))) return toClassification(rule);
    }
    return toClassification(BY_KIND.get("unknown")!);
  }

  // Already a kind name. The diagnostics rollup stores the classification and later re-reads it
  // to answer "can the agent do anything about this?" — without this, a stored 'quota_exhausted'
  // came back as 'unknown' and every piece of guidance derived from it was wrong. Caught by the
  // round-trip test, not by anything the pattern list alone would have shown.
  const trimmed = text.trim();
  if (isFailureKind(trimmed)) {
    return toClassification(BY_KIND.get(trimmed)!);
  }

  if (status === 429) {
    const rule = RULES.find((r) => r.kind === "rate_limited")!;
    return toClassification(rule);
  }
  if (status === 402) {
    const rule = RULES.find((r) => r.kind === "budget_ceiling")!;
    return toClassification(rule);
  }

  if (text.trim()) {
    for (const rule of RULES) {
      if (rule.patterns.some((p) => p.test(text))) return toClassification(rule);
    }
  }

  // A tool failure usually names the tool. Distinguishing it from a bare unknown is worth one
  // more check: it tells the agent to look at the script, not at the platform.
  if (/^[a-z0-9_-]+\.[a-z0-9_]+ (?:failed|threw|errored)/i.test(text) || /script .{0,40}failed/i.test(text)) {
    return toClassification(BY_KIND.get("tool_error")!);
  }

  return toClassification(BY_KIND.get("unknown")!);
}

function toClassification(rule: Rule): FailureClassification {
  return {
    kind: rule.kind,
    clears_on_its_own: rule.clears_on_its_own,
    agent_actionable: rule.agent_actionable,
    summary: rule.summary,
  };
}

/** Every kind, for a UI or a rollup that wants to enumerate them without hardcoding the list. */
export const FAILURE_KINDS: FailureKind[] = [
  "quota_exhausted",
  "rate_limited",
  "context_overflow",
  "budget_ceiling",
  "step_exhaustion",
  "approval_pending",
  "model_unavailable",
  "tool_error",
  "user_cancelled",
  "unknown",
];

export function isFailureKind(value: unknown): value is FailureKind {
  return typeof value === "string" && (FAILURE_KINDS as string[]).includes(value);
}
