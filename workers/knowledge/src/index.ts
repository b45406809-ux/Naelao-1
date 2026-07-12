/**
 * Naelao Knowledge Worker
 * Handles KB document ingestion, Vectorize indexing, and hybrid semantic search.
 *
 * Gap IDs fulfilled: G-B01..G-B15 (KB System)
 */

import { Hono } from "hono";
import { requestId, errorResponse, notFound, badRequest, unauthorized, internalError, safeKvPut, requireInternalHmac } from "@naelao/http";
import { chunkText, embedText, embedBatch, bm25Score, reciprocalRankFusion } from "@naelao/rag";
import { checkSsrf } from "@naelao/security";
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
  // UNIVERSAL / PLATFORM-PROVIDED web search (CLAUDE.md "universal tools" principle): Naelao
  // holds ONE search-provider key here as a Workers Secret so every agent gets web search for
  // free — never the BYO-key `space_credentials` model. Optional: when unset, `search`/`extract`
  // report `configured:false` and `fetch` (a keyless SSRF-guarded GET) still works.
  TAVILY_API_KEY?: string;
  // §A1.19 (AutoRAG/AI Search): the AutoRAG instance name backing an opt-in retrieval mode
  // alongside the existing hand-built dense+BM25+RRF hybrid pipeline (default, unchanged).
  // Optional — when unset, `retrieval_mode=autorag` requests fall back to the legacy pipeline
  // rather than erroring, same honest-degradation posture as every other optional integration.
  // The AutoRAG instance must be configured (via the CF dashboard/API, outside this codebase) to
  // watch this worker's own KB_BUCKET at the `autorag/` prefix this file writes mirror docs to —
  // no separate bucket binding is introduced.
  AUTORAG_KB_INSTANCE?: string;
}

/** R2 key for the whole-document mirror AutoRAG indexes (one file per doc, not per-chunk —
 *  AutoRAG does its own chunking). Distinct prefix from the existing per-chunk `chunkR2Key`. */
function autoragKbKey(spaceId: string, projectId: string | null, docId: string): string {
  return `autorag/${spaceId}/${projectId ?? "_space"}/${docId}.md`;
}

// ── R2 chunk record shape ─────────────────────────────────────────────────────

interface ChunkRecord {
  docId: string;
  chunkIndex: number;
  content: string;
  spaceId: string;
  tenantId: string;
}

// WS-4: Vectorize metadata can't filter on a genuinely absent field the same way SQL's
// `IS NULL` works — an empty string is used as the "space-wide" sentinel so a project-scoped
// query and a space-wide query never accidentally match each other.
const SPACE_WIDE_PROJECT_SENTINEL = "";

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

// F8: every kb/documents/* route already scopes its SQL by `WHERE space_id = ? AND tenant_id
// = ?`, so a foreign spaceId just matches zero rows there. kb/search has no such scoping — it
// filters Vectorize by space_id alone — so a caller who merely knows/guesses another tenant's
// spaceId could search that tenant's KB. Verify the space is actually owned by the requesting
// tenant before running the (otherwise unscoped) Vectorize query.
async function verifySpaceOwnership(db: D1Database, spaceId: string, tenantId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'")
    .bind(spaceId, tenantId)
    .first();
  return row !== null;
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
// WS-4: per-project KB isolation — a project's documents live under their own R2 prefix,
// distinct from the space-wide default (projectId undefined/null).

function chunkR2Key(spaceId: string, projectId: string | null | undefined, docId: string, index: number): string {
  return `kb/${spaceId}/${projectId ?? "_space"}/${docId}/chunk_${index}.json`;
}

function docR2Prefix(spaceId: string, projectId: string | null | undefined, docId: string): string {
  return `kb/${spaceId}/${projectId ?? "_space"}/${docId}/`;
}

// ── Helper: read chunk content from R2 ───────────────────────────────────────

async function readChunkFromR2(
  bucket: R2Bucket,
  spaceId: string,
  projectId: string | null | undefined,
  docId: string,
  chunkIndex: number,
): Promise<ChunkRecord | null> {
  const obj = await bucket.get(chunkR2Key(spaceId, projectId, docId, chunkIndex));
  if (!obj) return null;
  const text = await obj.text();
  return JSON.parse(text) as ChunkRecord;
}

// A1.16.10 (layer-3 backstop, bucket A): KB is a server-side agent tool, never called
// client-side (confirmed neither apps/widget nor apps/portal ever reaches /kb/*) — safe to
// gate broadly.
app.use("/spaces/:spaceId/kb/*", requireInternalHmac((c) => (c as unknown as { env: KnowledgeEnv }).env.PLATFORM_SECRET));

// F8: requireInternalHmac only authenticates the CALLING WORKER, not the tenant the request
// is acting on behalf of. A compromised/malicious agent script belonging to tenant A can still
// pass a spaceId belonging to tenant B (leaked/guessed via URLs, logs, screenshots) in the
// x-naelao-tenant-id + spaceId pair. Every kb/* verb (list, ingest, patch, delete, search) must
// refuse to touch a space the caller's tenant doesn't own — gated once, here, before any
// handler runs (including cache lookups), so no future route can reintroduce the gap.
app.use("/spaces/:spaceId/kb/*", async (c, next) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const owned = await verifySpaceOwnership(c.env.PLATFORM_DB, spaceId, tenantId);
  if (!owned) throw notFound("Space not found");
  await next();
});

