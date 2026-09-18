/**
 * Naelao Knowledge Worker
 * Handles KB document ingestion, Vectorize indexing, and hybrid semantic search.
 *
 * Gap IDs fulfilled: G-B01..G-B15 (KB System)
 */

import { Hono } from "hono";
import { requestId, errorResponse, notFound, badRequest, unauthorized, internalError, safeKvPut, requireInternalHmac } from "@naelao/http";
import { chunkText, embedText, embedBatch, googleModeSearch, verifyCitationCoordinate, type GroundedSearchHit, type RetrievalScope } from "@naelao/rag";
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
  /** Cohere Parse is mandatory for binary/layout-sensitive ingestion. It intentionally has no
   * fallback to pretending the model ran: callers receive a service-unavailable failure. */
  COHERE_API_KEY?: string;
  RETRIEVAL_POLICY_VERSION?: string;
  RETRIEVAL_CONFIDENCE_THRESHOLD?: string;
  KNOWLEDGE_ANALYTICS?: AnalyticsEngineDataset;
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
  projectId: string;
  visibility: "project" | "space";
  requiredRoleRank: number;
  chunkId: string;
  contentHash: string;
  sourceFreshness: string;
  headingPath: string[];
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
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

const ROLE_RANK: Record<string, number> = { product_end_user: 0, viewer: 10, member: 20, developer: 30, admin: 40, owner: 50, builder: 50 };

function effectiveRoleRank(c: { req: { header: (h: string) => string | undefined } }): number {
  const role = c.req.header("x-naelao-role") ?? "";
  const rank = ROLE_RANK[role];
  if (rank === undefined) throw unauthorized("Effective role is unavailable");
  return rank;
}

/** Project authorization is deliberately independent from space ownership. The canonical
 * project ACL is owned by SpaceDO; until a read-only binding is introduced, the mirrored D1
 * project ACL is the fail-closed authority used by this worker. */
async function authorizeProject(db: D1Database, scope: RetrievalScope, userId: string): Promise<boolean> {
  if (!scope.projectId || !userId) return false;
  try {
    const access = await db.prepare(
      `SELECT visibility, role_rank FROM project_access
       WHERE project_id = ? AND user_id = ? AND tenant_id = ? AND space_id = ?`
    ).bind(scope.projectId, userId, scope.tenantId, scope.spaceId)
      .first<{ visibility: string; role_rank: number }>();
    return Boolean(access && access.role_rank >= 0);
  } catch {
    // Schema/service-policy failures must never widen access.
    return false;
  }
}

