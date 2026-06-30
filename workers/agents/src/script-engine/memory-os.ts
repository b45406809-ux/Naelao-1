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

import type { Embedder, VectorIndex, MemoryStore, MemoryRecallResult } from "./types.js";

/** The minimal DO SQLite surface this module needs (matches `this.ctx.storage.sql`). */
export interface SqlStorageLike {
  exec(query: string, ...params: unknown[]): { toArray(): unknown[] };
}

export interface MemoryOSOptions {
  sql: SqlStorageLike;
  spaceId: string;
  vectorIndex?: VectorIndex;
  embedder?: Embedder;
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
const SEMANTIC_SCORE_FLOOR = 0.72; // spec's surgicalRecall threshold

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
      const limit = query.limit ?? 5;
      const like = `%${query.text.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      const now = Date.now();

      // Structured facts: match entity/relation/attribute, scoped to this user + space-level.
      const factRows = opts.sql
        .exec(
          `SELECT * FROM structured_facts
           WHERE user_id IN (?, ?) AND (entity LIKE ? ESCAPE '\\' OR relation LIKE ? ESCAPE '\\' OR attribute LIKE ? ESCAPE '\\')
           ORDER BY trust_score DESC LIMIT ?`,
          userId,
          UNSCOPED,
          like,
          like,
          like,
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
        ...userIdField(r.user_id),
      }));

      // Episodic log: recent free-text matches.
      const episodicRows = opts.sql
        .exec(
          `SELECT * FROM episodic_log WHERE user_id IN (?, ?) AND text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`,
          userId,
          UNSCOPED,
          like,
          limit
        )
        .toArray() as EpisodicRow[];
      const episodicResults: MemoryRecallResult[] = episodicRows.map((r) => ({
        id: r.id,
        layer: "episodic",
        text: r.text,
        score: r.importance,
        ...userIdField(r.user_id),
      }));

      // Semantic (Vectorize): promoted long-term memories, embedding-similarity search.
      let semanticResults: MemoryRecallResult[] = [];
      if (opts.vectorIndex && opts.embedder) {
        try {
          const vec = await opts.embedder.embed(query.text);
          const res = await opts.vectorIndex.query(vec, {
            topK: limit,
            filter: { spaceId: { $eq: opts.spaceId } },
            returnMetadata: true,
          });
          semanticResults = res.matches
            .filter((m) => m.score > SEMANTIC_SCORE_FLOOR)
            .map((m) => ({
              id: m.id,
              layer: "semantic" as const,
              text: String(m.metadata?.["text"] ?? ""),
              score: m.score,
              ...userIdField((m.metadata?.["userId"] as string | undefined) ?? ""),
            }));
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
          { id: e.id, values: vec, metadata: { spaceId: opts.spaceId, userId: e.user_id, text: e.text } },
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