// ── GET /spaces/:spaceId/kb/documents ─────────────────────────────────────────

app.get("/spaces/:spaceId/kb/documents", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const url = new URL(c.req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  // WS-4: no project_id param = the pre-existing default, space-wide documents only
  // (project_id IS NULL) — never mixes in a project's own isolated documents by accident.
  const projectId = url.searchParams.get("project_id");

  const { results } = await c.env.PLATFORM_DB.prepare(
    projectId
      ? `SELECT id, space_id, tenant_id, project_id, title, source_url, content_type, status,
                chunk_count, created_at, updated_at
         FROM kb_documents
         WHERE space_id = ? AND tenant_id = ? AND project_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      : `SELECT id, space_id, tenant_id, project_id, title, source_url, content_type, status,
                chunk_count, created_at, updated_at
         FROM kb_documents
         WHERE space_id = ? AND tenant_id = ? AND project_id IS NULL
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
  )
    .bind(...(projectId ? [spaceId, tenantId, projectId, limit, offset] : [spaceId, tenantId, limit, offset]))
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
    /** WS-4: optional — isolates this document to a single project's own KB, distinct from the
     *  space-wide default (omitted/null). */
    project_id?: string;
  }>();
  const projectId = body.project_id ?? null;

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
       (id, space_id, tenant_id, project_id, title, source_url, content_type, status, chunk_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', 0, ?, ?)`
  )
    .bind(docId, spaceId, tenantId, projectId, body.title.trim(), body.source_url ?? null, contentType, now, now)
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
        chunkR2Key(spaceId, projectId, docId, i),
        JSON.stringify(chunkRecord),
      );

      // Prepare Vectorize vector. project_id always set (never omitted) — Vectorize's flat
      // $eq filter can't distinguish "field absent" from "field present," so the space-wide
      // sentinel (empty string) makes filtering exact both ways (see SPACE_WIDE_PROJECT_SENTINEL).
      vectorUpserts.push({
        id: `${docId}_chunk_${i}`,
        values: embedResult.embedding,
        metadata: {
          space_id: spaceId,
          project_id: projectId ?? SPACE_WIDE_PROJECT_SENTINEL,
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

    // §A1.19: best-effort whole-document mirror for AutoRAG (only written when an instance is
    // configured — cheap, and a failed mirror write never fails ingestion since the legacy
    // pipeline above already succeeded and is the default retrieval path regardless).
    if (c.env.AUTORAG_KB_INSTANCE) {
      try {
        await c.env.KB_BUCKET.put(autoragKbKey(spaceId, projectId, docId), sanitizedContent);
      } catch {
        /* best-effort — legacy retrieval is unaffected */
      }
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
    "SELECT id, title, chunk_count, project_id FROM kb_documents WHERE id = ? AND space_id = ? AND tenant_id = ?"
  ).bind(docId, spaceId, tenantId).first<{ id: string; title: string; chunk_count: number; project_id: string | null }>();

  if (!existing) throw notFound("KbDocument");
  const projectId = existing.project_id;

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
    const prefix = docR2Prefix(spaceId, projectId, docId);
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
        chunkR2Key(spaceId, projectId, docId, i),
        JSON.stringify({ docId, chunkIndex: i, content: chunk, spaceId, tenantId } satisfies ChunkRecord)
      );

      vectorUpserts.push({
        id: `${docId}_chunk_${i}`,
        values: embedResult.embedding,
        metadata: {
          space_id: spaceId,
          project_id: projectId ?? SPACE_WIDE_PROJECT_SENTINEL,
          doc_id: docId,
          chunk_index: i,
          title: newTitle,
          content_preview: chunk.slice(0, 200),
        },
      });
    }

    const VECTOR_BATCH_SIZE = 100;
    for (let i = 0; i < vectorUpserts.length; i += VECTOR_BATCH_SIZE) {
      await c.env.KB_VECTORS.upsert(vectorUpserts.slice(i, i + VECTOR_BATCH_SIZE));
    }

    // §A1.19: keep the AutoRAG mirror in sync with the re-indexed content (best-effort, same
    // posture as the POST route's mirror write).
    if (c.env.AUTORAG_KB_INSTANCE) {
      try {
        await c.env.KB_BUCKET.put(autoragKbKey(spaceId, projectId, docId), newContent);
      } catch {
        /* best-effort — legacy retrieval is unaffected */
      }
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
    "SELECT id, chunk_count, project_id FROM kb_documents WHERE id = ? AND space_id = ? AND tenant_id = ?"
  )
    .bind(docId, spaceId, tenantId)
    .first<{ id: string; chunk_count: number; project_id: string | null }>();

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
  const prefix = docR2Prefix(spaceId, doc.project_id, docId);
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

  // §A1.19: the AutoRAG mirror lives at a separate `autorag/` prefix (not under docR2Prefix
  // above, since it's one whole-document file rather than per-chunk records) — delete it
  // explicitly, best-effort, so a purged document doesn't stay searchable via AutoRAG.
  if (c.env.AUTORAG_KB_INSTANCE) {
    await c.env.KB_BUCKET.delete(autoragKbKey(spaceId, doc.project_id, docId)).catch(() => {
      /* best-effort */
    });
  }

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
  // WS-4: no project_id param = the pre-existing default, search space-wide documents only —
  // never silently mixes in a project's own isolated KB.
  const projectId = url.searchParams.get("project_id");
  // §A1.19: opt-in per request (the caller — e.g. the knowledge-base prebuilt or dashboard —
  // decides), not a stored per-space policy. Falls back to the legacy hybrid pipeline whenever
  // AutoRAG isn't configured on this worker, even if the caller asked for it — never a hard
  // error for an unconfigured optional integration.
  const useAutoRag = url.searchParams.get("retrieval_mode") === "autorag" && Boolean(c.env.AUTORAG_KB_INSTANCE);

  if (!query || query.trim().length === 0) {
    throw badRequest("q parameter is required");
  }

  // Ownership already verified by the "/spaces/:spaceId/kb/*" gate above (F8) — the cache key
  // still folds tenantId (and now project_id) in as defense-in-depth so a future refactor of
  // that gate can't reintroduce a cross-tenant/cross-project cache-serving path.
  const cacheHash = await sha256Hex(tenantId + ":" + query + spaceId + ":" + (projectId ?? "") + ":" + (useAutoRag ? "autorag" : "legacy"));
  const cacheKey = `kbcache:${cacheHash}`;

  const cached = await c.env.KB_CACHE.get(cacheKey);
  if (cached) {
    return c.json({ data: JSON.parse(cached), cached: true });
  }

  if (useAutoRag) {
    try {
      const ai = c.env.AI as unknown as {
        autorag(name: string): {
          search(args: { query: string; max_num_results?: number; filters?: unknown }): Promise<{
            data?: Array<{ filename?: string; score?: number; content?: Array<{ text?: string }> }>;
          }>;
        };
      };
      const instance = ai.autorag(c.env.AUTORAG_KB_INSTANCE as string);
      const res = await instance.search({
        query: query.trim(),
        max_num_results: topK,
        // AutoRAG is configured to watch this worker's own KB_BUCKET at the `autorag/` prefix
        // (see autoragKbKey) — filenames there already encode space/project, so a metadata
        // filter further narrows results to this exact space+project (defense in depth, same
        // isolation guarantee the legacy path's Vectorize filter already provides).
        filters: { type: "eq", key: "folder", value: `autorag/${spaceId}/${projectId ?? "_space"}/` },
      });
      const results = (res.data ?? []).map((d, i) => {
        const rawContent = (d.content ?? []).map((c2) => c2.text ?? "").join("\n");
        return {
          chunk_id: d.filename ?? `autorag_${i}`,
          doc_id: (d.filename ?? "").split("/").pop()?.replace(/\.md$/, "") ?? "",
          chunk_index: 0,
          content: `<kb_content>${rawContent}</kb_content>`,
          score: d.score ?? 1 - i / Math.max(1, (res.data?.length ?? 1)),
          dense_score: d.score ?? 0,
          sparse_score: 0,
        };
      });
      await safeKvPut(c.env.KB_CACHE, cacheKey, JSON.stringify(results), { expirationTtl: 3600 });
      return c.json({ data: results, cached: false, retrieval_mode: "autorag" });
    } catch {
      // Best-effort — fall through to the legacy hybrid pipeline below rather than erroring.
    }
  }

  // ── Dense retrieval (Vectorize) ───────────────────────────────────────────
  const queryEmbed = await embedText(c.env.AI, query.trim());

  const denseResponse = await c.env.KB_VECTORS.query(queryEmbed.embedding, {
    topK: topK * 2,
    filter: { space_id: { $eq: spaceId }, project_id: { $eq: projectId ?? SPACE_WIDE_PROJECT_SENTINEL } },
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

      const chunkRecord = await readChunkFromR2(c.env.KB_BUCKET, spaceId, projectId, matchDocId, chunkIndex);
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

  return c.json({ data: results, cached: false, retrieval_mode: "legacy" });
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

// ── UNIVERSAL / PLATFORM-PROVIDED web search (CLAUDE.md "universal tools") ──────
//
// Web search is bundled by Naelao exactly like Claude/ChatGPT bundle it: the platform holds ONE
// provider key (TAVILY_API_KEY, a Workers Secret) and every agent gets search for free. This is
// the `commerce`/`together-ai` platform-key precedent, NOT the BYO-key `space_credentials` model
// (which is only for a builder's OWN external accounts). The key never leaves this worker — the
// calling isolate only ever sees normalized results.
//
//   POST /internal/web-search/search   { query, max_results? }  → { configured, results[], answer? }
//   POST /internal/web-search/fetch    { url }                  → { url, status, content }
//   POST /internal/web-search/extract  { url, schema? }         → { configured, url, content }
//
// `search`/`extract` need the provider key and report `configured:false` when it is unset rather
// than faking empty results. `fetch` is a keyless SSRF-guarded GET and works out of the box.

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
// Cap fetched/extracted page text so one call can't blow the isolate's memory or the sub-request
// response budget — matches the platform's general "bounded text" convention.
const WEB_SEARCH_CONTENT_CAP = 100_000;

app.use("/internal/web-search/*", requireInternalHmac((c) => (c as unknown as { env: KnowledgeEnv }).env.PLATFORM_SECRET));

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

app.post("/internal/web-search/search", async (c) => {
  const body = await c.req.json<{ query?: string; max_results?: number }>().catch(() => ({} as { query?: string; max_results?: number }));
  const query = (body.query ?? "").trim();
  if (!query) return c.json({ error_code: "bad_request", message: "query required" }, 400);

  // Honest degradation: no platform key → report unconfigured, don't fake empty results.
  if (!c.env.TAVILY_API_KEY) {
    return c.json({ configured: false, results: [], message: "platform web search is not configured" });
  }

  const maxResults = Math.min(Math.max(typeof body.max_results === "number" ? body.max_results : 10, 1), 20);
  try {
    const resp = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: c.env.TAVILY_API_KEY,
        query,
        max_results: maxResults,
        search_depth: "basic",
        include_answer: true,
      }),
    });
    if (!resp.ok) {
      return c.json({ configured: true, results: [], error: `search provider error (${resp.status})` }, 502);
    }
    const data = await resp.json<{ answer?: string; results?: TavilyResult[] }>();
    const results = (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: (r.content ?? "").slice(0, WEB_SEARCH_CONTENT_CAP),
      score: r.score ?? 0,
    }));
    return c.json({ configured: true, query, results, answer: data.answer ?? null });
  } catch (err) {
    return c.json({ configured: true, results: [], error: String(err) }, 502);
  }
});

