/**
 * Memory OS (spec "Space Assistants — OpenClaw + CF Thinker + Memory OS", byte ~141822) —
 * Layer 3 (Structured Facts) + Layer 5 (Vector DB semantic memory), plus the episodic log
 * that feeds Layer 5's promotion. Layers 1 (Workspace/R2) and 2 (Sessions/FTS5) already exist
 * elsewhere (r2-workspace prebuilt, NaelaoAgentDO's `messages`/`messages_fts` tables).
 *
 * Backed by the host DO's own SQLite (tables created here, owned by the caller) + an optional
 * Vectorize index for semantic recall. Pure functions over an injected SQL handle so this is
 * unit-testable without a real Durable Object (same pattern as skill-library.ts over R2).
 *
 * Fixes tracked spec gaps:
 *   - G-AN26 / "Shared Agent Mode Memory Namespace Collision": every table carries `user_id`
 *     (empty string = space-level/unscoped), and every query is scoped to it.
 *   - "Memory OS decay_rate Field Defined But Never Applied": runMemoryMaintenance() applies it.
 *   - "Episodic-to-Semantic Memory Promotion Has No Trigger": runMemoryMaintenance() promotes
 *     high-importance unpromoted episodic rows into the Vectorize semantic layer.
 *   - "Memory OS Grows Without Bound": maintenance prunes decayed facts and stale episodic rows.
 *   - "Agent Cannot Self-Manage Its Own Memory (Hermes Pattern Missing)": prebuilt/memory.ts
 *     exposes remember/recall/forget to the LLM, backed by the MemoryStore this module builds.
 */

import type { Embedder, VectorIndex, MemoryStore, MemoryRecallResult, FabricEntry, WikiArticle } from "./types.js";
import { gateMemory } from "./memory/gate-memory.js";
import { projectFactRelevance } from "@naelao/agent-sdk";

/** The minimal DO SQLite surface this module needs (matches `this.ctx.storage.sql`). */
export interface SqlStorageLike {
  exec(query: string, ...params: unknown[]): { toArray(): unknown[] };
}

/** The minimal R2 surface needed to mirror Wiki concepts for AutoRAG indexing (avoids a hard
 *  dependency on the CF R2Bucket type, same rationale as VectorIndex above). */
export interface R2PutLike {
  put(key: string, value: string): Promise<unknown>;
}

/** Cloudflare AutoRAG (or AI Search), injected behind a minimal interface — same pattern as
 *  VectorIndex/Embedder above — so this module never takes a hard dependency on the concrete CF
 *  binding shape. Only used for Layer 6 (Wiki): a stable, document-like "auto-curated concept
 *  vault" is a good fit for AutoRAG's R2-batch reindexing cadence. Layer 5 (episodic/semantic)
 *  deliberately does NOT use this — it needs instant per-message embed+query, and AutoRAG's
 *  reindex lag would make freshly-remembered facts unsearchable for a while (see CLAUDE.md).
 */
export interface AutoRagGateway {
  /** Returns candidate concept names (matched against mirrored Wiki documents), best score first. */
  search(query: string, opts: { topK: number }): Promise<Array<{ concept: string; score: number }>>;
}

export interface MemoryOSOptions {
  sql: SqlStorageLike;
  tenantId?: string;
  spaceId: string;
  projectId?: string;
  vectorIndex?: VectorIndex;
  embedder?: Embedder;
  /** R2 bucket to mirror Wiki concepts into for AutoRAG indexing. Optional — Wiki CRUD works
   *  identically (SQLite stays authoritative) with or without this; only searchWiki's recall
   *  gets richer semantic matching when both this and autoRag are present. */
  wikiBucket?: R2PutLike;
  /** AutoRAG/AI Search gateway for semantic Wiki search. Optional — searchWiki degrades to its
   *  existing SQLite LIKE-match when absent, unchanged from before this feature existed. */
  autoRag?: AutoRagGateway;
  /** Read dynamically so an assistant-access clamp resolved after environment construction
   * can still govern every memory result produced by this store. */
  roleRank?: () => number;
}