function contextEnvelope(hit: GroundedSearchHit): string {
  const content = hit.content.replace(/<\/context_chunk>/gi, "&lt;/context_chunk&gt;");
  return `<context_chunk id="${hit.id.replace(/[^a-zA-Z0-9_-]/g, "")}" trust="untrusted">${content}</context_chunk>`;
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

function citationR2Key(spaceId: string, projectId: string | null | undefined, docId: string, index: number): string {
  return `kb/${spaceId}/${projectId ?? "_space"}/${docId}/chunk_${index}.txt`;
}

function docR2Prefix(spaceId: string, projectId: string | null | undefined, docId: string): string {
  return `kb/${spaceId}/${projectId ?? "_space"}/${docId}/`;
}

async function parseWithCohere(env: KnowledgeEnv, content: string, contentType: string): Promise<string> {
  if (!env.COHERE_API_KEY) throw Object.assign(new Error("Cohere Parse is not configured"), { status: 503 });
  const response = await fetch("https://api.cohere.com/v2/parse", {
    method: "POST",
    headers: { authorization: `Bearer ${env.COHERE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "parse-v5.0", document: { content, content_type: contentType }, output_format: "markdown" }),
  });
  if (!response.ok) throw Object.assign(new Error(`Cohere Parse failed (${response.status})`), { status: 502 });
  const parsed = await response.json<{ text?: string; markdown?: string; document?: { text?: string } }>();
  const text = parsed.markdown ?? parsed.text ?? parsed.document?.text;
  if (!text) throw Object.assign(new Error("Cohere Parse returned no document text"), { status: 502 });
  return text;
}

function chunkCoordinates(document: string, chunks: string[]): Array<{ byteStart: number; byteEnd: number; lineStart: number; lineEnd: number }> {
  const encoder = new TextEncoder();
  let cursor = 0;
  return chunks.map((chunk) => {
    const characterStart = document.indexOf(chunk, cursor);
    const start = characterStart < 0 ? cursor : characterStart;
    const end = start + chunk.length;
    cursor = end;
    return {
      byteStart: encoder.encode(document.slice(0, start)).byteLength,
      byteEnd: encoder.encode(document.slice(0, end)).byteLength,
      lineStart: document.slice(0, start).split("\n").length,
      lineEnd: document.slice(0, end).split("\n").length,
    };
  });
}

// A1.16.10 (layer-3 backstop, bucket A): KB is a server-side agent tool, never called
// client-side (confirmed neither apps/widget nor apps/portal ever reaches /kb/*) — safe to
// gate broadly.
app.use("/spaces/:spaceId/kb/*", requireInternalHmac((c) => (c as unknown as { env: KnowledgeEnv }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/citations/*", requireInternalHmac((c) => (c as unknown as { env: KnowledgeEnv }).env.PLATFORM_SECRET));

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
    required_role_rank?: number;
  }>();
  const projectId = body.project_id ?? null;
  const requiredRoleRank = Math.max(0, Math.min(body.required_role_rank ?? 0, 50));
  if (projectId) {
    const scope = { tenantId, spaceId, projectId, roleRank: effectiveRoleRank(c) };
    const userId = c.req.header("x-naelao-user-id") ?? "";
    if (!(await authorizeProject(c.env.PLATFORM_DB, scope, userId))) throw notFound("Project not found");
  }

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
    const parsedContent = contentType === "pdf" ? await parseWithCohere(c.env, body.content, contentType) : body.content;
    const { sanitized: sanitizedContent, injectionDetected } = sanitizeKbContent(parsedContent);
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
    const coordinates = chunkCoordinates(sanitizedContent, chunks);

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
      const coordinate = coordinates[i];
      if (chunk === undefined || embedResult === undefined || coordinate === undefined) continue;
      const chunkId = `${docId}_chunk_${i}`;
      const contentHash = await sha256Hex(chunk);

      // Store chunk content in R2
      const chunkRecord: ChunkRecord = {
        docId,
        chunkIndex: i,
        content: chunk,
        spaceId,
        tenantId,
        projectId: projectId ?? SPACE_WIDE_PROJECT_SENTINEL,
        visibility: projectId ? "project" : "space",
        requiredRoleRank,
        chunkId,
        contentHash,
        sourceFreshness: now,
        headingPath: [],
        ...coordinate,
      };
      await c.env.KB_BUCKET.put(
        chunkR2Key(spaceId, projectId, docId, i),
        JSON.stringify(chunkRecord),
      );
      await c.env.KB_BUCKET.put(citationR2Key(spaceId, projectId, docId, i), chunk, {
        customMetadata: { contentHash, tenantId, spaceId, projectId: projectId ?? SPACE_WIDE_PROJECT_SENTINEL },
      });

      // Prepare Vectorize vector. project_id always set (never omitted) — Vectorize's flat
      // $eq filter can't distinguish "field absent" from "field present," so the space-wide
      // sentinel (empty string) makes filtering exact both ways (see SPACE_WIDE_PROJECT_SENTINEL).
      vectorUpserts.push({
        id: chunkId,
        values: embedResult.embedding,
        metadata: {
          space_id: spaceId,
          tenant_id: tenantId,
          project_id: projectId ?? SPACE_WIDE_PROJECT_SENTINEL,
          visibility: projectId ? "project" : "space",
          required_role_rank: requiredRoleRank,
          doc_id: docId,
          chunk_id: chunkId,
          content_hash: contentHash,
          source_freshness: now,
          byte_start: coordinate.byteStart,
          byte_end: coordinate.byteEnd,
          line_start: coordinate.lineStart,
          line_end: coordinate.lineEnd,
          chunk_index: i,
          title: body.title.trim(),
          content_preview: chunk.slice(0, 200),
        },
      });
      await c.env.PLATFORM_DB.prepare(
        `INSERT INTO kb_chunks
         (id, tenant_id, space_id, project_id, document_id, chunk_index, content, content_hash,
          visibility, required_role_rank, source_freshness, heading_path, r2_key,
          byte_start, byte_end, line_start, line_end, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, NULL)`
      ).bind(chunkId, tenantId, spaceId, projectId ?? SPACE_WIDE_PROJECT_SENTINEL, docId, i,
        chunk, contentHash, projectId ? "project" : "space", requiredRoleRank, now,
        citationR2Key(spaceId, projectId, docId, i), 0, new TextEncoder().encode(chunk).byteLength,
        coordinate.lineStart, coordinate.lineEnd, now).run();
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

    if (err && typeof err === "object" && "status" in err) throw err;
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
    await c.env.PLATFORM_DB.prepare(
      "DELETE FROM kb_chunks WHERE document_id=? AND tenant_id=? AND space_id=? AND project_id=?"
    ).bind(docId, tenantId, spaceId, projectId ?? SPACE_WIDE_PROJECT_SENTINEL).run();

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
    const coordinates = chunkCoordinates(newContent, chunks);
    const indexedAt = new Date().toISOString();

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
      const coordinate = coordinates[i];
      if (chunk === undefined || embedResult === undefined || coordinate === undefined) continue;
      const chunkId = `${docId}_chunk_${i}`;
      const contentHash = await sha256Hex(chunk);

      await c.env.KB_BUCKET.put(
        chunkR2Key(spaceId, projectId, docId, i),
        JSON.stringify({ docId, chunkIndex: i, content: chunk, spaceId, tenantId,
          projectId: projectId ?? SPACE_WIDE_PROJECT_SENTINEL, visibility: projectId ? "project" : "space",
          requiredRoleRank: 0, chunkId, contentHash, sourceFreshness: indexedAt, headingPath: [], ...coordinate } satisfies ChunkRecord)
      );
      await c.env.KB_BUCKET.put(citationR2Key(spaceId, projectId, docId, i), chunk, {
        customMetadata: { contentHash, tenantId, spaceId, projectId: projectId ?? SPACE_WIDE_PROJECT_SENTINEL },
      });
      await c.env.PLATFORM_DB.prepare(
        `INSERT INTO kb_chunks (id,tenant_id,space_id,project_id,document_id,chunk_index,content,
         content_hash,visibility,required_role_rank,source_freshness,heading_path,r2_key,byte_start,
         byte_end,line_start,line_end,created_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,0,?,'[]',?,?,?,?,?,?,NULL)`
      ).bind(chunkId, tenantId, spaceId, projectId ?? SPACE_WIDE_PROJECT_SENTINEL, docId, i, chunk,
        contentHash, projectId ? "project" : "space", indexedAt, citationR2Key(spaceId, projectId, docId, i),
        0, new TextEncoder().encode(chunk).byteLength, coordinate.lineStart, coordinate.lineEnd, indexedAt).run();

      vectorUpserts.push({
        id: chunkId,
        values: embedResult.embedding,
        metadata: {
          space_id: spaceId,
          tenant_id: tenantId,
          project_id: projectId ?? SPACE_WIDE_PROJECT_SENTINEL,
          required_role_rank: 0,
          content_hash: contentHash,
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
  await c.env.PLATFORM_DB.prepare(
    "DELETE FROM kb_chunks WHERE document_id=? AND tenant_id=? AND space_id=? AND project_id=?"
  ).bind(docId, tenantId, spaceId, doc.project_id ?? SPACE_WIDE_PROJECT_SENTINEL).run();

  return new Response(null, { status: 204 });
});

// Canonical citation resolver. Neither model nor browser supplies an R2 key: the key and range
// are loaded from the immutable chunk record after tenant/project/role authorization.
app.get("/spaces/:spaceId/projects/:projectId/citations/:documentId/:chunkId", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const projectId = c.req.param("projectId");
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const roleRank = effectiveRoleRank(c);
  const scope = { tenantId, spaceId, projectId, roleRank };
  if (!(await authorizeProject(c.env.PLATFORM_DB, scope, userId))) throw notFound("Citation not found");
  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT id, document_id, r2_key, content_hash, byte_start, byte_end, line_start, line_end
     FROM kb_chunks WHERE id=? AND document_id=? AND tenant_id=? AND space_id=? AND project_id=?
       AND required_role_rank<=? AND deleted_at IS NULL`
  ).bind(c.req.param("chunkId"), c.req.param("documentId"), tenantId, spaceId, projectId, roleRank)
    .first<Record<string, unknown>>();
  if (!row) throw notFound("Citation not found");
  const head = await c.env.KB_BUCKET.head(String(row.r2_key));
  if (!head) throw notFound("Citation not found");
  const coordinate = verifyCitationCoordinate({ r2Key: String(row.r2_key), byteStart: Number(row.byte_start),
    byteEnd: Number(row.byte_end), lineStart: Number(row.line_start), lineEnd: Number(row.line_end) },
    { r2Key: String(row.r2_key), size: head.size, lineCount: Number(row.line_end) });
  if (head.customMetadata?.contentHash !== String(row.content_hash)) throw notFound("Citation not found");
  const object = await c.env.KB_BUCKET.get(coordinate.r2Key, {
    range: { offset: coordinate.byteStart, length: coordinate.byteEnd - coordinate.byteStart },
  });
  if (!object) throw notFound("Citation not found");
  const content = await object.text();
  if (await sha256Hex(content) !== String(row.content_hash)) throw notFound("Citation not found");
  return c.json({ citation: { version: 1, identity: `${row.document_id}:${row.id}:${row.content_hash}`,
    document_id: row.document_id, chunk_id: row.id, content_hash: row.content_hash,
    byte_start: coordinate.byteStart, byte_end: coordinate.byteEnd, line_start: coordinate.lineStart,
    line_end: coordinate.lineEnd }, content });
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

  const roleRank = effectiveRoleRank(c);
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const scope: RetrievalScope = {
    tenantId,
    spaceId,
    projectId: projectId ?? SPACE_WIDE_PROJECT_SENTINEL,
    roleRank,
  };
  if (projectId && !(await authorizeProject(c.env.PLATFORM_DB, scope, userId))) {
    // Conceal absent and inaccessible private projects identically.
    throw notFound("Project not found");
  }
  const policyVersion = c.env.RETRIEVAL_POLICY_VERSION ?? "1";
  const mode = useAutoRag ? "autorag" : "hybrid";
  const namespace = `${tenantId}:${spaceId}:${scope.projectId}:${roleRank}:${mode}:${policyVersion}`;
  const telemetry: Record<string, number> = {};
  const timed = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try { return await operation(); }
    finally { telemetry[name] = performance.now() - started; }
  };
  const rowToHit = (row: Record<string, unknown>, score: number): GroundedSearchHit => ({
    id: String(row.id), score, content: String(row.content), r2Key: String(row.r2_key),
    byteStart: Number(row.byte_start), byteEnd: Number(row.byte_end),
    lineStart: Number(row.line_start), lineEnd: Number(row.line_end), title: String(row.title ?? ""),
  });
  const result = await googleModeSearch(query.trim(), scope, {
    now: Date.now,
    cache: {
      lookup: async (q, _scope, nowMs) => timed("cache_lookup_ms", async () => {
        const key = `grounded:${await sha256Hex(`${namespace}:${q}`)}`;
        const value = await c.env.KB_CACHE.get(key, "json") as { createdAt: number; expiresAt: number; hits: GroundedSearchHit[] } | null;
        if (!value) return null;
        if (value.expiresAt <= nowMs || value.createdAt > nowMs) { await c.env.KB_CACHE.delete(key); return null; }
        return value;
      }),
      store: async (q, _scope, hits, expiresAt) => {
        if (!hits.length) return;
        const key = `grounded:${await sha256Hex(`${namespace}:${q}`)}`;
        await safeKvPut(c.env.KB_CACHE, key, JSON.stringify({ createdAt: Date.now(), expiresAt, hits }), { expirationTtl: 3600 });
      },
    },
    dense: async (q, scoped) => timed("dense_search_ms", async () => {
      const embedded = await timed("embedding_ms", () => embedText(c.env.AI, q));
      const found = await c.env.KB_VECTORS.query(embedded.embedding, {
        topK: topK * 2,
        filter: {
          tenant_id: { $eq: scoped.tenantId }, space_id: { $eq: scoped.spaceId },
          project_id: { $eq: scoped.projectId }, required_role_rank: { $lte: scoped.roleRank },
        },
        returnMetadata: "indexed",
      });
      const ids = (found.matches ?? []).map((m) => m.id);
      if (!ids.length) return [];
      const placeholders = ids.map(() => "?").join(",");
      const rows = await c.env.PLATFORM_DB.prepare(
        `SELECT k.*, d.title FROM kb_chunks k JOIN kb_documents d ON d.id=k.document_id
         WHERE k.id IN (${placeholders}) AND k.tenant_id=? AND k.space_id=? AND k.project_id=?
           AND k.required_role_rank<=? AND k.deleted_at IS NULL`
      ).bind(...ids, scoped.tenantId, scoped.spaceId, scoped.projectId, scoped.roleRank).all<Record<string, unknown>>();
      const byId = new Map(rows.results.map((row) => [String(row.id), row]));
      return (found.matches ?? []).flatMap((match) => {
        const row = byId.get(match.id); return row ? [rowToHit(row, match.score ?? 0)] : [];
      });
    }),
    // Sparse retrieval searches the entire authorized FTS corpus, never only dense candidates.
    sparse: async (q, scoped) => timed("sparse_search_ms", async () => {
      const rows = await c.env.PLATFORM_DB.prepare(
        `SELECT k.*, d.title, bm25(kb_chunks_fts) AS rank FROM kb_chunks_fts f
         JOIN kb_chunks k ON k.rowid=f.rowid JOIN kb_documents d ON d.id=k.document_id
         WHERE kb_chunks_fts MATCH ? AND k.tenant_id=? AND k.space_id=? AND k.project_id=?
           AND k.required_role_rank<=? AND k.deleted_at IS NULL ORDER BY rank LIMIT ?`
      ).bind(q, scoped.tenantId, scoped.spaceId, scoped.projectId, scoped.roleRank, topK * 2).all<Record<string, unknown>>();
      return rows.results.map((row, index) => rowToHit(row, 1 / (index + 1)));
    }),
    web: async (q, scoped) => timed("web_grounding_ms", async () => {
      if (!c.env.TAVILY_API_KEY) return [];
      const response = await fetch(TAVILY_SEARCH_URL, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: c.env.TAVILY_API_KEY, query: q, max_results: Math.min(topK, 5), search_depth: "basic" }) });
      if (!response.ok) return [];
      // Web excerpts stay external/untrusted until separately ingested. They deliberately receive
      // no fake internal R2 coordinates or citation identity.
      const data = await response.json<{ results?: TavilyResult[] }>();
      return (data.results ?? []).map((item, index) => ({ id: `web:${index}`, score: item.score ?? 0,
        content: item.content ?? "", r2Key: "", byteStart: 0, byteEnd: 0, title: item.title ?? "" }));
    }),
    emitTelemetry: (event) => {
      const payload = { ...event, ...telemetry, retrieval_mode: mode, result_count: 0 };
      c.env.KNOWLEDGE_ANALYTICS?.writeDataPoint({ blobs: [tenantId, spaceId, scope.projectId, JSON.stringify(payload)], doubles: [event.latencyMs, event.confidence] });
      console.log(JSON.stringify({ event: "knowledge.retrieval", ...payload }));
    },
  }, { confidenceThreshold: Number(c.env.RETRIEVAL_CONFIDENCE_THRESHOLD ?? "0.8"), limit: topK });

  const data = result.hits.map((hit) => ({
    chunk_id: hit.id, content: contextEnvelope(hit), score: hit.score,
    citation: hit.r2Key ? { document_id: hit.id.split("_chunk_")[0], chunk_id: hit.id,
      content_hash: undefined, byte_start: hit.byteStart, byte_end: hit.byteEnd,
      line_start: hit.lineStart, line_end: hit.lineEnd } : null,
  }));
  return c.json({ data, cached: result.cacheHit, retrieval_mode: mode, confidence: result.confidence,
    live_grounding: result.liveGrounding, latency_ms: result.latencyMs });
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
//   POST /internal/web-search/search    { query, max_results? }  → { configured, results[], answer? }
//   POST /internal/web-search/fetch     { url }                  → { url, status, content }
//   POST /internal/web-search/extract   { url, schema? }         → { configured, url, content }
//   POST /internal/web-search/download  { url }                  → { url, status, content, size, truncated }
//
// `search`/`extract` need the provider key and report `configured:false` when it is unset rather
// than faking empty results. `fetch`/`download` are keyless SSRF-guarded GETs and work out of the
// box — `download` is the higher-cap, save-don't-read variant (see its own comment).

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

