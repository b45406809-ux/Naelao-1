/**
 * Naelao Knowledge Worker
 * Handles KB document ingestion, Vectorize indexing, and hybrid semantic search.
 *
 * Gap IDs fulfilled: G-B01..G-B15 (KB System)
 */

import { Hono } from "hono";
import { requestId, errorResponse, notFound, badRequest, unauthorized, internalError, safeKvPut, requireInternalHmac } from "@naelao/http";
import { chunkText, chunkStructuredMarkdown, embedText, embedBatch, googleModeSearch, lookupSemanticCache, searchPermissionedKnowledge, wrapContextChunk, UNTRUSTED_CONTEXT_INSTRUCTION, verifyCitationCoordinate, type GroundedSearchHit, type RetrievalScope } from "@naelao/rag";
import { buildRetrievalPredicate, checkSsrf, isRetrievalRecordAllowed, isSpaceNetworkEgressDenied, KNOWLEDGE_ROLE_MASK, type KnowledgeRole } from "@naelao/security";
import { EntitlementsChecker, getPlanLimits } from "@naelao/entitlements";
import { moderateInput } from "@naelao/llm-gateway";
import { createParseV5Request } from "./parse-v5.js";
import { sparseRank } from "./search.js";
import { reportKnowledgeStorageWrite } from "./storage-usage.js";

// ── Environment ───────────────────────────────────────────────────────────────