app.post("/internal/web-search/fetch", async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }));
  const rawUrl = (body.url ?? "").trim();
  if (!rawUrl) return c.json({ error_code: "bad_request", message: "url required" }, 400);

  // SSRF guard (DoH resolution) — the agent can pass any URL, so re-check at fetch time, exactly
  // like mcp-hub/browser do. Keyless: page fetch is a universal capability regardless of provider.
  const ssrf = await checkSsrf(rawUrl);
  if (ssrf.blocked) return c.json({ error_code: "forbidden", message: ssrf.reason ?? "url failed SSRF validation" }, 403);

  try {
    const resp = await fetch(rawUrl, { headers: { "user-agent": "naelao-agent/1.0" }, redirect: "follow" });
    const text = (await resp.text()).slice(0, WEB_SEARCH_CONTENT_CAP);
    return c.json({ url: rawUrl, status: resp.status, content: text });
  } catch (err) {
    return c.json({ url: rawUrl, status: 0, content: "", error: String(err) }, 502);
  }
});

app.post("/internal/web-search/extract", async (c) => {
  const body = await c.req.json<{ url?: string; schema?: unknown }>().catch(() => ({} as { url?: string }));
  const rawUrl = (body.url ?? "").trim();
  if (!rawUrl) return c.json({ error_code: "bad_request", message: "url required" }, 400);

  const ssrf = await checkSsrf(rawUrl);
  if (ssrf.blocked) return c.json({ error_code: "forbidden", message: ssrf.reason ?? "url failed SSRF validation" }, 403);

  // Prefer the provider's clean extraction; without a platform key fall back to a keyless
  // SSRF-guarded raw fetch so extract still returns *something* usable rather than nothing.
  if (c.env.TAVILY_API_KEY) {
    try {
      const resp = await fetch(TAVILY_EXTRACT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: c.env.TAVILY_API_KEY, urls: [rawUrl] }),
      });
      if (resp.ok) {
        const data = await resp.json<{ results?: Array<{ url?: string; raw_content?: string }> }>();
        const first = data.results?.[0];
        if (first) {
          return c.json({ configured: true, url: rawUrl, content: (first.raw_content ?? "").slice(0, WEB_SEARCH_CONTENT_CAP) });
        }
      }
    } catch {
      // fall through to the keyless raw-fetch fallback
    }
  }

  try {
    const resp = await fetch(rawUrl, { headers: { "user-agent": "naelao-agent/1.0" }, redirect: "follow" });
    const text = (await resp.text()).slice(0, WEB_SEARCH_CONTENT_CAP);
    return c.json({ configured: Boolean(c.env.TAVILY_API_KEY), url: rawUrl, content: text });
  } catch (err) {
    return c.json({ configured: Boolean(c.env.TAVILY_API_KEY), url: rawUrl, content: "", error: String(err) }, 502);
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

// ── 404 catch-all ─────────────────────────────────────────────────────────────

app.notFound((c) =>
  c.json({ error_code: "not_found", message: "Route not found" }, 404)
);

export default { fetch: app.fetch } satisfies ExportedHandler<KnowledgeEnv>;