// A DIFFERENT shape from /fetch and /extract on purpose: those two are meant to be read directly
// (small, capped at WEB_SEARCH_CONTENT_CAP, returned straight into the reasoning payload). This
// one is meant to be SAVED — a real download the agent's own downloads/ prebuilt op writes to R2
// rather than reading into context, so a much larger cap is safe here.
//
// Binary is FIRST-CLASS here, not a refusal. An earlier revision rejected any binary content-type
// with a 415 on the reasoning that a `.text()` decode of binary bytes produces mojibake — true,
// but the conclusion was wrong: the fix is to stop calling `.text()`, not to stop accepting PDFs
// and images, which are exactly what "download a file" means. Bytes are read once as an
// ArrayBuffer and returned base64 when they aren't text, and the prebuilt writes the real decoded
// bytes to R2.
//
// Text keeps a truncating cap (a partial CSV still has value). Binary does NOT truncate — half a
// PDF is not a smaller PDF, it is a corrupt file — so an oversized binary is refused outright with
// its real size named, which is actionable, rather than silently written as garbage.
const WEB_DOWNLOAD_CONTENT_CAP = 2_000_000;
const WEB_DOWNLOAD_BINARY_CAP = 12_000_000;

/**
 * Base64 a byte array without `String.fromCharCode(...bytes)`, which blows the call stack once the
 * array is large (the same trap already hit and fixed once in the browser worker's screenshot
 * path). Chunked rather than reaching for `Buffer`, which this worker's tsconfig does not type.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Text-ish content types that are safe and useful to hand back as a string. */
function isTextualContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("text/")) return true;
  return /^application\/(json|xml|javascript|x-ndjson|ld\+json|graphql|x-yaml|yaml)\b/.test(ct)
    || /\+(json|xml)\b/.test(ct);
}

app.post("/internal/web-search/download", async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }));
  const rawUrl = (body.url ?? "").trim();
  if (!rawUrl) return c.json({ error_code: "bad_request", message: "url required" }, 400);

  const ssrf = await checkSsrf(rawUrl);
  if (ssrf.blocked) return c.json({ error_code: "forbidden", message: ssrf.reason ?? "url failed SSRF validation" }, 403);

  try {
    const resp = await fetch(rawUrl, { headers: { "user-agent": "naelao-agent/1.0" }, redirect: "follow" });
    const contentType = (resp.headers.get("content-type") ?? "").split(";")[0]!.trim();
    // Read the bytes ONCE. A body can only be consumed a single time, so the text-vs-binary
    // decision has to happen against the buffer, never by re-reading the response.
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);

    if (isTextualContentType(contentType)) {
      const full = new TextDecoder().decode(bytes);
      const truncated = full.length > WEB_DOWNLOAD_CONTENT_CAP;
      return c.json({
        url: rawUrl, status: resp.status, encoding: "text", content_type: contentType || "text/plain",
        content: full.slice(0, WEB_DOWNLOAD_CONTENT_CAP),
        size: full.length, truncated,
      });
    }

    if (bytes.byteLength > WEB_DOWNLOAD_BINARY_CAP) {
      return c.json({
        url: rawUrl, status: resp.status, content: null, content_type: contentType,
        error: `file is ${bytes.byteLength} bytes, over the ${WEB_DOWNLOAD_BINARY_CAP}-byte download limit. Binary files are not truncated because a partial file is corrupt.`,
      }, 413);
    }
    // Buffer (nodejs_compat is on for this worker) rather than String.fromCharCode(...bytes),
    // which blows the call stack on a large array — the same trap already hit and fixed once in
    // the browser worker's screenshot path.
    return c.json({
      url: rawUrl, status: resp.status, encoding: "base64",
      content_type: contentType || "application/octet-stream",
      content: bytesToBase64(bytes),
      size: bytes.byteLength, truncated: false,
    });
  } catch (err) {
    return c.json({ url: rawUrl, status: 0, content: null, error: String(err) }, 502);
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

// ── 404 catch-all ─────────────────────────────────────────────────────────────

app.notFound((c) =>
  c.json({ error_code: "not_found", message: "Route not found" }, 404)
);

export default { fetch: app.fetch } satisfies ExportedHandler<KnowledgeEnv>;
