/**
 * Naelao Knowledge Worker
 * Handles KB document ingestion, Vectorize indexing, and hybrid semantic search.
 *
 * Gap IDs fulfilled: G-B01..G-B15 (KB System)
 */

import { Hono } from "hono";
import { requestId, errorResponse, notFound, badRequest, unauthorized, internalError, safeKvPut, requireInternalHmac } from "@naelao/http";
import { chunkText, embedText, embedBatch, bm25Score, reciprocalRankFusion } from "@naelao/rag";
import { EntitlementsChecker, getPlanLimits } from "@naelao/entitlements";
import { moderateInput } from "@naelao/llm-gateway";

// ── Environment ───────────────────────────────────────────────────────────────

interface KnowledgeEnv {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  KB_BUCKET: R2Bucket;
  KB_VECTORS: VectorizeIndex;
  KB_CACHE: KVNamespace;
  SEMANTIC_CACHE_VECTORS: VectorizeIndex;
  SEMANTIC_CACHE_KV: KVNamespace;
  AI: Ai;
}

// ── R2 chunk record shape ─────────────────────────────────────────────────────

interface ChunkRecord {
  docId: string;
  chunkIndex: number;
  content: string;
  spaceId: string;
  tenantId: string;
}

// ── Hono app ──────────────────────────────────────────────────────────────────

// G-A11: Validate required secrets at startup
function validateEnv(env: KnowledgeEnv): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

const app = new Hono<{ Bindings: KnowledgeEnv }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// ── Helper: extract + validate tenant ────────────────────────────────────────

function requireTenant(c: { req: { header: (h: string) => string | undefined } }): string {
  const tenantId = c.req.header("x-naelao-tenant-id");
  if (!tenantId) throw unauthorized("Missing x-naelao-tenant-id header");
  return tenantId;
}

// ── G-BD01: KB content sanitization — strip HTML/XML and scan for injection ───

// Patterns that commonly signal prompt injection attempts in KB content
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /forget\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /\[SYSTEM\]/i,
  /\bSYSTEM\s*PROMPT\b/i,
  /###\s*(INSTRUCTIONS?|SYSTEM|OVERRIDE|JAILBREAK)/i,
  /<\s*system\s*>/i,
  /\bOVERRIDE\s+(ALL\s+)?(PREVIOUS\s+)?INSTRUCTIONS?\b/i,
  /\bACT\s+AS\s+(IF\s+YOU\s+ARE\s+)?(A\s+)?/i,
];

function sanitizeKbContent(content: string): { sanitized: string; injectionDetected: boolean } {
  // Strip HTML/XML tags to prevent tag-based injection vectors
  const stripped = content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]{0,500}>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, "\n\n")
    .trim();

  const injectionDetected = INJECTION_PATTERNS.some((p) => p.test(stripped));

  return { sanitized: stripped, injectionDetected };
}

// ── Helper: sha256 hex digest (Web Crypto, available in Workers) ──────────────

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Helper: R2 key for a chunk ────────────────────────────────────────────────

function chunkR2Key(spaceId: string, docId: string, index: number): string {
  return `kb/${spaceId}/${docId}/chunk_${index}.json`;
}

// ── Helper: read chunk content from R2 ───────────────────────────────────────

async function readChunkFromR2(
  bucket: R2Bucket,
  spaceId: string,
  docId: string,
  chunkIndex: number,
): Promise<ChunkRecord | null> {
  const obj = await bucket.get(chunkR2Key(spaceId, docId, chunkIndex));
  if (!obj) return null;
  const text = await obj.text();
  return JSON.parse(text) as ChunkRecord;
}

// A1.16.10 (layer-3 backstop, bucket A): KB is a server-side agent tool, never called
// client-side (confirmed neither apps/widget nor apps/portal ever reaches /kb/*) — safe to
// gate broadly.
app.use("/spaces/:spaceId/kb/*", requireInternalHmac((c) => (c as unknown as { env: KnowledgeEnv }).env.PLATFORM_SECRET));

// ── GET /spaces/:spaceId/kb/documents ─────────────────────────────────────────

