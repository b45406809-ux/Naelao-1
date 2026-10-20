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

import { mintInternalToken, parseBoundedInteger, readBoundedResponseJson } from "@naelao/http";
import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

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
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => [...t].length > 1 && !STOP_WORDS.has(t));
}

/** Score a message against the query. Exported for tests — the ranking is the whole product
 *  here, and it should be assertable without standing up a DO and a spaces worker. */
export function scoreMessage(message: StoredMessage, queryTokens: string[]): number {
  // Filter here as well as in tokenize(): the guarantee that filler words cannot manufacture a
  // match should hold for any caller, not only one that remembered to tokenize first. Without
  // this, a query like "what did we say about the thing" scores against every message in the
  // conversation and the ranking becomes meaningless.
  const tokens = queryTokens.filter((t) => [...t].length > 1 && !STOP_WORDS.has(t.toLowerCase()));
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

const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_MESSAGES = 10_000;
const SEARCH_MAX_BYTES = 16 * 1024 * 1024;

async function loadMessages(ctx: PrebuiltOpContext, sessionId: string, startBeforeId?: string, maxMessages = SEARCH_MAX_MESSAGES): Promise<{ messages: StoredMessage[]; incomplete: boolean; unavailable: boolean; error?: string; nextCursor?: string }> {
  // Channel transcripts are stored by the owning Agent DO. The host callback is closed over
  // the active session and deliberately accepts no model-selected session identifier.
  if (ctx.env.loadCurrentConversation) {
    try {
      const loaded = await ctx.env.loadCurrentConversation({ ...(startBeforeId ? { beforeId: startBeforeId } : {}), limit: maxMessages });
      const selected: StoredMessage[] = [];
      let bytes = 0;
      for (let i = loaded.messages.length - 1; i >= 0 && selected.length < maxMessages; i--) {
        const message = loaded.messages[i]!;
        const size = new TextEncoder().encode(message.content ?? "").byteLength;
        if (bytes + size > SEARCH_MAX_BYTES) break;
        bytes += size;
        selected.unshift(message);
      }
      const incomplete = !loaded.complete || selected.length < loaded.messages.length;
      const nextCursor = incomplete ? selected[0]?.id : undefined;
      return {
        messages: selected,
        incomplete,
        unavailable: Boolean(loaded.error && selected.length === 0),
        ...(loaded.error ? { error: loaded.error } : {}),
        ...(nextCursor ? { nextCursor } : {}),
      };
    } catch {
      return { messages: [], incomplete: false, unavailable: true };
    }
  }
  if (!ctx.env.spacesWorker) return { messages: [], incomplete: false, unavailable: true };
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const messages: StoredMessage[] = [];
  let beforeId: string | undefined = startBeforeId;
  let bytes = 0;
  let incomplete = false;
  let nextCursorOverride: string | undefined;
  const seenCursors = new Set<string>();
  try {
    while (messages.length < maxMessages && bytes < SEARCH_MAX_BYTES) {
      const url = new URL(`http://spaces-worker/spaces/${encodeURIComponent(ctx.env.spaceId)}/sessions/${encodeURIComponent(sessionId)}/messages`);
      const requestLimit = Math.min(SEARCH_PAGE_SIZE, maxMessages - messages.length);
      url.searchParams.set("limit", String(requestLimit));
      url.searchParams.set("scope_space_id", ctx.env.spaceId);
      url.searchParams.set("scope_project_id", ctx.env.projectId ?? "");
      url.searchParams.set("scope_thread_id", sessionId);
      if (beforeId) url.searchParams.set("before_id", beforeId);
      const resp = await ctx.env.spacesWorker.fetch(
        new Request(url, { headers: { "x-naelao-tenant-id": ctx.env.tenantId, "x-naelao-internal-token": token } })
      );
      if (!resp.ok) return { messages, incomplete: true, unavailable: messages.length === 0, error: `Transcript service returned ${resp.status}.`, ...(messages[0]?.id ? { nextCursor: messages[0].id } : {}) };
      const body = await readBoundedResponseJson<{ data?: StoredMessage[]; messages?: StoredMessage[]; cursor_applied?: boolean; has_more?: boolean }>(resp, 2 * 1024 * 1024);
      if (beforeId && body.cursor_applied === false) {
        return { messages, incomplete: true, unavailable: false, error: "The history cursor is no longer valid; restart the search from the newest page.", ...(messages[0]?.id ? { nextCursor: messages[0].id } : {}) };
      }
      const page = body.data ?? body.messages ?? [];
      if (page.length === 0) break;
      const acceptedPage: StoredMessage[] = [];
      for (const message of page) {
        if (messages.length + acceptedPage.length >= maxMessages) break;
        const messageBytes = new TextEncoder().encode(message.content ?? "").length;
        if (bytes + messageBytes > SEARCH_MAX_BYTES) break;
        acceptedPage.push(message);
        bytes += messageBytes;
      }
      messages.unshift(...acceptedPage);
      if (acceptedPage.length < page.length) {
        incomplete = true;
        // SpaceDO pages are chronological. If the byte ceiling interrupts the middle of this
        // page, continue before the row just after the first unconsumed row. This can replay a
        // small accepted tail, but it cannot skip the boundary message.
        nextCursorOverride = page[acceptedPage.length + 1]?.id ?? beforeId;
        break;
      }
      if (messages.length >= maxMessages || bytes >= SEARCH_MAX_BYTES) {
        const oldestId = messages[0]?.id;
        if (!oldestId) { incomplete = true; break; }
        const probeUrl = new URL(`http://spaces-worker/spaces/${encodeURIComponent(ctx.env.spaceId)}/sessions/${encodeURIComponent(sessionId)}/messages`);
        probeUrl.searchParams.set("limit", "1");
        probeUrl.searchParams.set("before_id", oldestId);
        probeUrl.searchParams.set("scope_space_id", ctx.env.spaceId);
        probeUrl.searchParams.set("scope_project_id", ctx.env.projectId ?? "");
        probeUrl.searchParams.set("scope_thread_id", sessionId);
        const probe = await ctx.env.spacesWorker.fetch(new Request(probeUrl, { headers: { "x-naelao-tenant-id": ctx.env.tenantId, "x-naelao-internal-token": token } }));
        if (!probe.ok) { incomplete = true; break; }
        const probeBody = await readBoundedResponseJson<{ data?: StoredMessage[]; messages?: StoredMessage[]; cursor_applied?: boolean }>(probe, 2 * 1024 * 1024);
        if (probeBody.cursor_applied === false) {
          incomplete = true;
          break;
        }
        incomplete = (probeBody.data ?? probeBody.messages ?? []).length > 0;
        break;
      }
      if (body.has_more === false || (page.length < requestLimit && body.has_more !== true)) break;
      const oldestId = page[0]?.id;
      if (!oldestId) {
        incomplete = true;
        break;
      }
      if (seenCursors.has(oldestId) || oldestId === beforeId) {
        incomplete = true;
        break;
      }
      seenCursors.add(oldestId);
      beforeId = oldestId;
    }
  } catch {
    return { messages, incomplete: true, unavailable: messages.length === 0, error: "Transcript service could not be reached.", ...(messages[0]?.id ? { nextCursor: messages[0].id } : {}) };
  }
  const nextCursor = incomplete ? nextCursorOverride ?? messages[0]?.id : undefined;
  return { messages, incomplete, unavailable: false, ...(nextCursor ? { nextCursor } : {}) };
}

function queryText(args: Record<string, unknown>): string {
  return String(args["query"] ?? args["text"] ?? "").trim().slice(0, 2_000);
}

async function search(args: Record<string, unknown>, ctx: PrebuiltOpContext) {
  const query = queryText(args);
  if (!query) throw new Error("conversation.search requires 'query' — what are you looking for?");
  const sessionId = ctx.env.currentSessionId;
  if (!sessionId) return { ok: false, reason: "conversation.search is only available when this run has a host-authorized conversation thread." };
  if (args["session_id"] !== undefined && String(args["session_id"]).trim() !== sessionId) {
    return { ok: false, reason: "conversation.search can only read the current authorized conversation." };
  }
  const requestedLimit = Number(args["limit"] ?? 5);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 20) : 5;
  const scanLimit = parseBoundedInteger(String(args["scan_limit"] ?? SEARCH_MAX_MESSAGES), SEARCH_MAX_MESSAGES, 50, SEARCH_MAX_MESSAGES);
  const beforeId = typeof args["before_id"] === "string" ? args["before_id"].trim().slice(0, 160) : undefined;
  const { messages, incomplete, unavailable, error, nextCursor } = await loadMessages(ctx, sessionId, beforeId || undefined, scanLimit);
  if (unavailable || error) {
    const note = `${error ?? "History search is unavailable."} Search was incomplete; an empty result does not mean this was never discussed.`;
    return { ok: false, query, results: [], searched_messages: messages.length, complete: false, note, reason: note };
  }
  if (messages.length === 0) {
    if (incomplete) return {
      ok: false,
      query,
      results: [],
      searched_messages: 0,
      complete: false,
      exhausted: false,
      note: error ?? "The history scan stopped before it could read any messages. An empty result does not mean this was never discussed.",
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    };
    return unavailable
      ? { ok: false, query, results: [], searched_messages: 0, note: "History search is unavailable. An empty result does not mean this was never discussed." }
      : { ok: true, query, results: [], searched_messages: 0, exhausted: true, note: "No stored messages to search." };
  }
  const queryTokens = tokenize(query);
  const scored = messages.map((m, i) => ({ m, i, score: scoreMessage(m, queryTokens) }))
    .filter((r) => r.score > 0).sort((a, b) => b.score - a.score || b.i - a.i).slice(0, limit);
  return {
    ok: true, query, searched_messages: messages.length, complete: !incomplete,
    results: scored.map((r) => ({ role: r.m.role, position: incomplete ? `${r.i + 1} of scanned page (${messages.length} messages)` : `${r.i + 1} of ${messages.length}`, created_at: r.m.created_at ?? null, message_id: r.m.id ?? null, excerpt: snippet(r.m.content, queryTokens), relevance: Number(r.score.toFixed(3)) })),
    exhausted: !incomplete,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    ...(incomplete ? { note: nextCursor
      ? `The search was incomplete after ${messages.length} messages in this page. Search older history by passing before_id=${nextCursor}.`
      : `The search was incomplete after ${messages.length} messages because a stable message cursor was unavailable.` }
      : scored.length === 0 ? { note: beforeId
        ? `Nothing in this older conversation page matches "${query}".`
        : `Nothing in this conversation matches "${query}". It was not discussed here.` } : {}),
  };
}