interface KnowledgeEnv {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  BILLING_WORKER?: Fetcher;
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

// WS-4: Vectorize metadata cannot filter on an absent field like SQL's `IS NULL`. Use a stable,
// non-empty sentinel so the shared retrieval contract accepts the scope while project-scoped and
// space-wide queries remain disjoint. `_space` is explicit in telemetry/cache keys and cannot
// collide with generated project IDs.
const SPACE_WIDE_PROJECT_SENTINEL = "_space";

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

async function knowledgeEgressDenied(env: KnowledgeEnv, spaceId: string): Promise<boolean> {
  return isSpaceNetworkEgressDenied(env.PLATFORM_DB, spaceId);
}

function airGapResponse(c: { json: (body: unknown, status: 403) => Response }): Response {
  return c.json({
    error_code: "air_gap_egress_denied",
    message: "This operation is unavailable because the space blocks network and managed-service egress",
  }, 403);
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

async function requireProjectAccess(c: any, projectId: string, minimumRoleRank = 0): Promise<{ tenantId: string; spaceId: string; userId: string } | Response> {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const roleRank = effectiveRoleRank(c);
  if (roleRank < minimumRoleRank) return c.json({ error_code: "forbidden", message: "Project owner access required" }, 403);
  const scope: RetrievalScope = { tenantId, spaceId, projectId, roleRank };
  if (!(await authorizeProject(c.env.PLATFORM_DB, scope, userId))) throw notFound("Project not found");
  return { tenantId, spaceId, userId };
}

const EXTERNAL_PUBLICATION_ID = /^[a-z][a-z0-9_-]{2,63}$/;

// Owner-approved publication is an explicit list of canonical, indexed project documents.
// Merely uploading a project file never adds it to this declassification boundary.
app.get("/spaces/:spaceId/kb/projects/:projectId/external-publications", async (c) => {
  const projectId = c.req.param("projectId");
  const access = await requireProjectAccess(c, projectId);
  if (access instanceof Response) return access;
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT p.id,p.name,p.updated_at,COUNT(d.document_id) AS document_count,GROUP_CONCAT(d.document_id, ',') AS document_ids
     FROM kb_external_publications p LEFT JOIN kb_external_publication_documents d
       ON d.publication_id=p.id AND d.tenant_id=p.tenant_id AND d.space_id=p.space_id AND d.project_id=p.project_id
     WHERE p.tenant_id=? AND p.space_id=? AND p.project_id=? GROUP BY p.id ORDER BY p.name,p.id`
  ).bind(access.tenantId, access.spaceId, projectId).all<{ id: string; name: string; updated_at: string; document_count: number; document_ids: string | null }>();
  return c.json({ publications: results.map(({ document_ids, ...publication }) => ({
    ...publication, document_ids: document_ids ? document_ids.split(",") : [],
  })) });
});

app.put("/spaces/:spaceId/kb/projects/:projectId/external-publications/:publicationId", async (c) => {
  const { spaceId, projectId, publicationId } = c.req.param();
  if (!EXTERNAL_PUBLICATION_ID.test(publicationId)) throw badRequest("Invalid publication id");
  const access = await requireProjectAccess(c, projectId, 40);
  if (access instanceof Response) return access;
  const body = await c.req.json<{ name?: unknown; document_ids?: unknown }>().catch(() => null);
  if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.length > 120
    || !Array.isArray(body.document_ids) || body.document_ids.length > 100
    || body.document_ids.some((id) => typeof id !== "string" || id.length < 1 || id.length > 160)) {
    throw badRequest("name and at most 100 document_ids are required");
  }
  const documentIds = [...new Set(body.document_ids as string[])];
  if (documentIds.length !== body.document_ids.length) throw badRequest("document_ids must be unique");
  if (documentIds.length) {
    const placeholders = documentIds.map(() => "?").join(",");
    const { results } = await c.env.PLATFORM_DB.prepare(
      `SELECT id FROM kb_documents WHERE tenant_id=? AND space_id=? AND project_id=? AND status='indexed' AND id IN (${placeholders})`
    ).bind(access.tenantId, spaceId, projectId, ...documentIds).all<{ id: string }>();
    if (results.length !== documentIds.length) throw badRequest("Every document must be indexed and belong to this project");
  }
  const existing = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=?"
  ).bind(publicationId, access.tenantId, spaceId, projectId).first();
  const collision = existing ? null : await c.env.PLATFORM_DB.prepare("SELECT id FROM kb_external_publications WHERE id=?").bind(publicationId).first();
  if (collision) throw notFound("Knowledge publication");
  const now = new Date().toISOString();
  const statements = [c.env.PLATFORM_DB.prepare(
    `INSERT INTO kb_external_publications(id,tenant_id,space_id,project_id,name,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at
     WHERE tenant_id=excluded.tenant_id AND space_id=excluded.space_id AND project_id=excluded.project_id`
  ).bind(publicationId, access.tenantId, spaceId, projectId, body.name.trim(), access.userId, now, now),
  c.env.PLATFORM_DB.prepare("DELETE FROM kb_external_publication_documents WHERE publication_id=? AND tenant_id=? AND space_id=? AND project_id=?")
    .bind(publicationId, access.tenantId, spaceId, projectId)];
  for (const documentId of documentIds) statements.push(c.env.PLATFORM_DB.prepare(
    "INSERT INTO kb_external_publication_documents(publication_id,tenant_id,space_id,project_id,document_id,added_at) VALUES(?,?,?,?,?,?)"
  ).bind(publicationId, access.tenantId, spaceId, projectId, documentId, now));
  await c.env.PLATFORM_DB.batch(statements);
  return c.json({ publication_id: publicationId, project_id: projectId, name: body.name.trim(), document_ids: documentIds }, 200);
});

app.delete("/spaces/:spaceId/kb/projects/:projectId/external-publications/:publicationId", async (c) => {
  const { spaceId, projectId, publicationId } = c.req.param();
  const access = await requireProjectAccess(c, projectId, 40);
  if (access instanceof Response) return access;
  const result = await c.env.PLATFORM_DB.prepare(
    "DELETE FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=?"
  ).bind(publicationId, access.tenantId, spaceId, projectId).run();
  return result.meta.changes ? c.json({ deleted: true, publication_id: publicationId }) : c.json({ error_code: "not_found" }, 404);
});

// Service-only retrieval contract for the Agents host. It ranks only vectors whose doc_id is in
// the selected published collection, then rechecks every hit against the relational publication
// rows before returning source-attributed, untrusted text. No general project-KB search is used.
app.post("/internal/spaces/:spaceId/kb/projects/:projectId/external-search", async (c) => {
  const tenantId = requireTenant(c);
  const { spaceId, projectId } = c.req.param();
  if (await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);
  if (!(await verifySpaceOwnership(c.env.PLATFORM_DB, spaceId, tenantId))) throw notFound("Space not found");
  const body = await c.req.json<{ publication_id?: unknown; query?: unknown; top_k?: unknown }>().catch(() => null);
  if (!body || typeof body.publication_id !== "string" || !EXTERNAL_PUBLICATION_ID.test(body.publication_id)
    || typeof body.query !== "string" || !body.query.trim() || body.query.length > 1_000) throw badRequest("publication_id and query are required");
  const publication = await c.env.PLATFORM_DB.prepare(
    `SELECT id FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=?`
  ).bind(body.publication_id, tenantId, spaceId, projectId).first();
  if (!publication) throw notFound("Knowledge publication");
  const docs = await c.env.PLATFORM_DB.prepare(
    `SELECT d.id,d.title FROM kb_external_publication_documents x JOIN kb_documents d ON d.id=x.document_id
     WHERE x.publication_id=? AND x.tenant_id=? AND x.space_id=? AND x.project_id=? AND d.tenant_id=x.tenant_id
       AND d.space_id=x.space_id AND d.project_id=x.project_id AND d.status='indexed' ORDER BY d.id LIMIT 100`
  ).bind(body.publication_id, tenantId, spaceId, projectId).all<{ id: string; title: string }>();
  if (!docs.results.length) return c.json({ data: [], context_instruction: UNTRUSTED_CONTEXT_INSTRUCTION });
  const topK = Math.max(1, Math.min(Number.isInteger(body.top_k) ? Number(body.top_k) : 5, 10));
  const embedding = await embedText(c.env.AI, body.query.trim());
  const matches = await c.env.KB_VECTORS.query(embedding.embedding, {
    topK: Math.min(100, Math.max(topK * 4, topK)), returnMetadata: "indexed",
    filter: { tenant_id: { $eq: tenantId }, space_id: { $eq: spaceId }, project_id: { $eq: projectId }, doc_id: { $in: docs.results.map(doc => doc.id) } },
  });
  const ids = [...new Set((matches.matches ?? []).map(match => match.id))];
  if (!ids.length) return c.json({ data: [], context_instruction: UNTRUSTED_CONTEXT_INSTRUCTION });
  const placeholders = ids.map(() => "?").join(",");
  const rows = await c.env.PLATFORM_DB.prepare(
    `SELECT k.id,k.document_id,k.content,k.content_hash,d.title FROM kb_chunks k
     JOIN kb_documents d ON d.id=k.document_id
     JOIN kb_external_publication_documents x ON x.document_id=k.document_id AND x.tenant_id=k.tenant_id AND x.space_id=k.space_id AND x.project_id=k.project_id
     WHERE k.id IN (${placeholders}) AND x.publication_id=? AND k.tenant_id=? AND k.space_id=? AND k.project_id=?
       AND d.status='indexed' AND k.deleted_at IS NULL`
  ).bind(...ids, body.publication_id, tenantId, spaceId, projectId).all<{ id: string; document_id: string; content: string; content_hash: string; title: string }>();
  const byId = new Map(rows.results.map(row => [row.id, row]));
  const scoreById = new Map((matches.matches ?? []).map(match => [match.id, match.score ?? 0]));
  const data = (await Promise.all(ids.map(async id => {
    const row = byId.get(id);
    return row ? { chunk_id: row.id, document_id: row.document_id, title: row.title, score: scoreById.get(id) ?? 0,
      content: await wrapContextChunk({ content: row.content }), content_hash: row.content_hash } : null;
  }))).filter((item): item is NonNullable<typeof item> => item !== null).slice(0, topK);
  return c.json({ data, context_instruction: UNTRUSTED_CONTEXT_INSTRUCTION });
});

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

// Foundry's source-reference checker and explicit cross-Space document-share route call these
// authenticated service endpoints. They return indexed/sanitized KB content only; callers must
// perform the source Space capability check before requesting a document body.
app.use("/internal/spaces/:spaceId/kb/*", requireInternalHmac((c) => (c as unknown as { env: KnowledgeEnv }).env.PLATFORM_SECRET));
app.post("/internal/spaces/:spaceId/kb/references/resolve", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const body = await c.req.json<{ document_ids?: unknown }>().catch(() => ({} as { document_ids?: unknown }));
  if (!Array.isArray(body.document_ids) || body.document_ids.length > 30 || body.document_ids.some((id) => typeof id !== "string" || id.length > 160)) {
    throw badRequest("document_ids must be an array of at most 30 IDs");
  }
  const ids = [...new Set(body.document_ids as string[])];
  if (ids.length === 0) return c.json({ documents: [] });
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT id, title, status, project_id FROM kb_documents WHERE tenant_id=? AND space_id=? AND id IN (${placeholders})`
  ).bind(tenantId, spaceId, ...ids).all<{ id: string; title: string; status: string; project_id: string | null }>();
  const byId = new Map(results.map((row) => [row.id, row]));
  return c.json({ documents: ids.map((id) => {
    const row = byId.get(id);
    return row ? { id, title: row.title, status: row.status, project_id: row.project_id, resolved: row.status === "indexed" && row.project_id === null }
      : { id, resolved: false, reason: "not_found" };
  }) });
});

app.get("/internal/spaces/:spaceId/kb/documents/:documentId/shared", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const documentId = c.req.param("documentId");
  const doc = await c.env.PLATFORM_DB.prepare(
    "SELECT id,title,source_url,status,project_id FROM kb_documents WHERE id=? AND tenant_id=? AND space_id=?"
  ).bind(documentId, tenantId, spaceId).first<{ id: string; title: string; source_url: string | null; status: string; project_id: string | null }>();
  if (!doc || doc.status !== "indexed" || doc.project_id !== null) throw notFound("Shareable knowledge document");
  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT chunk_index,content FROM kb_chunks WHERE document_id=? AND tenant_id=? AND space_id=? AND project_id=? AND deleted_at IS NULL ORDER BY chunk_index"
  ).bind(documentId, tenantId, spaceId, "_space").all<{ chunk_index: number; content: string }>();
  if (!results.length || results.some((row, index) => row.chunk_index !== index)) throw notFound("Shareable knowledge document");
  const content = results.map((row) => row.content).join("\n\n");
  if (new TextEncoder().encode(content).byteLength > 250_000) return c.json({ error_code: "document_share_size_limit" }, 413);
  return c.json({ document: { id: doc.id, title: doc.title, source_url: doc.source_url, content, chunk_count: results.length } });
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
  if (await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);

  const body = await c.req.json<{
    title?: string;
    content?: string;
    content_type?: string;
    source_url?: string;
    /** WS-4: optional — isolates this document to a single project's own KB, distinct from the
     *  space-wide default (omitted/null). */
    project_id?: string;
    required_role_rank?: number;
    /** Explicit sovereign-user allowlist. IDs are indexed, never evaluated after ranking. */
    allowed_user_ids?: string[];
  }>();
  const projectId = body.project_id ?? null;
  const requiredRoleRank = Math.max(0, Math.min(body.required_role_rank ?? 0, 50));
  const allowedUserIds = [...new Set((body.allowed_user_ids ?? []).filter((id) => typeof id === "string" && id.length > 0))].slice(0, 100);
  // An explicit user allowlist is USER_PRIVATE and therefore outranks role/project visibility.
  const allowedRoles = allowedUserIds.length > 0
    ? []
    : Object.entries(ROLE_RANK)
      .filter(([role, rank]) => role in KNOWLEDGE_ROLE_MASK && rank >= requiredRoleRank)
      .map(([role]) => role);
  const accessMasks = allowedRoles.map((role) => KNOWLEDGE_ROLE_MASK[role as KnowledgeRole]);
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

  let storageBytesWritten = 0;
  try {
    // ── G-BD01: Sanitize content — strip HTML, detect injection patterns ────
    const originalBytes = contentType === "pdf"
      ? Uint8Array.from(atob(body.content.replace(/^data:[^,]+,/, "")), (value) => value.charCodeAt(0))
      : new TextEncoder().encode(body.content);
    const originalKey = `kb/${spaceId}/${projectId ?? "_space"}/${docId}/original`;
    await c.env.KB_BUCKET.put(originalKey, originalBytes, { httpMetadata: { contentType: contentType === "pdf" ? "application/pdf" : "text/plain; charset=utf-8" } });
    storageBytesWritten += originalBytes.byteLength;
    const parsedContent = contentType === "pdf" ? await createParseV5Request(originalBytes, "application/pdf", c.env) : body.content;
    const { sanitized: sanitizedContent, injectionDetected } = sanitizeKbContent(parsedContent);
    if (injectionDetected) {
      // Flag in DB but do NOT reject — builders may legitimately document attacks
      await c.env.PLATFORM_DB.prepare(
        `UPDATE kb_documents SET status = 'flagged', updated_at = ? WHERE id = ?`
      ).bind(new Date().toISOString(), docId).run();
      console.warn(`[kb] Injection pattern detected in doc ${docId} for space ${spaceId}`);
    }

    // ── Chunking ────────────────────────────────────────────────────────────
    const structuralChunks = contentType === "pdf" ? chunkStructuredMarkdown(sanitizedContent) : [];
    const chunks = structuralChunks.length ? structuralChunks.map((chunk) => chunk.content) : chunkText(sanitizedContent);

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
        headingPath: structuralChunks[i]?.headingPath ?? [],
        ...coordinate,
      };
      const serializedChunk = JSON.stringify(chunkRecord);
      await c.env.KB_BUCKET.put(chunkR2Key(spaceId, projectId, docId, i), serializedChunk);
      storageBytesWritten += new TextEncoder().encode(serializedChunk).byteLength;
      await c.env.KB_BUCKET.put(citationR2Key(spaceId, projectId, docId, i), chunk, {
        customMetadata: { contentHash, tenantId, spaceId, projectId: projectId ?? SPACE_WIDE_PROJECT_SENTINEL },
      });
      storageBytesWritten += new TextEncoder().encode(chunk).byteLength;

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
          visibility: requiredRoleRank === 0 && allowedUserIds.length === 0 ? "public" : "restricted",
          allowed_roles: allowedRoles,
          allowed_user_ids: allowedUserIds,
          access_mask: accessMasks.reduce((mask, roleMask) => mask | roleMask, 0),
          allowedRolesMask: accessMasks.reduce((mask, roleMask) => mask | roleMask, 0),
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
        storageBytesWritten += new TextEncoder().encode(sanitizedContent).byteLength;
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

    await reportKnowledgeStorageWrite(c.env, tenantId, spaceId, projectId, docId, storageBytesWritten, true);
    return c.json(doc, 201);
  } catch (err) {
    // Mark document as failed on any error during processing
    await c.env.PLATFORM_DB.prepare(
      `UPDATE kb_documents SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
    )
      .bind(docId)
      .run()
      .catch(() => {/* best-effort */});
    await reportKnowledgeStorageWrite(c.env, tenantId, spaceId, projectId, docId, storageBytesWritten, false);

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

  // A title-only edit stays in D1. Content changes invoke Workers AI and Vectorize and therefore
  // must be rejected before document state or existing vectors are mutated.
  if (body.content && await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);

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
          visibility: "public",
          allowed_roles: ["owner", "admin", "editor", "member", "viewer"],
          allowed_user_ids: [],
          access_mask: 31,
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
  if (await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);
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
  // AutoRAG currently exposes no metadata-filter parameter. It must remain disabled here rather
  // than retrieve broadly and filter afterward (which would leak ranking density).
  const useAutoRag: boolean = false;

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
  const retrievalPredicate = buildRetrievalPredicate("k", { tenantId, spaceId, projectId: scope.projectId, userId, roleRank });
  const policyVersion = c.env.RETRIEVAL_POLICY_VERSION ?? "1";
  let mode: "autorag" | "hybrid" = useAutoRag ? "autorag" : "hybrid";
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
  if (useAutoRag) {
    try {
      const autoRagInstance = c.env.AUTORAG_KB_INSTANCE;
      if (!autoRagInstance) throw new Error("AutoRAG instance is not configured");
      const response = await timed("autorag_search_ms", () =>
        c.env.AI.autorag(autoRagInstance).search({
          query: query.trim(),
          max_num_results: topK,
          rewrite_query: true,
        })
      ) as { data?: Array<{ filename?: string; score?: number; content?: Array<{ text?: string }> }> };
      const data = (await Promise.all((response.data ?? [])
        .filter((item) => {
          const prefix = `autorag/${spaceId}/${projectId ?? "_space"}/`;
          return typeof item.filename === "string" && item.filename.startsWith(prefix);
        })
        .map(async (item, index) => {
          const filename = item.filename;
          if (!filename) return null;
          const leaf = filename.split("/").pop();
          if (!leaf) return null;
          const docId = leaf.replace(/\.md$/, "");
          return {
            chunk_id: `autorag:${docId}:${index}`,
            doc_id: docId,
            content: await wrapContextChunk({ content: (item.content ?? []).map((part) => part.text ?? "").join("\n") }),
            score: item.score ?? 0,
            citation: { document_id: docId, chunk_id: `autorag:${docId}:${index}`, byte_start: 0, byte_end: 0 },
          };
        }))).filter((item) => item !== null);
      return c.json({ data, context_instruction: UNTRUSTED_CONTEXT_INSTRUCTION, cached: false, retrieval_mode: "autorag", confidence: data[0]?.score ?? 0,
        live_grounding: false, latency_ms: telemetry["autorag_search_ms"] ?? 0 });
    } catch {
      // AutoRAG is optional. Preserve availability by falling back to the fully scoped hybrid
      // pipeline rather than exposing provider/configuration failures to callers.
      mode = "hybrid";
    }
  }
  const namespace = `${tenantId}:${spaceId}:${scope.projectId}:${roleRank}:${userId}:${mode}:${policyVersion}`;
  // Semantic answer cache is checked before any document or web retrieval. Its Vectorize filter
  // enforces space isolation in hardware and the helper applies the strict >.96 threshold.
  const queryEmbedding = await embedText(c.env.AI, query.trim());
  const semanticHit = await lookupSemanticCache(
    { vectors: c.env.SEMANTIC_CACHE_VECTORS, kv: c.env.SEMANTIC_CACHE_KV },
    queryEmbedding.embedding,
    spaceId,
  ).catch(() => null);
  if (semanticHit) {
    return c.json({ answer: semanticHit.text, data: [], citations: [], cached: true,
      cache_id: semanticHit.id, similarity: semanticHit.score, retrieval_mode: "semantic-cache",
      confidence: semanticHit.score, live_grounding: false });
  }
  let denseCandidates: Promise<GroundedSearchHit[]>;
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
    dense: async (_q, scoped) => {
      denseCandidates = timed("dense_search_ms", async () => {
      const callerRole = (c.req.header("x-naelao-role") ?? "viewer") as KnowledgeRole;
      if (!(callerRole in KNOWLEDGE_ROLE_MASK)) throw unauthorized("Invalid knowledge role");
      const found = await searchPermissionedKnowledge(c.env.KB_VECTORS, queryEmbedding.embedding, {
        tenantId: scoped.tenantId, spaceId: scoped.spaceId,
        ...(projectId ? { projectId } : {}), userId, role: callerRole,
        roleMask: KNOWLEDGE_ROLE_MASK[callerRole], topK: topK * 2,
      });
      const ids = (found.matches ?? []).map((m) => m.id);
      if (!ids.length) return [];
      const placeholders = ids.map(() => "?").join(",");
      const rows = await c.env.PLATFORM_DB.prepare(
        `SELECT k.*, d.title FROM kb_chunks k JOIN kb_documents d ON d.id=k.document_id
         WHERE k.id IN (${placeholders}) AND ${retrievalPredicate.sql} AND k.deleted_at IS NULL`
      ).bind(...ids, ...retrievalPredicate.binds).all<Record<string, unknown>>();
      const byId = new Map(rows.results.map((row) => [String(row.id), row]));
      return (found.matches ?? []).flatMap((match) => {
        const row = byId.get(match.id);
        if (!row) return [];
        const allowed = isRetrievalRecordAllowed({
          tenantId: String(row.tenant_id), spaceId: String(row.space_id), projectId: String(row.project_id),
          requiredRoleRank: Number(row.required_role_rank), content: String(row.content),
        }, { tenantId, spaceId, projectId: scope.projectId, userId, roleRank });
        return allowed ? [rowToHit(row, match.score ?? 0)] : [];
      });
      });
      return denseCandidates;
    },
    // BM25 operates only on the ACL-prefiltered candidate population, never a broad FTS result.
    sparse: async (q) => timed("sparse_search_ms", async () => sparseRank(q, await denseCandidates)),
    web: async (q, scoped) => timed("web_grounding_ms", async () => {
      if (!c.env.TAVILY_API_KEY) return [];
      const response = await fetch(TAVILY_SEARCH_URL, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: c.env.TAVILY_API_KEY, query: q, max_results: Math.min(topK, 5), search_depth: "basic" }) });
      if (!response.ok) return [];
      // Web excerpts stay external/untrusted until separately ingested. They deliberately receive
      // no fake internal R2 coordinates or citation identity.
      const data = await response.json<{ results?: TavilyResult[] }>();
      return (data.results ?? []).map((item, index) => ({ id: `web:${index}`, score: item.score ?? 0,
        content: item.content ?? "", r2Key: "", byteStart: 0, byteEnd: 0, title: item.title ?? "", url: item.url ?? "" }));
    }),
    emitTelemetry: (event) => {
      const payload = { ...event, ...telemetry, retrieval_mode: mode, result_count: 0 };
      c.env.KNOWLEDGE_ANALYTICS?.writeDataPoint({ blobs: [tenantId, spaceId, scope.projectId, JSON.stringify(payload)], doubles: [event.latencyMs, event.confidence] });
      console.log(JSON.stringify({ event: "knowledge.retrieval", ...payload }));
    },
  }, { confidenceThreshold: Number(c.env.RETRIEVAL_CONFIDENCE_THRESHOLD ?? "0.85"), limit: topK });

  const citationHits = result.hits.filter((hit) => hit.r2Key);
  const citationIndex = new Map(citationHits.map((hit, index) => [hit.id, index + 1]));
  const citations = citationHits.map((hit, index) => ({ index: index + 1, title: hit.title ?? "Untitled",
    docId: hit.id.split("_chunk_")[0], snippet: hit.content.slice(0, 280), r2Key: hit.r2Key,
    charOffset: hit.byteStart,
    url: `/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId ?? SPACE_WIDE_PROJECT_SENTINEL)}/citations/${encodeURIComponent(hit.id.split("_chunk_")[0] ?? "")}/${encodeURIComponent(hit.id)}` }));
  const data = await Promise.all(result.hits.map(async (hit) => ({
    chunk_id: hit.id, doc_id: hit.id.split("_chunk_")[0], content: await wrapContextChunk(hit), score: hit.score,
    citation: hit.r2Key ? { document_id: hit.id.split("_chunk_")[0], chunk_id: hit.id,
      index: citationIndex.get(hit.id), title: hit.title, snippet: hit.content.slice(0, 280),
      content_hash: undefined, byte_start: hit.byteStart, byte_end: hit.byteEnd,
      line_start: hit.lineStart, line_end: hit.lineEnd } : null,
  })));
  return c.json({ data, citations, context_instruction: UNTRUSTED_CONTEXT_INSTRUCTION, cached: result.cacheHit, retrieval_mode: mode, confidence: result.confidence,
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

const SEMANTIC_CACHE_SIMILARITY_THRESHOLD = 0.96;
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
  if (await knowledgeEgressDenied(c.env, body.spaceId)) return airGapResponse(c);

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
    if (!top || (top.score ?? 0) <= SEMANTIC_CACHE_SIMILARITY_THRESHOLD) {
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
  if (await knowledgeEgressDenied(c.env, body.spaceId)) return airGapResponse(c);

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
  if (await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);

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

async function requireWebToolEgress(c: Parameters<typeof airGapResponse>[0] & {
  req: { header: (name: string) => string | undefined };
  env: KnowledgeEnv;
}): Promise<Response | null> {
  const spaceId = c.req.header("x-naelao-space-id")?.trim();
  // Internal callers must identify the policy owner. Missing identity fails closed instead of
  // silently turning this platform endpoint into an ungoverned egress path.
  if (!spaceId || await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);
  return null;
}

app.post("/internal/web-search/search", async (c) => {
  const denied = await requireWebToolEgress(c);
  if (denied) return denied;
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
  const denied = await requireWebToolEgress(c);
  if (denied) return denied;
  const body = await c.req.json<{ url?: string; format?: "markdown" | "html" }>().catch(() => ({} as { url?: string; format?: "markdown" | "html" }));
  const rawUrl = (body.url ?? "").trim();
  if (!rawUrl) return c.json({ error_code: "bad_request", message: "url required" }, 400);
  if (body.format !== undefined && body.format !== "markdown" && body.format !== "html") {
    return c.json({ error_code: "bad_request", message: "format must be markdown or html" }, 400);
  }
  let target: URL;
  try {
    target = new URL(rawUrl);
    if (!(target.protocol === "http:" || target.protocol === "https:") || target.username || target.password) throw new Error("unsupported URL");
  } catch {
    return c.json({ error_code: "bad_request", message: "url must be an http(s) URL without embedded credentials" }, 400);
  }
  try {
    // Handle redirects ourselves so every destination receives the SSRF and space-egress checks.
    // Automatic redirect following would validate only the first URL and could reach a private IP.
    let resp: Response | undefined;
    for (let hop = 0; hop <= 5; hop++) {
      const ssrf = await checkSsrf(target.href);
      if (ssrf.blocked) return c.json({ error_code: "forbidden", message: ssrf.reason ?? "url failed SSRF validation" }, 403);
      resp = await fetch(target.href, {
        headers: {
          "user-agent": "naelao-agent/1.0",
          accept: body.format === "markdown" ? "text/markdown, text/html;q=0.9, */*;q=0.8" : "text/html, */*;q=0.8",
        },
        redirect: "manual",
      });
      if (![301, 302, 303, 307, 308].includes(resp.status)) break;
      const location = resp.headers.get("location");
      if (!location) return c.json({ error_code: "bad_gateway", message: "redirect response omitted Location" }, 502);
      if (hop === 5) return c.json({ error_code: "bad_gateway", message: "redirect limit exceeded" }, 502);
      target = new URL(location, target);
      if (!(target.protocol === "http:" || target.protocol === "https:") || target.username || target.password) {
        return c.json({ error_code: "forbidden", message: "redirect destination must be an http(s) URL without embedded credentials" }, 403);
      }
    }
    if (!resp) throw new Error("fetch produced no response");
    const { content, truncated } = await readBoundedText(resp, WEB_SEARCH_CONTENT_CAP);
    const contentType = resp.headers.get("content-type") ?? "";
    return c.json({
      url: target.href,
      status: resp.status,
      content,
      content_type: contentType,
      format: contentType.toLowerCase().startsWith("text/markdown") ? "markdown" : "source",
      markdown_requested: body.format === "markdown",
      truncated,
    });
  } catch (err) {
    return c.json({ url: rawUrl, status: 0, content: "", error: String(err) }, 502);
  }
});

async function readBoundedText(response: Response, maxBytes: number): Promise<{ content: string; truncated: boolean }> {
  if (!response.body) return { content: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let content = "";
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        if (remaining > 0) content += decoder.decode(value.subarray(0, remaining), { stream: true });
        content += decoder.decode();
        truncated = true;
        await reader.cancel();
        break;
      }
      bytesRead += value.byteLength;
      content += decoder.decode(value, { stream: true });
    }
    if (!truncated) content += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { content, truncated };
}

app.post("/internal/web-search/extract", async (c) => {
  const denied = await requireWebToolEgress(c);
  if (denied) return denied;
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
  const denied = await requireWebToolEgress(c);
  if (denied) return denied;
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
