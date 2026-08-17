/**
 * conversation — search the FULL uncompacted transcript of the thread you are in.
 *
 * The counterpart to compaction. When a conversation outgrows its budget the reasoner sees a
 * summary plus recent messages, and is told so. This is what it does about it.
 *
 * Claude Code's compaction has a well-known failure mode: after a compact the assistant treats
 * anything absent from the summary as though it never happened, and answers confidently from a
 * partial record. The fix is not a better summary — no summary survives every future question —
 * it is giving the model a way to go and look, plus instructions that say to look rather than
 * guess. This prebuilt is the "go and look" half.
 *
 * Retrieval is keyword-scored over the stored messages rather than semantic. That is a deliberate
 * limit, not an oversight: the messages are held in SpaceDO, not in an R2 bucket, so Cloudflare AI
 * Search (which indexes R2 objects on a batch cadence) cannot see them, and a just-sent message
 * must be findable immediately — a reindex delay would break the exact case this exists for. If a
 * semantic index over transcripts is ever wanted it belongs behind this same op, so the model's
 * contract does not change.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";

interface StoredMessage {
  id?: string;
  role: string;
  content: string;
  created_at?: string;
}

/** Tokens worth matching on: drops the filler words that would otherwise match everything. */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "of", "to", "in", "on", "at", "for",
  "with", "was", "were", "is", "are", "be", "been", "it", "this", "that", "what", "when", "did",
  "do", "does", "you", "i", "we", "my", "me", "about", "said", "say", "tell", "have", "has",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/** Score a message against the query. Exported for tests — the ranking is the whole product
 *  here, and it should be assertable without standing up a DO and a spaces worker. */
export function scoreMessage(message: StoredMessage, queryTokens: string[]): number {
  // Filter here as well as in tokenize(): the guarantee that filler words cannot manufacture a
  // match should hold for any caller, not only one that remembered to tokenize first. Without
  // this, a query like "what did we say about the thing" scores against every message in the
  // conversation and the ranking becomes meaningless.
  const tokens = queryTokens.filter((t) => t.length > 2 && !STOP_WORDS.has(t.toLowerCase()));
  if (tokens.length === 0) return 0;
  const haystack = message.content.toLowerCase();
  const bodyTokens = new Set(tokenize(message.content));
  let score = 0;
  for (const q of tokens) {
    // Whole-token match is the strong signal; a substring hit still counts, so "invoice" finds
    // "invoices" without needing a stemmer. It does NOT catch every inflection ("invoicing" does
    // not contain "invoice") — a real stemmer is the fix if that ever matters.
    if (bodyTokens.has(q)) score += 2;
    else if (haystack.includes(q)) score += 1;
  }
  // Normalise by query length so a 2-word and a 6-word query produce comparable scores.
  return score / (tokens.length * 2);
}

function snippet(content: string, queryTokens: string[], radius = 160): string {
  const lower = content.toLowerCase();
  let idx = -1;
  for (const q of queryTokens) {
    const at = lower.indexOf(q);
    if (at !== -1 && (idx === -1 || at < idx)) idx = at;
  }
  if (idx === -1) return content.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + radius);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

async function loadMessages(ctx: PrebuiltOpContext, sessionId: string): Promise<StoredMessage[]> {
  if (!ctx.env.spacesWorker) return [];
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(
      `http://spaces-worker/spaces/${encodeURIComponent(ctx.env.spaceId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      { headers: { "x-naelao-tenant-id": ctx.env.tenantId, "x-naelao-internal-token": token } }
    )
  );
  if (!resp.ok) return [];
  const body = (await resp.json()) as { data?: StoredMessage[]; messages?: StoredMessage[] };
  return body.data ?? body.messages ?? [];
}

export const conversation: PrebuiltScript = {
  name: "conversation",
  description:
    "Search the full, uncompacted transcript of the current conversation. Use this whenever the user refers to something that isn't in your recent messages or summary — the earlier part of a long conversation is compacted away, and this is how you look it up instead of guessing.",
  domain: "knowledge",
  requires_tier: 1,
  operations: {
    async "conversation.search"(args, ctx) {
      const query = String(args["query"] ?? args["text"] ?? "").trim();
      if (!query) throw new Error("conversation.search requires 'query' — what are you looking for?");
      const sessionId = String(args["session_id"] ?? "").trim();
      if (!sessionId) {
        return {
          ok: false,
          reason:
            "conversation.search needs 'session_id' — the id of the thread to search. It is in your goal context; pass it through.",
        };
      }
      const limit = Math.min(Number(args["limit"] ?? 5) || 5, 20);

      const messages = await loadMessages(ctx, sessionId);
      if (messages.length === 0) {
        return { ok: true, query, results: [], searched_messages: 0, note: "No stored messages to search." };
      }

      const queryTokens = tokenize(query);
      const scored = messages
        .map((m, i) => ({ m, i, score: scoreMessage(m, queryTokens) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || b.i - a.i)
        .slice(0, limit);

      return {
        ok: true,
        query,
        searched_messages: messages.length,
        results: scored.map((r) => ({
          role: r.m.role,
          // Position lets the model say "early in the conversation" rather than pretending to a
          // precision it does not have.
          position: `${r.i + 1} of ${messages.length}`,
          created_at: r.m.created_at ?? null,
          excerpt: snippet(r.m.content, queryTokens),
          relevance: Number(r.score.toFixed(3)),
        })),
        // An empty result is a real answer — it means the thing genuinely is not in this
        // conversation — and saying so is what stops the model inventing a memory of it.
        ...(scored.length === 0
          ? { note: `Nothing in this conversation matches "${query}". It was not discussed here.` }
          : {}),
      };
    },
  },
};