export const conversation: PrebuiltScript = {
  name: "conversation",
  description:
    "Search the full, uncompacted transcript of the current conversation. Use this whenever the user refers to something that isn't in your recent messages or summary — the earlier part of a long conversation is compacted away, and this is how you look it up instead of guessing.",
  domain: "knowledge",
  requires_tier: 1,
  paramHints: {
    "conversation.search": "{query, session_id, limit?:1..20, scan_limit?:50..10000, before_id?:next_cursor} — scans a bounded transcript page; pass next_cursor as before_id to continue into older messages.",
    "conversation.research": "{query, session_id, limit?:1..20, scan_limit?:50..10000, before_id?, process?:'summarize'|'extract'|'compress', entities?} — search one bounded page, then optionally send only matched excerpts to document processing; extract requires entity descriptions.",
  },
  operations: {
    async "conversation.search"(args, ctx) {
      return search(args, ctx);
    },
    async "conversation.research"(args, ctx) {
      const result = await search(args, ctx) as { ok?: boolean; results?: Array<{ message_id?: string | null; role: string; created_at: string | null; excerpt: string; relevance: number }>; [key: string]: unknown };
      const process = String(args["process"] ?? "");
      if (!process || !result.ok || !result.results?.length) return result;
      if (!["summarize", "extract", "compress"].includes(process)) throw new Error("conversation.research process must be summarize, extract, or compress");
      const evidence = result.results.map((r, i) => `[${i + 1}] message_id=${r.message_id ?? "unknown"} role=${r.role} at=${r.created_at ?? "unknown"} relevance=${r.relevance}\n${r.excerpt}`).join("\n\n").slice(0, 24_000);
      const sourceId = `conversation:${String(ctx.env.currentSessionId ?? "unknown").slice(0, 160)}:${String(args["before_id"] ?? "latest").slice(0, 160)}`;
      let derived: unknown;
      if (process === "extract") {
        const entities = args["entities"];
        if (!entities || typeof entities !== "object" || Array.isArray(entities)) throw new Error("conversation.research extract requires entities: {field: description}");
        derived = await ctx.run("document.extract", { text: evidence, sourceId, entities });
      } else if (process === "compress") {
        derived = await ctx.run("document.compress", { text: evidence, query: queryText(args), sourceId });
      } else {
        derived = await ctx.run("document.summarize", { text: evidence, sourceId, instructions: `Summarize only evidence relevant to: ${queryText(args)}. Preserve decisions, exact values, uncertainty, and message ids. Do not invent missing facts.`, maxOutputTokens: 700 });
      }
      return { ...result, derived, derivation: { kind: process, source_message_ids: result.results.map((r) => r.message_id).filter(Boolean) } };
    },
  },
};