/** Turns a concept name into a safe R2 key segment — mirrors are one file per (user scope,
 *  concept), so two users' same-named concept never collides. */
function wikiConceptSlug(concept: string): string {
  return concept.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "concept";
}

function wikiR2Key(spaceId: string, userId: string, concept: string): string {
  const scope = userId || "_space";
  return `spaces/${spaceId}/memory/wiki/${scope}/${wikiConceptSlug(concept)}.md`;
}

// Unscoped (space-level) facts use this sentinel instead of NULL — keeps every query a plain
// equality/IN match instead of juggling `IS NULL` vs bound-param semantics.
const UNSCOPED = "";

const DEFAULT_TRUST_SCORE = 1.0;
const DEFAULT_DECAY_RATE = 0.05;
const TRUST_FLOOR = 0.05;
const PROMOTE_IMPORTANCE_FLOOR = 0.7;
const PROMOTE_BATCH_SIZE = 25;
const EPISODIC_RETENTION_CAP = 500; // unpromoted, sub-threshold rows kept per (space)
const DECAY_TICK_MS = 24 * 60 * 60 * 1000; // a fact decays at most once per day of inactivity
// Hindsight memories cross a thread boundary only when similarity strictly exceeds 0.80.
// Keep the comparison below as `<=` so the boundary itself is denied rather than rounded up.
const FABRIC_SCORE_FLOOR = 0.7; // spec's surgicalRecall threshold for Fabric specifically

/** LLM supplied memory limits must stay finite; SQLite LIMIT -1 means every row. */
export function boundedMemoryLimit(value: number | undefined, fallback = 5, maximum = 100): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(maximum, value!)) : fallback;
}