app.get("/spaces/:spaceId/kb/documents", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const url = new URL(c.req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT id, space_id, tenant_id, title, source_url, content_type, status,
            chunk_count, created_at, updated_at
     FROM kb_documents
     WHERE space_id = ? AND tenant_id = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(spaceId, tenantId, limit, offset)
    .all();

  return c.json({ data: results, count: results.length, limit, offset });
});

// ── POST /spaces/:spaceId/kb/documents ────────────────────────────────────────

app.post("/spaces/:spaceId/kb/documents", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");

  const body = await c.req.json<{
    title?: string;
    content?: string;
    content_type?: string;
    source_url?: string;
  }>();

  // Validate required fields
  if (!body.title || typeof body.title !== "string" || body.title.trim().length === 0) {
    throw badRequest("title is required");
  }
  if (!body.content || typeof body.content !== "string") {
    throw badRequest("content is required");
  }

  const validContentTypes = new Set(["text", "url", "code", "pdf"]);
  const contentType = body.content_type ?? "text";
  if (!validContentTypes.has(contentType)) {
    throw badRequest(`content_type must be one of: text, url, code, pdf`);
  }

  // Enforce 1MB content limit
  const MAX_CONTENT_CHARS = 1_048_576;
  if (body.content.length > MAX_CONTENT_CHARS) {
    throw badRequest(`content exceeds maximum size of 1MB (${MAX_CONTENT_CHARS} chars)`);
  }

  // G-AA26: Scan document content for prompt injection before indexing
  const titleMod = moderateInput(body.title.trim());
  if (titleMod.blocked) {
    throw badRequest(`Document title contains disallowed content: ${titleMod.reason}`);
  }
  // Sample the content in 2000-char windows to catch injections in long docs
  const SAMPLE_WINDOW = 2000;
  for (let pos = 0; pos < body.content.length; pos += SAMPLE_WINDOW) {
    const window = body.content.slice(pos, pos + SAMPLE_WINDOW);
    const mod = moderateInput(window);
    if (mod.blocked) {
      throw badRequest(`Document content contains disallowed content: ${mod.reason}`);
    }
  }

  // G-D12: Enforce KB document quota at the API layer (not just the UI)
  const entitlements = new EntitlementsChecker(c.env.PLATFORM_DB);
  const tier = await entitlements.getTenantTier(tenantId);
  const limits = getPlanLimits(tier);
  const countRow = await c.env.PLATFORM_DB.prepare(
    `SELECT COUNT(*) as count FROM kb_documents WHERE space_id = ? AND tenant_id = ? AND status != 'purged'`
  ).bind(spaceId, tenantId).first<{ count: number }>();
  const docCount = countRow?.count ?? 0;
  if (docCount >= limits.kb_documents_per_space) {
    throw Object.assign(
      new Error(`KB document limit (${limits.kb_documents_per_space}) reached for ${tier} plan`),
      { error_code: "quota_exceeded", status: 429 }
    );
  }

  const docId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Insert doc record with status=processing
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO kb_documents
       (id, space_id, tenant_id, title, source_url, content_type, status, chunk_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'processing', 0, ?, ?)`
  )
    .bind(docId, spaceId, tenantId, body.title.trim(), body.source_url ?? null, contentType, now, now)
    .run();

  try {
    // ── G-BD01: Sanitize content — strip HTML, detect injection patterns ────
    const { sanitized: sanitizedContent, injectionDetected } = sanitizeKbContent(body.content);
    if (injectionDetected) {
      // Flag in DB but do NOT reject — builders may legitimately document attacks
      await c.env.PLATFORM_DB.prepare(
        `UPDATE kb_documents SET status = 'flagged', updated_at = ? WHERE id = ?`
      ).bind(new Date().toISOString(), docId).run();
      console.warn(`[kb] Injection pattern detected in doc ${docId} for space ${spaceId}`);
    }

    // ── Chunking ────────────────────────────────────────────────────────────
    const chunks = chunkText(sanitizedContent);

    if (chunks.length === 0) {
      // Content too short to chunk — treat as one chunk
      chunks.push(sanitizedContent.trim());
    }

    // ── Embedding (batch, 50 chunks per CF AI call) ─────────────────────────
    const EMBED_BATCH_SIZE = 50;
    const allEmbedResults: Array<{ embedding: number[]; tokenCount: number }> = [];

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batchChunks = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const batchResults = await embedBatch(c.env.AI, batchChunks);
      allEmbedResults.push(...batchResults);
    }

    // ── R2 storage + Vectorize upsert ───────────────────────────────────────
    const vectorUpserts: VectorizeVector[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedResult = allEmbedResults[i];
      if (chunk === undefined || embedResult === undefined) continue;

      // Store chunk content in R2
      const chunkRecord: ChunkRecord = {
        docId,
        chunkIndex: i,
        content: chunk,
        spaceId,
        tenantId,
      };
      await c.env.KB_BUCKET.put(
        chunkR2Key(spaceId, docId, i),
        JSON.stringify(chunkRecord),
      );

      // Prepare Vectorize vector
      vectorUpserts.push({
        id: `${docId}_chunk_${i}`,
        values: embedResult.embedding,
        metadata: {
          space_id: spaceId,
          doc_id: docId,
          chunk_index: i,
          title: body.title.trim(),
          content_preview: chunk.slice(0, 200),
        },
      });
    }

    // Upsert vectors in batches (Vectorize has limits per upsert call)
    const VECTOR_BATCH_SIZE = 100;
    for (let i = 0; i < vectorUpserts.length; i += VECTOR_BATCH_SIZE) {
      const batch = vectorUpserts.slice(i, i + VECTOR_BATCH_SIZE);
      await c.env.KB_VECTORS.upsert(batch);
    }

    // ── Update DB: status=indexed ────────────────────────────────────────────
    await c.env.PLATFORM_DB.prepare(
      `UPDATE kb_documents
       SET status = 'indexed', chunk_count = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(chunks.length, docId)
      .run();

    const doc = await c.env.PLATFORM_DB.prepare(
      "SELECT * FROM kb_documents WHERE id = ?"
    )
      .bind(docId)
      .first();

    return c.json(doc, 201);
  } catch (err) {
    // Mark document as failed on any error during processing
    await c.env.PLATFORM_DB.prepare(
      `UPDATE kb_documents SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
    )
      .bind(docId)
      .run()
      .catch(() => {/* best-effort */});

    throw internalError(`Document ingestion failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ── PATCH /spaces/:spaceId/kb/documents/:docId ───────────────────────────────
// G-X09: Document update must delete old stale vectors before upserting new ones

app.patch("/spaces/:spaceId/kb/documents/:docId", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const docId = c.req.param("docId");

  const body = await c.req.json<{
    title?: string;
    content?: string;
  }>();

  if (!body.title && !body.content) {
    throw badRequest("At least one of title or content is required");
  }

  // Verify ownership and get current state
  const existing = await c.env.PLATFORM_DB.prepare(
    "SELECT id, title, chunk_count FROM kb_documents WHERE id = ? AND space_id = ? AND tenant_id = ?"
  ).bind(docId, spaceId, tenantId).first<{ id: string; title: string; chunk_count: number }>();

  if (!existing) throw notFound("KbDocument");

  // If only updating title (no content re-index needed)
  if (body.title && !body.content) {
    const newTitle = body.title.trim();
    const titleMod = moderateInput(newTitle);
    if (titleMod.blocked) throw badRequest(`Title contains disallowed content: ${titleMod.reason}`);

    await c.env.PLATFORM_DB.prepare(
      "UPDATE kb_documents SET title = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(newTitle, docId).run();

    const updated = await c.env.PLATFORM_DB.prepare("SELECT * FROM kb_documents WHERE id = ?").bind(docId).first();
    return c.json(updated, 200);
  }

  const newContent = body.content!;
  const newTitle = body.title?.trim() ?? existing.title;

  // G-AA26: Scan updated content for injection
  const titleMod = moderateInput(newTitle);
  if (titleMod.blocked) throw badRequest(`Title contains disallowed content: ${titleMod.reason}`);
  const SAMPLE_WINDOW = 2000;
  for (let pos = 0; pos < newContent.length; pos += SAMPLE_WINDOW) {
    const win = newContent.slice(pos, pos + SAMPLE_WINDOW);
    const mod = moderateInput(win);
    if (mod.blocked) throw badRequest(`Content contains disallowed content: ${mod.reason}`);
  }

  const MAX_CONTENT_CHARS = 1_048_576;
  if (newContent.length > MAX_CONTENT_CHARS) {
    throw badRequest(`content exceeds maximum size of 1MB`);
  }

  // Mark as re-processing
  await c.env.PLATFORM_DB.prepare(
    "UPDATE kb_documents SET status = 'processing', updated_at = datetime('now') WHERE id = ?"
  ).bind(docId).run();

  try {
    // G-X09: Delete ALL old vectors before re-indexing to prevent stale accumulation
    const oldChunkCount = existing.chunk_count ?? 0;
    if (oldChunkCount > 0) {
      const oldVectorIds: string[] = [];
      for (let i = 0; i < oldChunkCount; i++) oldVectorIds.push(`${docId}_chunk_${i}`);
      const VECTOR_DELETE_BATCH = 100;
      for (let i = 0; i < oldVectorIds.length; i += VECTOR_DELETE_BATCH) {
        await c.env.KB_VECTORS.deleteByIds(oldVectorIds.slice(i, i + VECTOR_DELETE_BATCH));
      }
    }

    // Delete old R2 chunks
    const prefix = `kb/${spaceId}/${docId}/`;
    let cursor: string | undefined;
    do {
      const listOpts: R2ListOptions = cursor !== undefined ? { prefix, cursor } : { prefix };
      const listed: R2Objects = await c.env.KB_BUCKET.list(listOpts);
      if (listed.objects.length > 0) {
        await Promise.all(listed.objects.map(o => c.env.KB_BUCKET.delete(o.key)));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    // Re-chunk and re-embed
    const chunks = chunkText(newContent);
    if (chunks.length === 0) chunks.push(newContent.trim());

    const EMBED_BATCH_SIZE = 50;
    const allEmbedResults: Array<{ embedding: number[]; tokenCount: number }> = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batchResults = await embedBatch(c.env.AI, chunks.slice(i, i + EMBED_BATCH_SIZE));
      allEmbedResults.push(...batchResults);
    }

    const vectorUpserts: VectorizeVector[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedResult = allEmbedResults[i];
      if (chunk === undefined || embedResult === undefined) continue;

      await c.env.KB_BUCKET.put(
        chunkR2Key(spaceId, docId, i),
        JSON.stringify({ docId, chunkIndex: i, content: chunk, spaceId, tenantId } satisfies ChunkRecord)
      );

      vectorUpserts.push({
        id: `${docId}_chunk_${i}`,
        values: embedResult.embedding,
        metadata: { space_id: spaceId, doc_id: docId, chunk_index: i, title: newTitle, content_preview: chunk.slice(0, 200) },
      });
    }

    const VECTOR_BATCH_SIZE = 100;
    for (let i = 0; i < vectorUpserts.length; i += VECTOR_BATCH_SIZE) {
      await c.env.KB_VECTORS.upsert(vectorUpserts.slice(i, i + VECTOR_BATCH_SIZE));
    }

    await c.env.PLATFORM_DB.prepare(
      "UPDATE kb_documents SET status = 'indexed', title = ?, chunk_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(newTitle, chunks.length, docId).run();

    const updated = await c.env.PLATFORM_DB.prepare("SELECT * FROM kb_documents WHERE id = ?").bind(docId).first();
    return c.json(updated, 200);
  } catch (err) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE kb_documents SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
    ).bind(docId).run().catch(() => {});
    throw internalError(`Document update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ── DELETE /spaces/:spaceId/kb/documents/:docId ───────────────────────────────

app.delete("/spaces/:spaceId/kb/documents/:docId", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const docId = c.req.param("docId");

  // Verify ownership
  const doc = await c.env.PLATFORM_DB.prepare(
    "SELECT id, chunk_count FROM kb_documents WHERE id = ? AND space_id = ? AND tenant_id = ?"
  )
    .bind(docId, spaceId, tenantId)
    .first<{ id: string; chunk_count: number }>();

  if (!doc) throw notFound("KbDocument");

  const chunkCount = doc.chunk_count ?? 0;

  // ── Delete Vectorize vectors ──────────────────────────────────────────────
  // Build vector IDs directly from doc + chunk count (we stored them as {docId}_chunk_{i})
  if (chunkCount > 0) {
    const vectorIds: string[] = [];
    for (let i = 0; i < chunkCount; i++) {
      vectorIds.push(`${docId}_chunk_${i}`);
    }
    // Delete in batches of 100
    const VECTOR_DELETE_BATCH = 100;
    for (let i = 0; i < vectorIds.length; i += VECTOR_DELETE_BATCH) {
      const batch = vectorIds.slice(i, i + VECTOR_DELETE_BATCH);
      await c.env.KB_VECTORS.deleteByIds(batch);
    }
  }

  // ── Delete R2 objects ─────────────────────────────────────────────────────
  const prefix = `kb/${spaceId}/${docId}/`;
  let cursor: string | undefined;
  do {
    const listOpts: R2ListOptions = cursor !== undefined ? { prefix, cursor } : { prefix };
    const listed: R2Objects = await c.env.KB_BUCKET.list(listOpts);
    const keys = listed.objects.map(o => o.key);
    if (keys.length > 0) {
      // R2 doesn't have a batch delete — delete in parallel
      await Promise.all(keys.map(k => c.env.KB_BUCKET.delete(k)));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // ── Delete DB record ──────────────────────────────────────────────────────
  await c.env.PLATFORM_DB.prepare(
    "DELETE FROM kb_documents WHERE id = ?"
  )
    .bind(docId)
    .run();

  return new Response(null, { status: 204 });
});

// ── GET /spaces/:spaceId/kb/search ────────────────────────────────────────────

app.get("/spaces/:spaceId/kb/search", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const url = new URL(c.req.url);
  const query = url.searchParams.get("q");
  const topK = Math.min(parseInt(url.searchParams.get("top_k") ?? "10", 10), 50);

  if (!query || query.trim().length === 0) {
    throw badRequest("q parameter is required");
  }

  // ── Semantic cache ────────────────────────────────────────────────────────
  const cacheHash = await sha256Hex(query + spaceId);
  const cacheKey = `kbcache:${cacheHash}`;

  const cached = await c.env.KB_CACHE.get(cacheKey);
  if (cached) {
    return c.json({ data: JSON.parse(cached), cached: true });
  }

  // ── Dense retrieval (Vectorize) ───────────────────────────────────────────
  const queryEmbed = await embedText(c.env.AI, query.trim());

  const denseResponse = await c.env.KB_VECTORS.query(queryEmbed.embedding, {
    topK: topK * 2,
    filter: { space_id: { $eq: spaceId } },
    returnMetadata: "indexed",
  });

  const denseMatches = denseResponse.matches ?? [];

  // Build dense results for RRF (id = vector id like "{docId}_chunk_{i}")
  const denseForRrf = denseMatches.map(m => ({ id: m.id, score: m.score ?? 0 }));

  // ── Sparse retrieval (BM25) ───────────────────────────────────────────────
  // Fetch chunk content from R2 for all dense candidates to run BM25 over them
  const chunkContents: Array<{ id: string; content: string; docId: string; chunkIndex: number }> = [];

  await Promise.all(
    denseMatches.map(async (match) => {
      // Vector ID format: "{docId}_chunk_{i}"
      const parts = match.id.split("_chunk_");
      if (parts.length !== 2) return;
      const [matchDocId, chunkIdxStr] = parts as [string, string];
      const chunkIndex = parseInt(chunkIdxStr, 10);
      if (isNaN(chunkIndex)) return;

      const chunkRecord = await readChunkFromR2(c.env.KB_BUCKET, spaceId, matchDocId, chunkIndex);
      if (!chunkRecord) return;

      chunkContents.push({
        id: match.id,
        content: chunkRecord.content,
        docId: matchDocId,
        chunkIndex,
      });
    })
  );

  // Score all fetched chunks with BM25
  const sparseForRrf = bm25Score(
    query,
    chunkContents.map(c => ({ id: c.id, content: c.content })),
  );

  // ── Reciprocal Rank Fusion ─────────────────────────────────────────────────
  const fused = reciprocalRankFusion(denseForRrf, sparseForRrf);

  // Take top topK from fused list
  const topFused = fused.slice(0, topK);

  // ── Build final result objects ────────────────────────────────────────────
  const contentMap = new Map(chunkContents.map(c => [c.id, c]));
  const denseScoreMap = new Map(denseForRrf.map(r => [r.id, r.score]));
  const sparseScoreMap = new Map(sparseForRrf.map(r => [r.id, r.score]));

  const results = topFused.map((item) => {
    const chunkInfo = contentMap.get(item.id);
    const parts = item.id.split("_chunk_");
    const docId = parts[0] ?? item.id;
    const chunkIndex = parts.length === 2 ? parseInt(parts[1] ?? "0", 10) : 0;

    const rawContent = chunkInfo?.content ?? "";
    // Wrap content in XML tags for prompt injection protection
    const wrappedContent = `<kb_content>${rawContent}</kb_content>`;

    return {
      chunk_id: item.id,
      doc_id: docId,
      chunk_index: chunkIndex,
      content: wrappedContent,
      score: item.score,
      dense_score: denseScoreMap.get(item.id) ?? 0,
      sparse_score: sparseScoreMap.get(item.id) ?? 0,
    };
  });

  // ── Cache results (G-BE02: safeKvPut validates size before write) ────────
  await safeKvPut(c.env.KB_CACHE, cacheKey, JSON.stringify(results), { expirationTtl: 3600 });

  return c.json({ data: results, cached: false });
});

// ── G-AZ19: Semantic Response Cache ──────────────────────────────────────────
// Endpoint: POST /internal/semantic-cache/lookup
//   Body: { query: string, spaceId: string }
//   Returns: { hit: true, response: string, cache_id: string } | { hit: false }
//
// Endpoint: POST /internal/semantic-cache/store
//   Body: { query: string, spaceId: string, response: string }
//   Returns: { stored: true, cache_id: string }
//
// Endpoint: DELETE /internal/semantic-cache
//   Query: ?spaceId=xxx
//   Returns: { invalidated: true }

const SEMANTIC_CACHE_SIMILARITY_THRESHOLD = 0.97;
const SEMANTIC_CACHE_TTL_SECS = 24 * 60 * 60;

// A1.16.9 (layer-3 backstop): these routes had NO auth check at all — not even a truthy
// header, just an open POST/DELETE anyone reaching this worker could call. Covers lookup,
// store, and the DELETE invalidation route below (prefix wildcard).
app.use("/internal/semantic-cache/*", requireInternalHmac((c) => (c as unknown as { env: KnowledgeEnv }).env.PLATFORM_SECRET));

app.post("/internal/semantic-cache/lookup", async (c) => {
  const body = await c.req.json<{ query: string; spaceId: string }>();
  if (!body.query || !body.spaceId) {
    return c.json({ error: "query and spaceId required" }, 400);
  }

  // Fail open if Vectorize binding not available (optional binding)
  if (!c.env.SEMANTIC_CACHE_VECTORS || !c.env.SEMANTIC_CACHE_KV) {
    return c.json({ hit: false });
  }

  try {
    const embedding = await embedText(c.env.AI, body.query);

    const results = await c.env.SEMANTIC_CACHE_VECTORS.query(embedding.embedding, {
      topK: 1,
      filter: { space_id: { $eq: body.spaceId } },
      returnMetadata: "indexed",
    });

    const top = results.matches?.[0];
    if (!top || (top.score ?? 0) < SEMANTIC_CACHE_SIMILARITY_THRESHOLD) {
      return c.json({ hit: false });
    }

    const cacheId = top.id;
    const metadata = top.metadata as Record<string, unknown> | undefined;
    const expiresAt = metadata?.["expires_at"] as number | undefined;

    // Check if expired (Vectorize has no TTL — checked via metadata)
    if (expiresAt && expiresAt < Date.now()) {
      // Async cleanup of stale vector — don't block response
      c.executionCtx.waitUntil(c.env.SEMANTIC_CACHE_VECTORS.deleteByIds([cacheId]));
      return c.json({ hit: false });
    }

    const cachedResponse = await c.env.SEMANTIC_CACHE_KV.get(`sc:${cacheId}`);
    if (!cachedResponse) {
      return c.json({ hit: false });
    }

    console.log(`[SemanticCache] HIT spaceId=${body.spaceId} similarity=${top.score?.toFixed(4)} cacheId=${cacheId}`);
    return c.json({ hit: true, response: cachedResponse, cache_id: cacheId, similarity: top.score });
  } catch (err) {
    // Fail open on cache errors — never block the main request
    console.warn(`[SemanticCache] Lookup error: ${err}`);
    return c.json({ hit: false });
  }
});

app.post("/internal/semantic-cache/store", async (c) => {
  const body = await c.req.json<{ query: string; spaceId: string; response: string }>();
  if (!body.query || !body.spaceId || !body.response) {
    return c.json({ error: "query, spaceId, and response required" }, 400);
  }

  if (!c.env.SEMANTIC_CACHE_VECTORS || !c.env.SEMANTIC_CACHE_KV) {
    return c.json({ stored: false, reason: "semantic cache not configured" });
  }

  try {
    const cacheId = crypto.randomUUID();
    const embedding = await embedText(c.env.AI, body.query);
    const expiresAt = Date.now() + SEMANTIC_CACHE_TTL_SECS * 1000;

    await c.env.SEMANTIC_CACHE_VECTORS.upsert([{
      id: cacheId,
      values: embedding.embedding,
      metadata: {
        space_id: body.spaceId,
        expires_at: expiresAt,
      },
    }]);

    await c.env.SEMANTIC_CACHE_KV.put(`sc:${cacheId}`, body.response, {
      expirationTtl: SEMANTIC_CACHE_TTL_SECS,
    });

    console.log(`[SemanticCache] STORED spaceId=${body.spaceId} cacheId=${cacheId}`);
    return c.json({ stored: true, cache_id: cacheId });
  } catch (err) {
    console.warn(`[SemanticCache] Store error: ${err}`);
    return c.json({ stored: false, reason: String(err) });
  }
});

// Invalidate all semantic cache entries for a space (called on KB update)
app.delete("/internal/semantic-cache", async (c) => {
  const spaceId = c.req.query("spaceId");
  if (!spaceId) return c.json({ error: "spaceId required" }, 400);

  if (!c.env.SEMANTIC_CACHE_VECTORS || !c.env.SEMANTIC_CACHE_KV) {
    return c.json({ invalidated: true, count: 0 });
  }

  try {
    // Fetch all vectors for this space using a dummy query (get any embedding)
    const dummyEmbed = await embedText(c.env.AI, "cache invalidation");
    const toDelete = await c.env.SEMANTIC_CACHE_VECTORS.query(dummyEmbed.embedding, {
      topK: 1000,
      filter: { space_id: { $eq: spaceId } },
      returnMetadata: "none",
    });

    const ids = toDelete.matches?.map(m => m.id) ?? [];
    if (ids.length > 0) {
      await c.env.SEMANTIC_CACHE_VECTORS.deleteByIds(ids);
      // Also delete from KV
      await Promise.all(ids.map(id => c.env.SEMANTIC_CACHE_KV.delete(`sc:${id}`)));
    }

    console.log(`[SemanticCache] Invalidated ${ids.length} entries for spaceId=${spaceId}`);
    return c.json({ invalidated: true, count: ids.length });
  } catch (err) {
    console.warn(`[SemanticCache] Invalidation error: ${err}`);
    return c.json({ invalidated: false, error: String(err) });
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

// ── 404 catch-all ─────────────────────────────────────────────────────────────

app.notFound((c) =>
  c.json({ error_code: "not_found", message: "Route not found" }, 404)
);

export default { fetch: app.fetch } satisfies ExportedHandler<KnowledgeEnv>;
