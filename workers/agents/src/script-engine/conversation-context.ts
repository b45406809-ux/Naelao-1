/**
 * Conversation context — what the model actually knows about the thread it's replying in.
 *
 * The gap this closes
 * -------------------
 * The script-native reasoner's payload was rebuilt fresh on every turn from a fingerprint
 * snapshot, a candidate list, and this run's own steps. It contained NO conversation history at
 * all. So the agent could not answer "what did we decide earlier?", could not resolve "do that
 * again", and would happily re-ask something the user had already told it two messages ago. The
 * context-usage meter, meanwhile, measured the stored transcript — a transcript the model was
 * never given.
 *
 * This module is the bridge: it turns a session's stored messages into a bounded context block
 * the reasoner can carry, and it decides what to do when that history no longer fits.
 *
 * Compaction, and why the model is told about it
 * ----------------------------------------------
 * When history exceeds its budget, older messages are replaced by a summary and the context is
 * flagged `compacted: true`. Claude Code's own compaction has a well-known failure mode: after a
 * compact the assistant behaves as if anything not captured in the summary never happened, and
 * answers confidently from a partial record. That is worse than admitting the gap.
 *
 * So compaction here is explicit rather than silent. The model is told, in its instructions, that
 * (a) this history is compacted, (b) detail is therefore missing, and (c) there is a tool that
 * searches the FULL uncompacted transcript. An assumption about something not in the summary is a
 * cue to search, not to guess.
 *
 * Pure by design: no storage, no clock, no network — the budgeting and truncation edge cases are
 * where the bugs live, and they should be testable without a DO.
 */

export interface ConversationMessage {
  role: string;
  content: string;
  created_at?: string | undefined;
}

/** The bounded view of a conversation handed to the reasoner. */
export interface ConversationContext {
  /** Most recent messages, oldest first, that fit the budget. */
  recent: ConversationMessage[];
  /** Prose summary of everything older than `recent`. Empty when nothing was dropped. */
  summary: string;
  /** True when older messages were dropped — the model is told this explicitly. */
  compacted: boolean;
  /** How many messages exist in total, so "5 of 340" is expressible. */
  totalMessages: number;
  /** How many were folded away into `summary`. */
  omittedMessages: number;
}

export interface ConversationLimits {
  /** Token budget for the conversation block of the reasoner payload. */
  maxTokens: number;
  /** Never carry more than this many messages regardless of budget — a long tail of tiny
   *  messages is still noise, and each one costs structure tokens in the JSON payload. */
  maxMessages: number;
  /** Single messages longer than this are truncated rather than allowed to evict the rest of
   *  the conversation on their own. */
  maxMessageChars: number;
}

export const DEFAULT_CONVERSATION_LIMITS: ConversationLimits = {
  // Deliberately modest. The reasoner payload also carries the observation snapshot, candidate
  // scripts and this run's steps; conversation is context, not the whole budget. It is also sized
  // to stay usable on the small-context models this platform actually runs on today (a 24k-token
  // window, not a 200k one).
  maxTokens: 3000,
  maxMessages: 30,
  maxMessageChars: 2000,
};

export const COMPACTION_TURN_THRESHOLD = 25;
export const COMPACTION_TOKEN_RATIO_THRESHOLD = 0.8;
export const COMPACTION_RECENT_TURNS = 6;
export const COMPACTION_NOTICE =
  "Context COMPACTED: earlier conversation history was compacted into PROJECT.md. Missing details do not mean events never happened. Do not guess; use `conversation.search` to inspect archived messages.";

export interface ConversationScope {
  spaceId: string;
  projectId: string;
  threadId: string;
}

/** Fail closed unless every transcript row belongs to the active structural thread scope. */
export function isolateThreadMessages<T extends ConversationMessage & Partial<ConversationScope>>(
  messages: T[],
  scope: ConversationScope
): ConversationMessage[] {
  return messages.filter((message) =>
    message.spaceId === scope.spaceId &&
    message.projectId === scope.projectId &&
    message.threadId === scope.threadId
  );
}

export function shouldCompactContext(threadTurns: number, tokenUsageRatio: number): boolean {
  return threadTurns >= COMPACTION_TURN_THRESHOLD || tokenUsageRatio >= COMPACTION_TOKEN_RATIO_THRESHOLD;
}

export function splitForCompaction(messages: ConversationMessage[], recentTurns = COMPACTION_RECENT_TURNS): {
  archive: ConversationMessage[];
  recent: ConversationMessage[];
} {
  const keep = Math.max(0, recentTurns * 2);
  const split = Math.max(0, messages.length - keep);
  return { archive: messages.slice(0, split), recent: messages.slice(split) };
}

