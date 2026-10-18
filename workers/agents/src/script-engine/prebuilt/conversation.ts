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
 * Retrieval is keyword-scored over the stored messages rather than semantic. Web transcripts live
 * in SpaceDO and external channel transcripts live in the owning Agent DO; neither should be
 * copied to a shared index that could blur session boundaries. Reading is immediate, bounded to
 * 10,000 messages / 20 MiB, and reports `complete: false` when that cap or a storage error stops
 * the scan. A future semantic index belongs behind this same current-thread-only operation.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken, parseBoundedInteger } from "@naelao/http";

interface StoredMessage {
  id?: string;
  role: string;
  content: string;
  created_at?: string;
}

const PAGE_SIZE = 100;
const MAX_SEARCH_MESSAGES = 10_000;
const MAX_SEARCH_CONTENT_BYTES = 20 * 1024 * 1024;

/** Tokens worth matching on: drops the filler words that would otherwise match everything. */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "of", "to", "in", "on", "at", "for",
  "with", "was", "were", "is", "are", "be", "been", "it", "this", "that", "what", "when", "did",
  "do", "does", "you", "i", "we", "my", "me", "about", "said", "say", "tell", "have", "has",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Score a message against the query. Exported for tests — the ranking is the whole product
 *  here, and it should be assertable without standing up a DO and a spaces worker. */
export function scoreMessage(message: StoredMessage, queryTokens: string[]): number {
  // Filter here as well as in tokenize(): the guarantee that filler words cannot manufacture a
  // match should hold for any caller, not only one that remembered to tokenize first. Without
  // this, a query like "what did we say about the thing" scores against every message in the
  // conversation and the ranking becomes meaningless.
  const tokens = queryTokens.filter((t) => t.length > 1 && !STOP_WORDS.has(t.toLowerCase()));
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

interface LoadedMessages {
  messages: StoredMessage[];
  complete: boolean;
  error?: string;
}

async function loadMessages(ctx: PrebuiltOpContext, sessionId: string): Promise<LoadedMessages> {
  if (ctx.env.loadCurrentConversation) {
    try { return await ctx.env.loadCurrentConversation(); }
    catch { return { messages: [], complete: false, error: "The host could not read this conversation." }; }
  }
  if (!ctx.env.spacesWorker) return { messages: [], complete: false, error: "Transcript service is unavailable." };
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const messages: StoredMessage[] = [];
  let beforeId: string | undefined;
  let contentBytes = 0;
  let complete = false;
  try {
    while (true) {
      const atLimit = messages.length >= MAX_SEARCH_MESSAGES || contentBytes >= MAX_SEARCH_CONTENT_BYTES;
      const params = new URLSearchParams({ limit: String(atLimit ? 1 : PAGE_SIZE), scope_space_id: ctx.env.spaceId,
        scope_project_id: ctx.env.projectId ?? "", scope_thread_id: sessionId });
      if (beforeId) params.set("before_id", beforeId);
      const resp = await ctx.env.spacesWorker.fetch(new Request(
        `http://spaces-worker/spaces/${encodeURIComponent(ctx.env.spaceId)}/sessions/${encodeURIComponent(sessionId)}/messages?${params}`,
        { headers: { "x-naelao-tenant-id": ctx.env.tenantId, "x-naelao-internal-token": token } },
      ));
      if (!resp.ok) return { messages, complete: false, error: `Transcript service returned ${resp.status}.` };
      const body = (await resp.json()) as { data?: StoredMessage[]; messages?: StoredMessage[] };
      const page = body.data ?? body.messages ?? [];
      if (!Array.isArray(page)) return { messages, complete: false, error: "Transcript service returned an invalid page." };
      if (page.length === 0) { complete = true; break; }
      if (atLimit) break;
      let accepted = page;
      for (let i = 0; i < page.length; i++) {
        const size = new TextEncoder().encode(page[i]?.content ?? "").byteLength;
        if (messages.length + i >= MAX_SEARCH_MESSAGES || contentBytes + size > MAX_SEARCH_CONTENT_BYTES) {
          accepted = page.slice(0, i);
          break;
        }
        contentBytes += size;
      }
      // Pages are chronological; walking backwards and prepending preserves transcript order.
      messages.unshift(...accepted);
      if (accepted.length < page.length) break;
      if (page.length < PAGE_SIZE) { complete = true; break; }
      const oldest = page[0]?.id;
      if (!oldest) return { messages, complete: false, error: "Transcript page is missing its pagination cursor." };
      beforeId = oldest;
    }
  } catch {
    return { messages, complete: false, error: "Transcript service could not be reached." };
  }
  return { messages, complete };
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
      const sessionId = ctx.env.currentSessionId;
      if (!sessionId) {
        return {
          ok: false,
          reason: "conversation.search is only available when this run has a host-authorized conversation thread.",
        };
      }
      if (args["session_id"] !== undefined && String(args["session_id"]).trim() !== sessionId) {
        return { ok: false, reason: "conversation.search can only read the current authorized conversation." };
      }
      const limit = parseBoundedInteger(String(args["limit"] ?? "5"), 5, 1, 20);

      const loaded = await loadMessages(ctx, sessionId);
      const messages = loaded.messages;
      if (loaded.error) return { ok: false, query, searched_messages: messages.length, complete: false, reason: loaded.error };
      if (messages.length === 0) {
        return { ok: true, query, results: [], searched_messages: 0, complete: loaded.complete,
          note: loaded.complete ? "No stored messages to search." : "No messages could be scanned; transcript search was incomplete." };
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
        complete: loaded.complete,
        results: scored.map((r) => ({
          role: r.m.role,
          // Position lets the model say "early in the conversation" rather than pretending to a
          // precision it does not have.
          ...(loaded.complete ? { position: `${r.i + 1} of ${messages.length}` } : { position_in_scanned_window: `${r.i + 1} of ${messages.length}` }),
          created_at: r.m.created_at ?? null,
          excerpt: snippet(r.m.content, queryTokens),
          relevance: Number(r.score.toFixed(3)),
        })),
        // An empty result is a real answer — it means the thing genuinely is not in this
        // conversation — and saying so is what stops the model inventing a memory of it.
        ...(scored.length === 0 && loaded.complete
          ? { note: `Nothing in this conversation matches "${query}". It was not discussed here.` }
          : scored.length === 0 ? { note: `No match found in the ${messages.length} messages scanned. The transcript may contain more messages; search was incomplete.` } : {}),
      };
    },
  },
  paramHints: { "conversation.search": "{ query: what detail to find in this conversation, limit?: 1–20 }" },
};