export function initMemorySchema(sql: SqlStorageLike): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS structured_facts (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id     TEXT NOT NULL DEFAULT '',
      entity      TEXT NOT NULL,
      relation    TEXT NOT NULL,
      attribute   TEXT NOT NULL,
      trust_score REAL NOT NULL DEFAULT ${DEFAULT_TRUST_SCORE},
      decay_rate  REAL NOT NULL DEFAULT ${DEFAULT_DECAY_RATE},
      last_used   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_facts_entity ON structured_facts(entity)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_facts_user ON structured_facts(user_id)`);
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_unique ON structured_facts(user_id, entity, relation)`);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS episodic_log (
      id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id    TEXT NOT NULL DEFAULT '',
      text       TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      promoted   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_episodic_user ON episodic_log(user_id, created_at DESC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_episodic_promo ON episodic_log(promoted, importance)`);

  // Layer 4 (Fabric) — spec's fabric_store, scoped per-user like every other layer here (the
  // spec's AssistantDO is single-tenant per DO; ours shares one DO's SQLite across users in
  // shared-assistant mode, so user_id joins the schema the same way it did for Layer 3).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS fabric_store (
      id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id      TEXT NOT NULL DEFAULT '',
      session_id   TEXT NOT NULL,
      summary      TEXT NOT NULL,
      key_insights TEXT NOT NULL DEFAULT '[]',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_fabric_user ON fabric_store(user_id, created_at DESC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_fabric_session ON fabric_store(session_id)`);

  // Layer 6 (LLM Wiki) — spec's wiki_store. PK is (user_id, concept) rather than the spec's
  // bare `concept TEXT PRIMARY KEY` for the same per-user-scoping reason as above.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS wiki_store (
      user_id       TEXT NOT NULL DEFAULT '',
      concept       TEXT NOT NULL,
      definition    TEXT NOT NULL,
      relationships TEXT NOT NULL DEFAULT '[]',
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      PRIMARY KEY (user_id, concept)
    )
  `);
}

interface StructuredFactRow {
  id: string;
  user_id: string;
  entity: string;
  relation: string;
  attribute: string;
  trust_score: number;
  decay_rate: number;
  last_used: number;
  updated_at: number;
}

interface EpisodicRow {
  id: string;
  user_id: string;
  text: string;
  importance: number;
  promoted: number;
  created_at: number;
}

/** exactOptionalPropertyTypes helper: only include user_id when it's a real (non-sentinel) value. */
function userIdField(v: string): { user_id: string } | Record<string, never> {
  return v ? { user_id: v } : {};
}

interface FabricStoreRow {
  id: string;
  user_id: string;
  session_id: string;
  summary: string;
  key_insights: string;
  created_at: number;
}

interface WikiStoreRow {
  user_id: string;
  concept: string;
  definition: string;
  relationships: string;
  updated_at: number;
}

function toFabricEntry(r: FabricStoreRow, score: number): FabricEntry {
  let keyInsights: string[] = [];
  try {
    keyInsights = JSON.parse(r.key_insights);
  } catch {
    /* leave empty on corrupt JSON rather than throw */
  }
  return { id: r.id, sessionId: r.session_id, summary: r.summary, keyInsights, score, createdAt: r.created_at };
}

function toWikiArticle(r: WikiStoreRow): WikiArticle {
  let relationships: string[] = [];
  try {
    relationships = JSON.parse(r.relationships);
  } catch {
    /* leave empty on corrupt JSON rather than throw */
  }
  return { concept: r.concept, definition: r.definition, relationships, updatedAt: r.updated_at };
}

/**
 * Heuristic relevance in [0,1] between a query and a Fabric entry's summary + key insights —
 * term-overlap (Jaccard-style), not an embedding. Fabric is DO SQLite + R2 per spec, not a
 * Vectorize-backed layer like Layer 5, so this stays a cheap local computation; an exact
 * substring match scores 1.0 so a recognizable phrase always clears the 0.70 floor.
 */
function fabricRelevance(query: string, row: FabricStoreRow): number {
  const haystack = `${row.summary} ${row.key_insights}`.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return 0;
  if (haystack.includes(needle)) return 1;
  const queryTerms = new Set(needle.split(/\s+/).filter((t) => t.length > 2));
  if (queryTerms.size === 0) return 0;
  const hayTerms = new Set(haystack.split(/\s+/));
  let hits = 0;
  for (const t of queryTerms) if (hayTerms.has(t)) hits++;
  return hits / queryTerms.size;
}

export function buildMemoryStore(opts: MemoryOSOptions): MemoryStore {
  const scope = (userId: string | undefined) => userId ?? UNSCOPED;

  return {
    async remember(entry) {
      const userId = scope(entry.userId);
      const now = Date.now();

      if (entry.entity && entry.relation && entry.attribute) {
        // Layer 3 — structured fact. Merge on (user_id, entity, relation): re-stating a fact
        // refreshes trust + last_used rather than accumulating duplicates.
        const existing = opts.sql
          .exec(`SELECT id FROM structured_facts WHERE user_id = ? AND entity = ? AND relation = ?`, userId, entry.entity, entry.relation)
          .toArray() as Array<{ id: string }>;
        if (existing[0]) {
          opts.sql.exec(
            `UPDATE structured_facts SET attribute = ?, trust_score = ?, last_used = ?, updated_at = ? WHERE id = ?`,
            entry.attribute,
            DEFAULT_TRUST_SCORE,
            now,
            now,
            existing[0].id
          );
          return { id: existing[0].id };
        }
        const id = crypto.randomUUID();
        opts.sql.exec(
          `INSERT INTO structured_facts (id, user_id, entity, relation, attribute, trust_score, decay_rate, last_used, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          userId,
          entry.entity,
          entry.relation,
          entry.attribute,
          DEFAULT_TRUST_SCORE,
          DEFAULT_DECAY_RATE,
          now,
          now
        );
        return { id };
      }

      // Layer 5 feeder — free-text episodic note, scored for later promotion to semantic memory.
      const id = crypto.randomUUID();
      const importance = Math.min(1, Math.max(0, entry.importance ?? 0.5));
      opts.sql.exec(
        `INSERT INTO episodic_log (id, user_id, text, importance, promoted, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
        id,
        userId,
        entry.text,
        importance,
        now
      );
      return { id };
    },

    async recall(query) {
      const userId = scope(query.userId);
      const limit = boundedMemoryLimit(query.limit);
      const roleRank = Math.max(0, Math.min(3, Math.trunc(opts.roleRank?.() ?? 0)));
      const like = `%${query.text.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      const now = Date.now();

      // A fact is stored as three separate columns, so requiring the WHOLE query string to appear
      // inside ONE of them means a natural-language recall almost always misses: "refund window"
      // never matches (entity=refund, relation=window, attribute=30 days), even though that is
      // exactly the fact being asked for. Agents recall in natural language, so that made the
      // structured layer near-useless in practice.
      //
      // Match on TOKENS instead — any token appearing in any column is a hit. The whole-phrase
      // term is kept as well so an exact substring match still works (and still ranks, since rows
      // are ordered by trust_score). Deliberately OR rather than AND: recall is a retrieval aid
      // whose results are re-read by the model, so a near-miss is far cheaper than a silent miss.
      const factTerms = [
        ...new Set(
          query.text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((t) => t.length > 2)
            .map((t) => `%${t.replace(/[%_]/g, (c) => `\\${c}`)}%`)
        ),
      ];
      if (factTerms.length === 0) factTerms.push(like);
      const factClause = factTerms
        .map(() => `(entity LIKE ? ESCAPE '\\' OR relation LIKE ? ESCAPE '\\' OR attribute LIKE ? ESCAPE '\\')`)
        .join(" OR ");
      const factParams = factTerms.flatMap((t) => [t, t, t]);

      // Structured facts: match entity/relation/attribute, scoped to this user + space-level.
      const factRows = opts.sql
        .exec(
          `SELECT * FROM structured_facts
           WHERE user_id IN (?, ?) AND (${factClause})
           ORDER BY trust_score DESC LIMIT ?`,
          userId,
          UNSCOPED,
          ...factParams,
          limit
        )
        .toArray() as StructuredFactRow[];
      if (factRows.length > 0) {
        const ids = factRows.map((r) => r.id);
        opts.sql.exec(
          `UPDATE structured_facts SET last_used = ${now} WHERE id IN (${ids.map(() => "?").join(",")})`,
          ...ids
        );
      }
      const factResults: MemoryRecallResult[] = factRows.map((r) => ({
        id: r.id,
        layer: "structured_fact",
        text: `${r.entity} ${r.relation} ${r.attribute}`,
        entity: r.entity,
        relation: r.relation,
        attribute: r.attribute,
        score: r.trust_score,
        role_rank: roleRank,
        relevance_score: projectFactRelevance(query.text, `${r.entity} ${r.relation} ${r.attribute}`),
        ...userIdField(r.user_id),
      }));

      // Episodic log: recent free-text matches.
      // Same token matching as structured facts above, and for the same reason: an agent asks
      // "what did they say about the price", not the exact substring it once wrote down.
      const episodicClause = factTerms.map(() => `text LIKE ? ESCAPE '\\'`).join(" OR ");
      const episodicRows = opts.sql
        .exec(
          `SELECT * FROM episodic_log WHERE user_id IN (?, ?) AND (${episodicClause}) ORDER BY created_at DESC LIMIT ?`,
          userId,
          UNSCOPED,
          ...factTerms,
          limit
        )
        .toArray() as EpisodicRow[];
      const episodicResults: MemoryRecallResult[] = episodicRows.map((r) => ({
        id: r.id,
        layer: "episodic",
        text: r.text,
        score: r.importance,
        role_rank: roleRank,
        ...userIdField(r.user_id),
      }));

      // Semantic (Vectorize): promoted long-term memories, embedding-similarity search. Vectorize
      // filters are a flat {field:{$eq}} match with no OR support (no `IN`), so — mirroring the
      // `user_id IN (?, ?)` two-tier scoping structured_facts/episodic_log already use above —
      // a scoped user gets two queries merged: their own promoted memories, plus space-level
      // (unscoped) ones. Previously this only filtered by spaceId, so one user's promoted
      // episodic memories were recallable by every other user sharing the same space/DO — the
      // wrangler.toml binding comment already (incorrectly) claimed a userId filter existed.
      let semanticResults: MemoryRecallResult[] = [];
      if (opts.vectorIndex && opts.embedder) {
        try {
          const vec = await opts.embedder.embed(query.text);
          const scopes = userId === UNSCOPED ? [UNSCOPED] : [userId, UNSCOPED];
          const matches = await Promise.all(
            scopes.map((s) =>
              opts.vectorIndex!.query(vec, {
                topK: limit,
                filter: {
                  tenantId: { $eq: opts.tenantId ?? "" },
                  spaceId: { $eq: opts.spaceId },
                  projectId: { $eq: opts.projectId ?? "" },
                  userId: { $eq: s },
                },
                returnMetadata: true,
              })
            )
          );
          const seenIds = new Set<string>();
          for (const res of matches) {
            for (const m of res.matches) {
              if (seenIds.has(m.id)) continue;
              seenIds.add(m.id);
              semanticResults.push({
                id: m.id,
                layer: "semantic" as const,
                text: String(m.metadata?.["text"] ?? ""),
                score: m.score,
                role_rank: roleRank,
                ...userIdField((m.metadata?.["userId"] as string | undefined) ?? ""),
              });
            }
          }
          semanticResults = await gateMemory(vec, semanticResults);
        } catch {
          /* semantic recall is best-effort */
        }
      }

      // Merge + dedupe by text, highest score wins, sorted desc, capped at `limit`.
      const seen = new Map<string, MemoryRecallResult>();
      for (const r of [...factResults, ...semanticResults, ...episodicResults]) {
        const key = r.text.toLowerCase();
        const prior = seen.get(key);
        if (!prior || r.score > prior.score) seen.set(key, r);
      }
      return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    },

    async forget(id) {
      opts.sql.exec(`DELETE FROM structured_facts WHERE id = ?`, id);
      opts.sql.exec(`DELETE FROM episodic_log WHERE id = ?`, id);
      if (opts.vectorIndex) {
        try {
          await opts.vectorIndex.deleteByIds([id]);
        } catch {
          /* best-effort */
        }
      }
    },

    // ── Layer 4 (Fabric) ──────────────────────────────────────────────────────
    async recordFabric(entry) {
      const userId = scope(entry.userId);
      const id = crypto.randomUUID();
      opts.sql.exec(
        `INSERT INTO fabric_store (id, user_id, session_id, summary, key_insights, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        id, userId, entry.sessionId, entry.summary, JSON.stringify(entry.keyInsights ?? []), Date.now()
      );
      return { id };
    },

    async recallFabric(query) {
      const userId = scope(query.userId);
      const limit = boundedMemoryLimit(query.limit);
      const rows = opts.sql
        .exec(
          `SELECT * FROM fabric_store WHERE user_id IN (?, ?) ORDER BY created_at DESC LIMIT 100`,
          userId, UNSCOPED
        )
        .toArray() as FabricStoreRow[];
      return rows
        .map((r) => toFabricEntry(r, fabricRelevance(query.text, r)))
        .filter((f) => f.score > FABRIC_SCORE_FLOOR)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    async briefFabric(userId, requestedLimit = 5) {
      const limit = boundedMemoryLimit(requestedLimit);
      const scoped = scope(userId);
      const rows = opts.sql
        .exec(
          // rowid tiebreak — created_at is millisecond-resolution and two entries recorded in
          // the same millisecond (common for fast automated post-run recording) would
          // otherwise sort arbitrarily, silently breaking "most recent first".
          `SELECT * FROM fabric_store WHERE user_id IN (?, ?) ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          scoped, UNSCOPED, limit
        )
        .toArray() as FabricStoreRow[];
      return rows.map((r) => toFabricEntry(r, 0));
    },

    // ── Layer 6 (LLM Wiki) ────────────────────────────────────────────────────
    async upsertWikiConcept(entry) {
      const userId = scope(entry.userId);
      opts.sql.exec(
        `INSERT INTO wiki_store (user_id, concept, definition, relationships, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, concept) DO UPDATE SET definition = excluded.definition, relationships = excluded.relationships, updated_at = excluded.updated_at`,
        userId, entry.concept, entry.definition, JSON.stringify(entry.relationships ?? []), Date.now()
      );
      // Best-effort mirror to R2 so AutoRAG (if configured) has something to index. SQLite is
      // still authoritative for CRUD — this mirror only feeds searchWiki's optional semantic
      // recall below, and a failed write here never fails the (already-succeeded) upsert.
      if (opts.wikiBucket) {
        const relationships = entry.relationships ?? [];
        const body = `# ${entry.concept}\n\n${entry.definition}\n\n` +
          (relationships.length ? `Related: ${relationships.join(", ")}\n` : "");
        try {
          await opts.wikiBucket.put(wikiR2Key(opts.spaceId, userId, entry.concept), body);
        } catch {
          /* best-effort — the SQLite row is the source of truth */
        }
      }
      return { concept: entry.concept };
    },

    async lookupWikiConcept(userId, concept) {
      const scoped = scope(userId);
      const rows = opts.sql
        .exec(`SELECT * FROM wiki_store WHERE user_id IN (?, ?) AND concept = ? ORDER BY user_id != '' DESC LIMIT 1`, scoped, UNSCOPED, concept)
        .toArray() as WikiStoreRow[];
      return rows[0] ? toWikiArticle(rows[0]) : null;
    },

    async searchWiki(query) {
      const userId = scope(query.userId);
      const limit = boundedMemoryLimit(query.limit);
      const like = `%${query.text.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      const rows = opts.sql
        .exec(
          `SELECT * FROM wiki_store WHERE user_id IN (?, ?) AND (concept LIKE ? ESCAPE '\\' OR definition LIKE ? ESCAPE '\\')
           ORDER BY updated_at DESC LIMIT ?`,
          userId, UNSCOPED, like, like, limit
        )
        .toArray() as WikiStoreRow[];
      const results = new Map<string, WikiArticle>();
      for (const r of rows) results.set(`${r.user_id}\0${r.concept}`, toWikiArticle(r));

      // Optional semantic assist: AutoRAG matches concept names by meaning, not just substring —
      // useful for a query like "what's our refund window" finding a concept named
      // "return-policy". AutoRAG only tells us WHICH concepts matched; the actual WikiArticle is
      // always re-read from SQLite (the authoritative store) rather than reconstructed from
      // AutoRAG's own (unstructured) search result, so a stale/deleted mirror can never surface
      // a phantom article.
      if (opts.autoRag && results.size < limit) {
        try {
          const hits = await opts.autoRag.search(query.text, { topK: limit });
          for (const hit of hits) {
            if (results.size >= limit) break;
            const key1 = `${userId}\0${hit.concept}`;
            const key2 = `${UNSCOPED}\0${hit.concept}`;
            if (results.has(key1) || results.has(key2)) continue;
            const hydrated = opts.sql
              .exec(`SELECT * FROM wiki_store WHERE user_id IN (?, ?) AND concept = ? LIMIT 1`, userId, UNSCOPED, hit.concept)
              .toArray() as WikiStoreRow[];
            if (hydrated[0]) results.set(`${hydrated[0].user_id}\0${hydrated[0].concept}`, toWikiArticle(hydrated[0]));
          }
        } catch {
          /* AutoRAG assist is best-effort — the SQLite LIKE search above already ran */
        }
      }
      return [...results.values()].slice(0, limit);
    },
  };
}

export interface MemoryMaintenanceResult {
  decayed: number;
  pruned_facts: number;
  promoted: number;
  pruned_episodic: number;
}

/**
 * Run the Memory OS maintenance pass: decay structured-fact trust scores, prune facts that
 * have decayed below the floor, promote high-importance episodic notes to the semantic
 * (Vectorize) layer, and prune the unbounded episodic log. Call from a heartbeat/cron, not
 * inline with a user-facing request (it does embedding calls and can take a beat).
 */
export async function runMemoryMaintenance(opts: MemoryOSOptions): Promise<MemoryMaintenanceResult> {
  const now = Date.now();
  const result: MemoryMaintenanceResult = { decayed: 0, pruned_facts: 0, promoted: 0, pruned_episodic: 0 };

  // 1. Decay: facts untouched for >= one tick lose trust proportional to their own decay_rate.
  const staleFacts = opts.sql
    .exec(`SELECT * FROM structured_facts WHERE ? - last_used >= ?`, now, DECAY_TICK_MS)
    .toArray() as StructuredFactRow[];
  for (const f of staleFacts) {
    const ticks = Math.floor((now - f.last_used) / DECAY_TICK_MS);
    const newTrust = f.trust_score * Math.pow(1 - f.decay_rate, ticks);
    if (newTrust < TRUST_FLOOR) {
      opts.sql.exec(`DELETE FROM structured_facts WHERE id = ?`, f.id);
      result.pruned_facts++;
    } else {
      opts.sql.exec(`UPDATE structured_facts SET trust_score = ?, updated_at = ? WHERE id = ?`, newTrust, now, f.id);
      result.decayed++;
    }
  }

  // 2. Promote: high-importance, not-yet-promoted episodic notes → Vectorize semantic layer.
  if (opts.vectorIndex && opts.embedder) {
    const candidates = opts.sql
      .exec(
        `SELECT * FROM episodic_log WHERE promoted = 0 AND importance >= ? ORDER BY importance DESC LIMIT ?`,
        PROMOTE_IMPORTANCE_FLOOR,
        PROMOTE_BATCH_SIZE
      )
      .toArray() as EpisodicRow[];
    for (const e of candidates) {
      try {
        const vec = await opts.embedder.embed(e.text);
        await opts.vectorIndex.upsert([
          {
            id: e.id,
            values: vec,
            metadata: {
              tenantId: opts.tenantId ?? "",
              spaceId: opts.spaceId,
              projectId: opts.projectId ?? "",
              userId: e.user_id,
              text: e.text,
            },
          },
        ]);
        opts.sql.exec(`UPDATE episodic_log SET promoted = 1 WHERE id = ?`, e.id);
        result.promoted++;
      } catch {
        /* leave unpromoted; retried next maintenance pass */
      }
    }
  }

  // 3. Prune: bound the unpromoted, sub-threshold episodic log so it can't grow forever.
  const keepIds = opts.sql
    .exec(
      `SELECT id FROM episodic_log WHERE promoted = 0 ORDER BY created_at DESC LIMIT ?`,
      EPISODIC_RETENTION_CAP
    )
    .toArray() as Array<{ id: string }>;
  if (keepIds.length === EPISODIC_RETENTION_CAP) {
    const placeholders = keepIds.map(() => "?").join(",");
    const before = opts.sql.exec(`SELECT COUNT(*) AS c FROM episodic_log WHERE promoted = 0`).toArray() as Array<{ c: number }>;
    opts.sql.exec(
      `DELETE FROM episodic_log WHERE promoted = 0 AND id NOT IN (${placeholders})`,
      ...keepIds.map((r) => r.id)
    );
    const beforeCount = before[0]?.c ?? 0;
    result.pruned_episodic = Math.max(0, beforeCount - EPISODIC_RETENTION_CAP);
  }

  return result;
}