/** Rough token estimate. chars/4 is the convention already used elsewhere in this codebase for
 *  budgeting; it is an estimate for sizing, never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.85);
}

function truncateMessage(m: ConversationMessage, maxChars: number): ConversationMessage {
  if (m.content.length <= maxChars) return m;
  return {
    ...m,
    // Say it was cut. A silently truncated message reads as a complete one that simply ended
    // oddly, which is exactly the kind of thing a model will confidently misinterpret.
    content: `${m.content.slice(0, maxChars)}… [truncated, ${m.content.length - maxChars} more characters — search the full history if this matters]`,
  };
}

/**
 * Select the most recent messages that fit the budget.
 *
 * Walks backwards from the newest so the recent past is always what survives — a conversation
 * where the last thing the user said got evicted would be actively harmful.
 */
export function buildConversationContext(
  messages: ConversationMessage[],
  summary = "",
  limits: ConversationLimits = DEFAULT_CONVERSATION_LIMITS
): ConversationContext {
  const all = Array.isArray(messages) ? messages.filter((m) => m && typeof m.content === "string") : [];
  const recent: ConversationMessage[] = [];
  let used = estimateTokens(summary);

  for (let i = all.length - 1; i >= 0; i--) {
    if (recent.length >= limits.maxMessages) break;
    const m = truncateMessage(all[i]!, limits.maxMessageChars);
    const cost = estimateTokens(m.content) + 8; // + rough per-message structural overhead
    if (used + cost > limits.maxTokens && recent.length > 0) break;
    recent.unshift(m);
    used += cost;
  }

  const omitted = all.length - recent.length;
  return {
    recent,
    summary: summary.trim(),
    // Compacted means "you are not seeing everything", whether or not a summary exists yet.
    compacted: omitted > 0,
    totalMessages: all.length,
    omittedMessages: omitted,
  };
}

/** Whether the conversation has grown enough that older messages should be summarised into a
 *  durable record rather than simply dropped on each turn. */
export function needsSummarization(
  messages: ConversationMessage[],
  limits: ConversationLimits = DEFAULT_CONVERSATION_LIMITS
): boolean {
  const ctx = buildConversationContext(messages, "", limits);
  return ctx.omittedMessages > 0;
}

/** The messages that fall outside the recent window — the ones a summary needs to cover. */
export function messagesToSummarize(
  messages: ConversationMessage[],
  limits: ConversationLimits = DEFAULT_CONVERSATION_LIMITS
): ConversationMessage[] {
  const ctx = buildConversationContext(messages, "", limits);
  return ctx.omittedMessages > 0 ? messages.slice(0, ctx.omittedMessages) : [];
}

/** Build the summarisation prompt. Kept here so the wording is testable and lives next to the
 *  rules it has to satisfy. */
export function buildSummaryPrompt(older: ConversationMessage[], existingSummary: string): string {
  const transcript = older
    .map((m) => `${m.role}: ${m.content.slice(0, 1500)}`)
    .join("\n");
  return [
    "You are compacting the earlier part of a conversation so an assistant can keep working.",
    "Rewrite the SUMMARY so it absorbs the OLDER MESSAGES below.",
    "",
    "Keep, above all else:",
    "- decisions made and instructions the user gave (these are commitments, not chatter)",
    "- concrete facts: names, files, amounts, dates, identifiers",
    "- anything still open or unresolved",
    "- the user's stated preferences and constraints",
    "Drop: pleasantries, repetition, and reasoning that led nowhere.",
    "Do not invent anything. Write plainly, under 300 words.",
    "",
    `SUMMARY:\n${existingSummary || "(none yet)"}`,
    "",
    `OLDER MESSAGES:\n${transcript}`,
  ].join("\n");
}

/** Render the context into the shape the reasoner payload carries. Separated from the payload
 *  builder so the "you are missing detail" framing is asserted in tests rather than buried. */
export function renderConversationForReasoner(ctx: ConversationContext): Record<string, unknown> {
  return {
    compacted: ctx.compacted,
    total_messages: ctx.totalMessages,
    omitted_messages: ctx.omittedMessages,
    ...(ctx.summary ? { earlier_summary: ctx.summary } : {}),
    recent_messages: ctx.recent.map((m) => ({ role: m.role, content: m.content })),
    ...(ctx.compacted
      ? {
          // Stated in the payload itself, not only in the system prompt: the model reads this
          // block right next to the history it is about to reason over.
          notice: COMPACTION_NOTICE,
        }
      : {}),
  };
}
