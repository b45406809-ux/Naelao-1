/**
 * Naelao Knowledge Worker
 * Handles KB document ingestion, Vectorize indexing, and hybrid semantic search.
 *
 * Gap IDs fulfilled: G-B01..G-B15 (KB System)
 */

import { Hono } from "hono";
import { HttpError, RequestBodyTooLargeError, requestId, errorResponse, notFound, badRequest, unauthorized, internalError, safeKvPut, requireInternalHmac, parseBoundedInteger, readBoundedRequestText, readBoundedResponseJson } from "@naelao/http";
import { chunkText, chunkStructuredMarkdown, embedText, embedBatch, googleModeSearch, lookupSemanticCache, searchPermissionedKnowledge, wrapContextChunk, UNTRUSTED_CONTEXT_INSTRUCTION, verifyCitationCoordinate, type GroundedSearchHit, type RetrievalScope, type StructuralChunk } from "@naelao/rag";
import { buildRetrievalPredicate, checkSsrf, isRetrievalRecordAllowed, isSpaceNetworkEgressDenied, KNOWLEDGE_ROLE_MASK, type KnowledgeRole } from "@naelao/security";
import { EntitlementsChecker, getPlanLimits } from "@naelao/entitlements";
import { moderateInput } from "@naelao/llm-gateway";
import { createParseV5Request } from "./parse-v5.js";
import { queryScopedFtsCandidates, sparseRank } from "./search.js";
import { reportKnowledgeStorageWrite } from "./storage-usage.js";
import { acquireKnowledgeDocumentMutationLease, hasKnowledgeDocumentDeletionSince, hasPendingKnowledgeDocumentDeletion, processKnowledgeDocumentDeletion,
  reconcileKnowledgeDocumentDeletions, releaseKnowledgeDocumentMutationLease, renewKnowledgeDocumentMutationLease, type KnowledgeDeletionBindings,
  type KnowledgeDocumentDeletion } from "./document-deletion.js";
import { exportKnowledgeArchive, previewKnowledgeArchiveRestore, restoreKnowledgeArchive, validateKnowledgeArchiveSnapshot } from "./knowledge-archive.js";
import { createKnowledgePdfPreviewToken, KNOWLEDGE_PDF_PARSER_VERSION, sha256BytesHex, verifyKnowledgePdfPreviewToken } from "./pdf-preview.js";
import { revisionExternalPublicationsForDocument } from "./external-publication-lifecycle.js";
import { createWebsitePreviewToken, sha256TextHex, verifyWebsitePreviewToken } from "./website-source-preview.js";

// ── Environment ───────────────────────────────────────────────────────────────

interface KnowledgeEnv {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  EVENTS_QUEUE: Queue;
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
  /** Response/retrieval caches remain off until caller and source/grant freshness are acceptance-tested. */
  KNOWLEDGE_RESPONSE_CACHE_ENABLED?: string;
  KNOWLEDGE_ANALYTICS?: AnalyticsEngineDataset;
}

const deletionBindings = (env: KnowledgeEnv): KnowledgeDeletionBindings => env;

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

async function readBoundedJson<T>(request: Request, maximumBytes: number): Promise<T> {
  let text: string;
  try {
    text = await readBoundedRequestText(request, maximumBytes);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) throw new HttpError(413, "payload_too_large", "Request body exceeds its size limit");
    throw badRequest("Request body must contain valid UTF-8 JSON");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw badRequest("Request body must contain valid JSON");
  }
}

async function readBoundedJsonOr<T>(request: Request, maximumBytes: number, fallback: T): Promise<T> {
  try {
    return await readBoundedJson<T>(request, maximumBytes);
  } catch (err) {
    if (err instanceof HttpError && err.status === 413) throw err;
    return fallback;
  }
}

function preserveHttpStatus(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err && typeof err === "object" && "status" in err && Number.isInteger(err.status)
    && Number(err.status) >= 400 && Number(err.status) <= 599) {
    const status = Number(err.status);
    throw new HttpError(status, status >= 500 ? "upstream_error" : "bad_request",
      err instanceof Error ? err.message : "Request failed");
  }
  throw internalError(`Document processing failed: ${err instanceof Error ? err.message : String(err)}`);
}

const app = new Hono<{ Bindings: KnowledgeEnv }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });
app.get("/health", c => c.json({ status: "ok", service: "knowledge", env: c.env.ENVIRONMENT }));

// Register trust-boundary middleware before route handlers. Hono executes handlers in
// registration order, so adding these guards below a route leaves that earlier route ungated.
app.use("/spaces/:spaceId/kb/*", requireInternalHmac((c) => (c as unknown as { env: KnowledgeEnv }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/citations/*", requireInternalHmac((c) => (c as unknown as { env: KnowledgeEnv }).env.PLATFORM_SECRET));
app.use("/internal/spaces/:spaceId/kb/*", requireInternalHmac((c) => (c as unknown as { env: KnowledgeEnv }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/kb/*", async (c, next) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const owned = await verifySpaceOwnership(c.env.PLATFORM_DB, spaceId, tenantId);
  if (!owned) throw notFound("Space not found");
  await next();
});
app.use("/internal/spaces/:spaceId/kb/*", async (c, next) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const owned = await verifySpaceOwnership(c.env.PLATFORM_DB, spaceId, tenantId);
  if (!owned) throw notFound("Space not found");
  await next();
});

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
    .prepare(`SELECT 1 FROM spaces s JOIN orgs o ON o.id = s.tenant_id AND o.status = 'active'
              WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'active'`)
    .bind(spaceId, tenantId)
    .first();
  return row !== null;
}

function publicKnowledgeDocument<T extends Record<string, unknown> | null>(row: T): T {
  if (!row) return row;
  const { allowed_user_ids_json: _allowedUserIds, archive_restore_id: _archiveRestoreId,
    source_content_sha256: _sourceContentHash, source_connection_ref: _sourceConnectionRef,
    source_grant_revision: _sourceGrantRevision, ...publicRow } = row;
  return publicRow as T;
}

async function verifySpaceTenantOwnership(db: D1Database, spaceId: string, tenantId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM spaces WHERE id = ? AND tenant_id = ?")
    .bind(spaceId, tenantId).first();
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
  return await projectRoleRank(db, scope.tenantId, scope.spaceId, scope.projectId, userId) !== null;
}

async function projectRoleRank(db: D1Database, tenantId: string, spaceId: string, projectId: string | null, userId: string): Promise<number | null> {
  if (!projectId || !userId) return null;
  try {
    const access = await db.prepare(
      `SELECT role_rank FROM project_access
       WHERE project_id = ? AND user_id = ? AND tenant_id = ? AND space_id = ?`
    ).bind(projectId, userId, tenantId, spaceId)
      .first<{ role_rank: number }>();
    return access && Number.isSafeInteger(access.role_rank) && access.role_rank >= 0 ? access.role_rank : null;
  } catch {
    // Schema/service-policy failures must never widen access.
    return null;
  }
}

async function requireProjectAccess(c: any, projectId: string, minimumRoleRank = 0): Promise<{ tenantId: string; spaceId: string; userId: string } | Response> {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const projectRank = await projectRoleRank(c.env.PLATFORM_DB, tenantId, spaceId, projectId, userId);
  if (projectRank === null) throw notFound("Project not found");
  // Product sessions carry a fixed `product_end_user` platform role. For Project actions, the
  // exact user ACL is the authority that distinguishes owner/admin/editor/member/viewer.
  const roleRank = c.req.header("x-naelao-role") === "product_end_user" ? projectRank : effectiveRoleRank(c);
  if (roleRank < minimumRoleRank) return c.json({ error_code: "forbidden", message: "Project owner access required" }, 403);
  return { tenantId, spaceId, userId };
}

const EXTERNAL_PUBLICATION_ID = /^[a-z][a-z0-9_-]{2,63}$/;
const WEBSITE_SOURCE_CONTENT_CAP = 1_048_576;
const WEBSITE_REFRESH_LEASE_MS = 2 * 60_000;

interface WebsiteConnectionGrant {
  id: string;
  tenant_id: string;
  space_id: string;
  owner_user_id: string;
  project_id: string | null;
  origins_json: string;
  knowledge_path_prefixes_json: string;
  status: string;
}

function websiteConnectionOrigins(row: WebsiteConnectionGrant): string[] | null {
  try {
    const value: unknown = JSON.parse(row.origins_json);
    if (!Array.isArray(value) || value.length > 16 || value.some((origin) => typeof origin !== "string")) return null;
    return [...new Set(value as string[])];
  } catch {
    return null;
  }
}

function websiteConnectionPathPrefixes(row: WebsiteConnectionGrant): string[] | null {
  try {
    const value: unknown = JSON.parse(row.knowledge_path_prefixes_json);
    if (!Array.isArray(value) || value.length < 1 || value.length > 16
      || value.some((prefix) => typeof prefix !== "string" || !prefix.startsWith("/") || prefix.length > 256
        || prefix.includes("\\") || /[?#\u0000-\u001f\u007f]/.test(prefix))) return null;
    return [...new Set(value as string[])];
  } catch {
    return null;
  }
}

function websitePathAllowed(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    if (prefix === "/") return true;
    const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return pathname === base || pathname.startsWith(`${base}/`);
  });
}

type WebsiteTargetAuthorization =
  | { ok: true }
  | { ok: false; status: 403 | 502; message: string };

function parseWebsiteRobots(content: string): Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let group: { agents: string[]; rules: Array<{ allow: boolean; path: string }> } | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0]!.trim();
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent" && value) {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && (key === "allow" || key === "disallow") && value) {
      group.rules.push({ allow: key === "allow", path: value });
    }
  }
  return groups;
}

function robotsAllowsPath(groups: ReturnType<typeof parseWebsiteRobots>, pathname: string): boolean {
  const productGroups = groups.filter((entry) => entry.agents.some((agent) => agent.includes("naelaoknowledge")));
  const selected = productGroups.length ? productGroups : groups.filter((entry) => entry.agents.includes("*"));
  const matches: Array<{ allow: boolean; specificity: number }> = [];
  for (const entry of selected) for (const rule of entry.rules) {
    const anchored = rule.path.endsWith("$");
    const source = rule.path.slice(0, anchored ? -1 : undefined);
    const escaped = source.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    if (new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(pathname)) {
      matches.push({ allow: rule.allow, specificity: source.replace(/\*/g, "").length });
    }
  }
  if (!matches.length) return true;
  const longest = Math.max(...matches.map((entry) => entry.specificity));
  return matches.filter((entry) => entry.specificity === longest).some((entry) => entry.allow);
}

function createWebsiteTargetAuthorizer(origins: readonly string[], prefixes: readonly string[], signal: AbortSignal) {
  type RobotsPolicy =
    | { ok: true; groups: ReturnType<typeof parseWebsiteRobots> }
    | { ok: false; status: 403 | 502; message: string };
  const robotsByOrigin = new Map<string, Promise<RobotsPolicy>>();
  return async (target: URL): Promise<WebsiteTargetAuthorization> => {
    if (!websitePathAllowed(target.pathname, prefixes)) {
      return { ok: false, status: 403, message: "The page path is outside the owner-approved Knowledge paths" };
    }
    let robots = robotsByOrigin.get(target.origin);
    if (!robots) {
      robots = (async (): Promise<RobotsPolicy> => {
        const robotsUrl = new URL("/robots.txt", target.origin).href;
        const result = await fetchSsrfGuarded(robotsUrl, {
          headers: { "user-agent": "NaelaoKnowledge", accept: "text/plain" },
          signal,
        }, origins);
        if (!result.ok) return { ok: false, status: result.status, message: "The site's robots policy could not be checked safely" };
        if (result.response.status === 404 || result.response.status === 410) {
          await result.response.body?.cancel().catch(() => undefined);
          return { ok: true, groups: [] };
        }
        if (result.response.status === 401 || result.response.status === 403) {
          await result.response.body?.cancel().catch(() => undefined);
          return { ok: false, status: 403, message: "The site does not permit reading its robots policy" };
        }
        if (!result.response.ok) {
          await result.response.body?.cancel().catch(() => undefined);
          return { ok: false, status: 502, message: "The site's robots policy is temporarily unavailable" };
        }
        const contentType = (result.response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
        if (contentType && contentType !== "text/plain") {
          await result.response.body?.cancel().catch(() => undefined);
          return { ok: false, status: 502, message: "The site's robots policy response has an unsupported content type" };
        }
        const body = await readBoundedText(result.response, 256 * 1024);
        if (body.truncated) return { ok: false, status: 502, message: "The site's robots policy exceeds the supported size" };
        const groups = parseWebsiteRobots(body.content);
        return { ok: true, groups };
      })();
      robotsByOrigin.set(target.origin, robots);
    }
    const policy = await robots;
    if (!policy.ok) return policy;
    return robotsAllowsPath(policy.groups, target.pathname)
      ? { ok: true }
      : { ok: false, status: 403, message: "The site's robots policy disallows this page" };
  };
}

function collectionProjectAction(c: any, projectId: string, action: "discover" | "read" | "manage" | "share" | "delete" | "administer") {
  const minimumRole = action === "discover" || action === "read" ? 0 : 40;
  return requireProjectAccess(c, projectId, minimumRole);
}

function validCollectionRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;
}

// Owner-approved publication is an explicit list of canonical, indexed project documents.
// Merely uploading a project file never adds it to this declassification boundary.
app.get("/spaces/:spaceId/kb/projects/:projectId/external-publications", async (c) => {
  const projectId = c.req.param("projectId");
  const access = await collectionProjectAction(c, projectId, "discover");
  if (access instanceof Response) return access;
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT p.id,p.name,p.updated_at,p.revision,p.archived_at,COUNT(d.document_id) AS document_count
     FROM kb_external_publications p LEFT JOIN kb_external_publication_documents d
       ON d.publication_id=p.id AND d.tenant_id=p.tenant_id AND d.space_id=p.space_id AND d.project_id=p.project_id
         AND d.publication_revision=p.revision
         AND EXISTS (SELECT 1 FROM kb_documents source_doc WHERE source_doc.id=d.document_id AND source_doc.status='indexed'
           AND (source_doc.source_adapter!='website' OR (source_doc.source_state='current' AND EXISTS (
             SELECT 1 FROM website_connections wc WHERE wc.id=source_doc.source_connection_ref AND wc.tenant_id=source_doc.tenant_id
               AND wc.space_id=source_doc.space_id AND wc.project_id=source_doc.project_id AND wc.status='active'
           ))))
     WHERE p.tenant_id=? AND p.space_id=? AND p.project_id=? GROUP BY p.id ORDER BY p.name,p.id`
  ).bind(access.tenantId, access.spaceId, projectId).all<{ id: string; name: string; updated_at: string; revision: number; archived_at: string | null; document_count: number }>();
  return c.json({ publications: results.map(({ archived_at, ...publication }) => ({
    ...publication, archived: archived_at !== null,
  })) }, 200, { "cache-control": "private, no-store" });
});

// Discovery reveals collection metadata only. Call the scoped source endpoint to read the
// selected collection's current document membership.
app.get("/spaces/:spaceId/kb/projects/:projectId/external-publications/:publicationId/sources", async c => {
  const { spaceId, projectId, publicationId } = c.req.param();
  if (!EXTERNAL_PUBLICATION_ID.test(publicationId)) throw badRequest("Invalid publication id");
  const access = await collectionProjectAction(c, projectId, "read");
  if (access instanceof Response) return access;
  const publication = await c.env.PLATFORM_DB.prepare(
    `SELECT revision FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND archived_at IS NULL`
  ).bind(publicationId, access.tenantId, spaceId, projectId).first<{ revision: number }>();
  if (!publication) return c.json({ error_code: "not_found" }, 404);
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT x.document_id FROM kb_external_publication_documents x
     JOIN kb_external_publications p ON p.id=x.publication_id AND p.tenant_id=x.tenant_id AND p.space_id=x.space_id
       AND p.project_id=x.project_id AND p.revision=x.publication_revision AND p.archived_at IS NULL
     JOIN kb_documents d ON d.id=x.document_id AND d.tenant_id=x.tenant_id AND d.space_id=x.space_id AND d.project_id=x.project_id
     WHERE x.publication_id=? AND x.tenant_id=? AND x.space_id=? AND x.project_id=? AND p.revision=?
       AND d.status='indexed'
       AND (d.source_adapter!='website' OR (d.source_state='current' AND EXISTS (
         SELECT 1 FROM website_connections wc WHERE wc.id=d.source_connection_ref AND wc.tenant_id=d.tenant_id
           AND wc.space_id=d.space_id AND wc.project_id=d.project_id AND wc.status='active'
       ))) ORDER BY x.document_id LIMIT 100`
  ).bind(publicationId, access.tenantId, spaceId, projectId, publication.revision).all<{ document_id: string }>();
  const stillCurrent = await c.env.PLATFORM_DB.prepare(
    `SELECT revision FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=?
       AND revision=? AND archived_at IS NULL`
  ).bind(publicationId, access.tenantId, spaceId, projectId, publication.revision).first<{ revision: number }>();
  if (!stillCurrent) return c.json({ error_code: "knowledge_publication_revision_conflict" }, 409);
  return c.json({ publication_id: publicationId, revision: publication.revision, document_ids: results.map(row => row.document_id) }, 200,
    { "cache-control": "private, no-store" });
});

// Administration exposes only lifecycle receipts and requires Project owner/admin authority.
app.get("/spaces/:spaceId/kb/projects/:projectId/external-publications/:publicationId/events", async c => {
  const { spaceId, projectId, publicationId } = c.req.param();
  if (!EXTERNAL_PUBLICATION_ID.test(publicationId)) throw badRequest("Invalid publication id");
  const access = await collectionProjectAction(c, projectId, "administer");
  if (access instanceof Response) return access;
  const publication = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=?"
  ).bind(publicationId, access.tenantId, spaceId, projectId).first<{ id: string }>();
  const tombstone = publication ? null : await c.env.PLATFORM_DB.prepare(
    "SELECT publication_id FROM kb_external_publication_tombstones WHERE publication_id=? AND tenant_id=? AND space_id=? AND project_id=?"
  ).bind(publicationId, access.tenantId, spaceId, projectId).first<{ publication_id: string }>();
  if (!publication && !tombstone) return c.json({ error_code: "not_found" }, 404);
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT event_id,actor_id,action,from_revision,to_revision,created_at FROM kb_external_publication_events
     WHERE tenant_id=? AND space_id=? AND project_id=? AND publication_id=? ORDER BY to_revision DESC,event_id DESC LIMIT 100`
  ).bind(access.tenantId, spaceId, projectId, publicationId).all<{
    event_id: string; actor_id: string; action: "published" | "updated" | "archived" | "restored_as_draft" | "deleted";
    from_revision: number; to_revision: number; created_at: string;
  }>();
  return c.json({ publication_id: publicationId, events: results }, 200, { "cache-control": "private, no-store" });
});

// Host-only revision directory used to compare a stored installation grant with the current
// owner-published collection before extension retrieval. It intentionally omits document IDs.
app.get("/internal/spaces/:spaceId/kb/projects/:projectId/external-publications", async c => {
  const tenantId = requireTenant(c), { spaceId, projectId } = c.req.param();
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT id,revision FROM kb_external_publications
     WHERE tenant_id=? AND space_id=? AND project_id=? AND archived_at IS NULL ORDER BY id LIMIT 100`
  ).bind(tenantId, spaceId, projectId).all<{ id: string; revision: number }>();
  c.header("cache-control", "private, no-store");
  return c.json({ publications: results });
});

app.put("/spaces/:spaceId/kb/projects/:projectId/external-publications/:publicationId", async (c) => {
  const { spaceId, projectId, publicationId } = c.req.param();
  if (!EXTERNAL_PUBLICATION_ID.test(publicationId)) throw badRequest("Invalid publication id");
  const access = await collectionProjectAction(c, projectId, "manage");
  if (access instanceof Response) return access;
  const body = await readBoundedJsonOr(c.req.raw, 64 * 1024, null as { name?: unknown; document_ids?: unknown; expected_revision?: unknown } | null);
  if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.length > 120
    || !Array.isArray(body.document_ids) || body.document_ids.length > 100
    || body.document_ids.some((id) => typeof id !== "string" || id.length < 1 || id.length > 160)
    || !validCollectionRevision(body.expected_revision)) {
    throw badRequest("name, expected_revision, and at most 100 document_ids are required");
  }
  const documentIds = [...new Set(body.document_ids as string[])];
  if (documentIds.length !== body.document_ids.length) throw badRequest("document_ids must be unique");
  if (documentIds.length) {
    const placeholders = documentIds.map(() => "?").join(",");
    const { results } = await c.env.PLATFORM_DB.prepare(
      `SELECT id FROM kb_documents WHERE tenant_id=? AND space_id=? AND project_id=? AND status='indexed'
        AND (source_adapter!='website' OR (source_state='current' AND EXISTS (
          SELECT 1 FROM website_connections wc WHERE wc.id=kb_documents.source_connection_ref AND wc.tenant_id=kb_documents.tenant_id
            AND wc.space_id=kb_documents.space_id AND wc.project_id=kb_documents.project_id AND wc.status='active'
        ))) AND id IN (${placeholders})`
    ).bind(access.tenantId, spaceId, projectId, ...documentIds).all<{ id: string }>();
    if (results.length !== documentIds.length) throw badRequest("Every document must be indexed and belong to this project");
  }
  const existing = await c.env.PLATFORM_DB.prepare(
    "SELECT id,revision,archived_at FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=?"
  ).bind(publicationId, access.tenantId, spaceId, projectId).first<{ id: string; revision: number; archived_at: string | null }>();
  const retired = existing ? null : await c.env.PLATFORM_DB.prepare(
    "SELECT tenant_id,space_id,project_id FROM kb_external_publication_tombstones WHERE publication_id=?"
  ).bind(publicationId).first<{ tenant_id: string; space_id: string; project_id: string }>();
  if (retired) {
    if (retired.tenant_id !== access.tenantId || retired.space_id !== spaceId || retired.project_id !== projectId)
      throw notFound("Knowledge publication");
    return c.json({ error_code: "knowledge_publication_id_retired" }, 409);
  }
  const collision = existing ? null : await c.env.PLATFORM_DB.prepare("SELECT id FROM kb_external_publications WHERE id=?").bind(publicationId).first();
  if (collision) throw notFound("Knowledge publication");
  const currentRevision = existing?.revision ?? 0;
  if (body.expected_revision !== currentRevision) {
    return c.json({ error_code: "knowledge_publication_revision_conflict", current_revision: currentRevision }, 409);
  }
  if (existing?.archived_at !== null && existing?.archived_at !== undefined)
    return c.json({ error_code: "knowledge_publication_archived", current_revision: currentRevision }, 409);
  const now = new Date().toISOString();
  const mutationToken = crypto.randomUUID();
  const nextRevision = currentRevision + 1;
  const currentMutation = `EXISTS (SELECT 1 FROM kb_external_publications p WHERE p.id=? AND p.tenant_id=? AND p.space_id=?
    AND p.project_id=? AND p.revision=? AND p.mutation_token=?)`;
  const statements = [c.env.PLATFORM_DB.prepare(
    `INSERT INTO kb_external_publications(id,tenant_id,space_id,project_id,name,created_by,created_at,updated_at,revision,mutation_token)
     VALUES(?,?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at,
       revision=kb_external_publications.revision+1,mutation_token=excluded.mutation_token
     WHERE kb_external_publications.tenant_id=excluded.tenant_id AND kb_external_publications.space_id=excluded.space_id
       AND kb_external_publications.project_id=excluded.project_id AND kb_external_publications.revision=?
       AND kb_external_publications.archived_at IS NULL`
  ).bind(publicationId, access.tenantId, spaceId, projectId, body.name.trim(), access.userId, now, now, mutationToken, body.expected_revision),
  c.env.PLATFORM_DB.prepare(`DELETE FROM kb_external_publication_documents
     WHERE publication_id=? AND tenant_id=? AND space_id=? AND project_id=? AND ${currentMutation}`)
    .bind(publicationId, access.tenantId, spaceId, projectId, publicationId, access.tenantId, spaceId, projectId, nextRevision, mutationToken),
  c.env.PLATFORM_DB.prepare(`INSERT INTO kb_external_publication_events
      (event_id,tenant_id,space_id,project_id,publication_id,actor_id,action,from_revision,to_revision,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${currentMutation}`)
    .bind(crypto.randomUUID(), access.tenantId, spaceId, projectId, publicationId, access.userId,
      existing ? "updated" : "published", currentRevision, nextRevision, now,
      publicationId, access.tenantId, spaceId, projectId, nextRevision, mutationToken)];
  for (const documentId of documentIds) statements.push(c.env.PLATFORM_DB.prepare(
    `INSERT INTO kb_external_publication_documents(publication_id,tenant_id,space_id,project_id,document_id,added_at,publication_revision)
     SELECT ?,?,?,?,?,?,? WHERE ${currentMutation}`
  ).bind(publicationId, access.tenantId, spaceId, projectId, documentId, now, nextRevision,
    publicationId, access.tenantId, spaceId, projectId, nextRevision, mutationToken));
  await c.env.PLATFORM_DB.batch(statements);
  const saved = await c.env.PLATFORM_DB.prepare(
    "SELECT revision FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND mutation_token=?"
  ).bind(publicationId, access.tenantId, spaceId, projectId, mutationToken).first<{ revision: number }>();
  if (!saved) {
    const current = await c.env.PLATFORM_DB.prepare(
      "SELECT revision FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=?"
    ).bind(publicationId, access.tenantId, spaceId, projectId).first<{ revision: number }>();
    if (!current) throw notFound("Knowledge publication");
    return c.json({ error_code: "knowledge_publication_revision_conflict", current_revision: current.revision }, 409);
  }
  return c.json({ publication_id: publicationId, project_id: projectId, name: body.name.trim(), document_ids: documentIds, revision: saved.revision, archived: false }, 200);
});

app.put("/spaces/:spaceId/kb/projects/:projectId/external-publications/:publicationId/archive", async c => {
  const { spaceId, projectId, publicationId } = c.req.param();
  if (!EXTERNAL_PUBLICATION_ID.test(publicationId)) throw badRequest("Invalid publication id");
  const access = await collectionProjectAction(c, projectId, "manage");
  if (access instanceof Response) return access;
  const body = await readBoundedJsonOr(c.req.raw, 8 * 1024, null as { expected_revision?: unknown; archived?: unknown } | null);
  if (!body || !validCollectionRevision(body.expected_revision) || body.expected_revision < 1 || typeof body.archived !== "boolean")
    throw badRequest("expected_revision and archived are required");
  const current = await c.env.PLATFORM_DB.prepare(
    "SELECT revision,archived_at FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=?"
  ).bind(publicationId, access.tenantId, spaceId, projectId).first<{ revision: number; archived_at: string | null }>();
  if (!current) return c.json({ error_code: "not_found" }, 404);
  if (current.revision !== body.expected_revision)
    return c.json({ error_code: "knowledge_publication_revision_conflict", current_revision: current.revision }, 409);
  const isArchived = current.archived_at !== null;
  if (isArchived === body.archived)
    return c.json({ publication_id: publicationId, archived: isArchived, revision: current.revision }, 200);

  const now = new Date().toISOString();
  const mutationToken = crypto.randomUUID();
  const nextRevision = current.revision + 1;
  const statements = [c.env.PLATFORM_DB.prepare(
    `UPDATE kb_external_publications SET archived_at=?,archived_by=?,revision=revision+1,updated_at=?,mutation_token=?
     WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND revision=? AND archived_at IS ?`
  ).bind(body.archived ? now : null, body.archived ? access.userId : null, now, mutationToken,
    publicationId, access.tenantId, spaceId, projectId, current.revision, current.archived_at),
  c.env.PLATFORM_DB.prepare(`INSERT INTO kb_external_publication_events (
      event_id,tenant_id,space_id,project_id,publication_id,actor_id,action,from_revision,to_revision,created_at
    ) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (
      SELECT 1 FROM kb_external_publications p WHERE p.id=? AND p.tenant_id=? AND p.space_id=? AND p.project_id=?
        AND p.revision=? AND p.mutation_token=?
    )`)
    .bind(crypto.randomUUID(), access.tenantId, spaceId, projectId, publicationId, access.userId,
      body.archived ? "archived" : "restored_as_draft", current.revision, nextRevision, now,
      publicationId, access.tenantId, spaceId, projectId, nextRevision, mutationToken),
  c.env.PLATFORM_DB.prepare(`DELETE FROM kb_external_publication_documents
     WHERE publication_id=? AND tenant_id=? AND space_id=? AND project_id=?
       AND EXISTS (SELECT 1 FROM kb_external_publications p WHERE p.id=? AND p.tenant_id=? AND p.space_id=?
         AND p.project_id=? AND p.revision=? AND p.mutation_token=?)`)
    .bind(publicationId, access.tenantId, spaceId, projectId, publicationId, access.tenantId, spaceId,
      projectId, nextRevision, mutationToken)];
  await c.env.PLATFORM_DB.batch(statements);
  const saved = await c.env.PLATFORM_DB.prepare(
    "SELECT revision FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND mutation_token=?"
  ).bind(publicationId, access.tenantId, spaceId, projectId, mutationToken).first<{ revision: number }>();
  if (!saved) {
    const latest = await c.env.PLATFORM_DB.prepare(
      "SELECT revision FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=?"
    ).bind(publicationId, access.tenantId, spaceId, projectId).first<{ revision: number }>();
    return latest ? c.json({ error_code: "knowledge_publication_revision_conflict", current_revision: latest.revision }, 409)
      : c.json({ error_code: "not_found" }, 404);
  }
  return c.json({ publication_id: publicationId, archived: body.archived, revision: saved.revision }, 200);
});

app.delete("/spaces/:spaceId/kb/projects/:projectId/external-publications/:publicationId", async (c) => {
  const { spaceId, projectId, publicationId } = c.req.param();
  const access = await collectionProjectAction(c, projectId, "delete");
  if (access instanceof Response) return access;
  const body = await readBoundedJsonOr(c.req.raw, 8 * 1024, null as { expected_revision?: unknown } | null);
  if (!body || !validCollectionRevision(body.expected_revision) || body.expected_revision < 1)
    throw badRequest("expected_revision is required");
  const current = await c.env.PLATFORM_DB.prepare(
    "SELECT revision FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=?"
  ).bind(publicationId, access.tenantId, spaceId, projectId).first<{ revision: number }>();
  if (!current) return c.json({ error_code: "not_found" }, 404);
  if (body.expected_revision !== current.revision)
    return c.json({ error_code: "knowledge_publication_revision_conflict", current_revision: current.revision }, 409);
  const now = new Date().toISOString();
  const deletedRevision = current.revision + 1;
  const stillCurrent = `EXISTS (SELECT 1 FROM kb_external_publications p WHERE p.id=? AND p.tenant_id=? AND p.space_id=?
    AND p.project_id=? AND p.revision=?)`;
  const results = await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare(`INSERT INTO kb_external_publication_events
        (event_id,tenant_id,space_id,project_id,publication_id,actor_id,action,from_revision,to_revision,created_at)
      SELECT ?,?,?,?,?,?,'deleted',?,?,? WHERE ${stillCurrent}`)
      .bind(crypto.randomUUID(), access.tenantId, spaceId, projectId, publicationId, access.userId, current.revision, deletedRevision, now,
        publicationId, access.tenantId, spaceId, projectId, current.revision),
    c.env.PLATFORM_DB.prepare(`INSERT INTO kb_external_publication_tombstones
        (publication_id,tenant_id,space_id,project_id,deleted_revision,deleted_by,deleted_at)
      SELECT p.id,p.tenant_id,p.space_id,p.project_id,p.revision+1,?,? FROM kb_external_publications p
      WHERE p.id=? AND p.tenant_id=? AND p.space_id=? AND p.project_id=? AND p.revision=?`)
      .bind(access.userId, now, publicationId, access.tenantId, spaceId, projectId, current.revision),
    c.env.PLATFORM_DB.prepare(
      "DELETE FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND revision=?"
    ).bind(publicationId, access.tenantId, spaceId, projectId, current.revision),
  ]);
  if (!results[2]?.meta.changes) {
    const latest = await c.env.PLATFORM_DB.prepare(
      "SELECT revision FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=?"
    ).bind(publicationId, access.tenantId, spaceId, projectId).first<{ revision: number }>();
    return latest ? c.json({ error_code: "knowledge_publication_revision_conflict", current_revision: latest.revision }, 409)
      : c.json({ error_code: "not_found" }, 404);
  }
  return c.json({ deleted: true, publication_id: publicationId });
});

// Service-only retrieval contract for the Agents host. It ranks only vectors whose doc_id is in
// the selected published collection, then rechecks every hit against the relational publication
// rows before returning source-attributed, untrusted text. No general project-KB search is used.
app.post("/internal/spaces/:spaceId/kb/projects/:projectId/external-search", async (c) => {
  const tenantId = requireTenant(c);
  const { spaceId, projectId } = c.req.param();
  if (await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);
  if (!(await verifySpaceOwnership(c.env.PLATFORM_DB, spaceId, tenantId))) throw notFound("Space not found");
  const body = await readBoundedJsonOr(c.req.raw, 16 * 1024, null as { publication_id?: unknown; publication_revision?: unknown; query?: unknown; top_k?: unknown } | null);
  if (!body || typeof body.publication_id !== "string" || !EXTERNAL_PUBLICATION_ID.test(body.publication_id)
    || !Number.isSafeInteger(body.publication_revision) || Number(body.publication_revision) < 1
    || typeof body.query !== "string" || !body.query.trim() || body.query.length > 1_000) throw badRequest("publication_id, publication_revision, and query are required");
  const publication = await c.env.PLATFORM_DB.prepare(
    `SELECT id FROM kb_external_publications WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND revision=? AND archived_at IS NULL`
  ).bind(body.publication_id, tenantId, spaceId, projectId, body.publication_revision).first();
  if (!publication) throw notFound("Knowledge publication");
  const docs = await c.env.PLATFORM_DB.prepare(
    `SELECT d.id,d.title FROM kb_external_publication_documents x JOIN kb_documents d ON d.id=x.document_id
     JOIN kb_external_publications p ON p.id=x.publication_id AND p.tenant_id=x.tenant_id AND p.space_id=x.space_id
       AND p.project_id=x.project_id AND p.revision=x.publication_revision AND p.archived_at IS NULL
     WHERE x.publication_id=? AND x.tenant_id=? AND x.space_id=? AND x.project_id=? AND x.publication_revision=? AND d.tenant_id=x.tenant_id
       AND d.space_id=x.space_id AND d.project_id=x.project_id AND d.status='indexed'
       AND (d.source_adapter!='website' OR (d.source_state='current' AND EXISTS (
         SELECT 1 FROM website_connections wc WHERE wc.id=d.source_connection_ref AND wc.tenant_id=d.tenant_id
           AND wc.space_id=d.space_id AND wc.project_id=d.project_id AND wc.status='active'
       ))) ORDER BY d.id LIMIT 100`
  ).bind(body.publication_id, tenantId, spaceId, projectId, body.publication_revision).all<{ id: string; title: string }>();
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
     JOIN kb_external_publications p ON p.id=x.publication_id AND p.tenant_id=x.tenant_id AND p.space_id=x.space_id AND p.project_id=x.project_id
     WHERE k.id IN (${placeholders}) AND x.publication_id=? AND x.publication_revision=? AND p.revision=? AND p.archived_at IS NULL
       AND k.tenant_id=? AND k.space_id=? AND k.project_id=?
       AND d.status='indexed' AND k.deleted_at IS NULL
       AND (d.source_adapter!='website' OR (d.source_state='current' AND EXISTS (
         SELECT 1 FROM website_connections wc WHERE wc.id=d.source_connection_ref AND wc.tenant_id=d.tenant_id
           AND wc.space_id=d.space_id AND wc.project_id=d.project_id AND wc.status='active'
       )))`
  ).bind(...ids, body.publication_id, body.publication_revision, body.publication_revision, tenantId, spaceId, projectId).all<{ id: string; document_id: string; content: string; content_hash: string; title: string }>();
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

function decodePdfContent(value: string): Uint8Array {
  const match = /^data:application\/pdf;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  const encoded = match?.[1] ?? value;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw badRequest("PDF content must be valid Base64 bytes");
  }
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
    if (!bytes.byteLength) throw badRequest("PDF document is empty");
    return bytes;
  } catch {
    throw badRequest("PDF content must be valid Base64 bytes");
  }
}

function safeKnowledgeSourceFileName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 512) throw badRequest("source_file_name must be at most 512 characters");
  const name = value.replace(/\\/g, "/").split("/").pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name.length > 255 || !/\.pdf$/i.test(name)) throw badRequest("source_file_name must be a PDF filename");
  return name;
}

interface KnowledgeCreateIdempotencyScope {
  tenantId: string;
  spaceId: string;
  projectId: string | null;
  keySha256: string;
  requestSha256: string;
  documentId: string;
  createdAt: string;
}

type KnowledgeIngestionDispatchState = "claimed" | "dispatching";

interface IdempotentKnowledgeCreate {
  document: IdempotentKnowledgeDocument;
  dispatchState: KnowledgeIngestionDispatchState;
}

interface IdempotentKnowledgeDocument {
  id: string;
  tenant_id: string;
  space_id: string;
  project_id: string | null;
  title: string;
  source_url: string | null;
  content_type: string;
  status: string;
  chunk_count: number;
  source_adapter: "manual" | "website" | "connector";
  source_revision: number;
  source_content_sha256: string | null;
  source_state: "current" | "stale" | "revoked" | "unsupported";
  created_at: string;
  updated_at: string;
}

async function findKnowledgeCreateByIdempotency(
  db: D1Database,
  scope: Pick<KnowledgeCreateIdempotencyScope, "tenantId" | "spaceId" | "projectId" | "keySha256">,
  requestSha256: string,
): Promise<IdempotentKnowledgeCreate | null> {
  const projectScope = scope.projectId ?? "";
  const claim = await db.prepare(`SELECT request_sha256,document_id,state,dispatch_state FROM kb_document_idempotency_requests
    WHERE tenant_id=? AND space_id=? AND project_scope=? AND key_sha256=?`)
    .bind(scope.tenantId, scope.spaceId, projectScope, scope.keySha256)
    .first<{ request_sha256: string | null; document_id: string; state: "active" | "deleted"; dispatch_state: KnowledgeIngestionDispatchState }>();
  if (!claim) return null;
  if (claim.state === "deleted") throw new HttpError(410, "knowledge_create_request_deleted", "This upload request was already deleted");
  if (claim.request_sha256 !== requestSha256) {
    throw new HttpError(409, "knowledge_idempotency_key_reused", "This upload request key was already used with different content or access settings");
  }
  const document = await db.prepare(`SELECT id,tenant_id,space_id,project_id,title,source_url,content_type,status,
    chunk_count,source_adapter,source_revision,source_content_sha256,source_state,created_at,updated_at
    FROM kb_documents WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ?`)
    .bind(claim.document_id, scope.tenantId, scope.spaceId, scope.projectId)
    .first<IdempotentKnowledgeDocument>();
  if (!document) throw new HttpError(503, "knowledge_idempotency_document_unavailable", "The saved upload request is being reconciled; retry shortly");
  return { document, dispatchState: claim.dispatch_state };
}

async function insertKnowledgeDocumentOnce(
  db: D1Database,
  input: { values: unknown[]; idempotency: KnowledgeCreateIdempotencyScope },
): Promise<{ created: boolean; existing: IdempotentKnowledgeCreate | null }> {
  const columns = `(id,space_id,tenant_id,project_id,title,source_url,content_type,status,chunk_count,required_role_rank,
    allowed_user_ids_json,source_sha256,source_file_name,parser_version,parser_output_sha256,approved_content_sha256,
    created_at,updated_at,source_adapter,source_content_sha256,source_state,source_connection_ref,source_grant_revision,
    source_last_attempt_at,source_last_success_at,source_requested_url)`;
  const projection = `SELECT ?,?,?,?,?,?,?,'processing',0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?`;
  const idem = input.idempotency;
  const projectScope = idem.projectId ?? "";
  const results = await db.batch([
    db.prepare(`INSERT INTO kb_document_idempotency_requests
      (tenant_id,space_id,project_scope,key_sha256,request_sha256,document_id,state,created_at)
      VALUES(?,?,?,?,?,?,'active',?) ON CONFLICT(tenant_id,space_id,project_scope,key_sha256) DO NOTHING`)
      .bind(idem.tenantId, idem.spaceId, projectScope, idem.keySha256, idem.requestSha256, idem.documentId, idem.createdAt),
    db.prepare(`INSERT INTO kb_documents ${columns} ${projection} WHERE EXISTS (
      SELECT 1 FROM kb_document_idempotency_requests WHERE tenant_id=? AND space_id=? AND project_scope=?
       AND key_sha256=? AND request_sha256=? AND document_id=? AND state='active')`)
      .bind(...input.values, idem.tenantId, idem.spaceId, projectScope, idem.keySha256, idem.requestSha256, idem.documentId),
  ]);
  if (results[1]?.meta.changes) return { created: true, existing: null };
  const existing = await findKnowledgeCreateByIdempotency(db, idem, idem.requestSha256);
  if (!existing) throw new HttpError(409, "knowledge_idempotency_claim_conflict", "Could not claim this upload request key");
  return { created: false, existing };
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

function chunkCoordinates(document: string, chunks: string[], sourceChunks?: StructuralChunk[]): Array<{ byteStart: number; byteEnd: number; lineStart: number; lineEnd: number }> {
  const encoder = new TextEncoder();
  let cursor = 0;
  return chunks.map((chunk, index) => {
    const sourceChunk = sourceChunks?.[index];
    const characterStart = sourceChunk ? sourceChunk.charOffset : document.indexOf(chunk, cursor);
    const start = Math.max(0, Math.min(document.length, characterStart < 0 ? cursor : characterStart));
    const end = sourceChunk
      ? Math.max(start, Math.min(document.length, sourceChunk.charEnd))
      : Math.min(document.length, start + chunk.length);
    cursor = end;
    return {
      byteStart: encoder.encode(document.slice(0, start)).byteLength,
      byteEnd: encoder.encode(document.slice(0, end)).byteLength,
      lineStart: document.slice(0, start).split("\n").length,
      lineEnd: document.slice(0, end).split("\n").length,
    };
  });
}

// Foundry's source-reference checker and explicit cross-Space document-share route call these
// authenticated service endpoints. They return indexed/sanitized KB content only; callers must
// perform the source Space capability check before requesting a document body.
app.post("/internal/spaces/:spaceId/kb/references/resolve", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const body = await readBoundedJsonOr(c.req.raw, 16 * 1024, {} as { document_ids?: unknown });
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

app.post("/internal/spaces/:spaceId/kb/archive/export", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  try {
    const result = await exportKnowledgeArchive(c.env, { tenantId, spaceId });
    // Object references already live beside their owning documents in the bounded snapshot.
    // Do not duplicate thousands of keys/ETags in the internal response body.
    return c.json({ snapshot: result.snapshot });
  } catch (error) {
    const code = (error as Error).message || "knowledge_archive_export_failed";
    const status = code.includes("limit_exceeded") ? 413
      : code.includes("scope_invalid") || code.includes("set_invalid") || code.includes("invalid") ? 409 : 503;
    return c.json({ error_code: /^[a-z0-9_]{1,96}$/.test(code) ? code : "knowledge_archive_export_failed" }, status);
  }
});

app.post("/internal/spaces/:spaceId/kb/archive/preview", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const body = await readBoundedJson<{ snapshot?: unknown; restoreId?: unknown }>(c.req.raw, 4 * 1024 * 1024);
  if (!body || typeof body.restoreId !== "string" || !/^[a-f0-9]{64}$/.test(body.restoreId)) {
    throw badRequest("Invalid Knowledge archive preview request");
  }
  try {
    const snapshot = await validateKnowledgeArchiveSnapshot(body.snapshot, { tenantId, spaceId });
    const preview = await previewKnowledgeArchiveRestore(c.env, snapshot, body.restoreId);
    return c.json({ preview });
  } catch (error) {
    const code = (error as Error).message || "knowledge_archive_preview_failed";
    const status = code.includes("limit_exceeded") ? 413 : code.includes("invalid") || code.includes("incompatible") ? 422 : 409;
    return c.json({ error_code: /^[a-z0-9_]{1,96}$/.test(code) ? code : "knowledge_archive_preview_failed" }, status);
  }
});

app.post("/internal/spaces/:spaceId/kb/archive/restore", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const body = await readBoundedJson<{ snapshot?: unknown; restoreId?: unknown }>(c.req.raw, 4 * 1024 * 1024);
  if (!body || typeof body.restoreId !== "string" || !/^[a-f0-9]{64}$/.test(body.restoreId)) {
    throw badRequest("Invalid Knowledge archive restore request");
  }
  try {
    const snapshot = await validateKnowledgeArchiveSnapshot(body.snapshot, { tenantId, spaceId });
    const restored = await restoreKnowledgeArchive(c.env, snapshot, body.restoreId);
    return c.json({ restored });
  } catch (error) {
    const code = (error as Error).message || "knowledge_archive_restore_failed";
    const status = code.includes("missing_after_restore") ? 409
      : code.includes("limit_exceeded") ? 413
        : code.includes("invalid") || code.includes("incompatible") ? 422 : 503;
    return c.json({ error_code: /^[a-z0-9_]{1,96}$/.test(code) ? code : "knowledge_archive_restore_failed" }, status);
  }
});

// ── GET /spaces/:spaceId/kb/documents ─────────────────────────────────────────

app.get("/spaces/:spaceId/kb/documents", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const url = new URL(c.req.url);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 1, 200);
  const offset = parseBoundedInteger(url.searchParams.get("offset"), 0, 0, 100_000);
  // WS-4: no project_id param = the pre-existing default, space-wide documents only
  // (project_id IS NULL) — never mixes in a project's own isolated documents by accident.
  const projectId = url.searchParams.get("project_id");
  if (projectId !== null) {
    const access = await requireProjectAccess(c, projectId);
    if (access instanceof Response) return access;
  }

  const { results } = await c.env.PLATFORM_DB.prepare(
    projectId
      ? `SELECT id, space_id, tenant_id, project_id, title, source_url, content_type, status,
                chunk_count, source_adapter, source_revision, source_state, source_requested_url,source_last_attempt_at,source_last_success_at,
                source_next_attempt_at,source_refresh_failures,source_last_error_code,created_at,updated_at
         FROM kb_documents
         WHERE space_id = ? AND tenant_id = ? AND project_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      : `SELECT id, space_id, tenant_id, project_id, title, source_url, content_type, status,
                chunk_count, source_adapter, source_revision, source_state, source_requested_url,source_last_attempt_at,source_last_success_at,
                source_next_attempt_at,source_refresh_failures,source_last_error_code,created_at,updated_at
         FROM kb_documents
         WHERE space_id = ? AND tenant_id = ? AND project_id IS NULL
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
  )
    .bind(...(projectId ? [spaceId, tenantId, projectId, limit, offset] : [spaceId, tenantId, limit, offset]))
    .all();

  return c.json({ data: results, count: results.length, limit, offset });
});

// A restored Knowledge document has canonical D1 chunks but intentionally no Vectorize or
// AutoRAG state. Expose those exact verified chunks only to the current Space/Project reader so
// the existing authenticated PATCH indexing path can rebuild provider indexes after an explicit
// owner action. Restore itself never calls this route or a provider.
app.get("/spaces/:spaceId/kb/documents/:docId/reindex-content", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const docId = c.req.param("docId");
  const document = await c.env.PLATFORM_DB.prepare(`SELECT id,title,project_id,status,chunk_count
    FROM kb_documents WHERE id=? AND tenant_id=? AND space_id=?`)
    .bind(docId, tenantId, spaceId)
    .first<{ id: string; title: string; project_id: string | null; status: string; chunk_count: number }>();
  if (!document || document.status !== "reindex_required") throw notFound("Restored Knowledge document");
  if (document.project_id) {
    const access = await requireProjectAccess(c, document.project_id);
    if (access instanceof Response) return access;
  }
  const mutationLease = await acquireKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, { documentId: docId, tenantId, spaceId });
  if (!mutationLease) return c.json({ error_code: "document_deletion_in_progress" }, 410);
  try {
    if (!Number.isSafeInteger(document.chunk_count) || document.chunk_count < 1 || document.chunk_count > 2_000) {
      return c.json({ error_code: "restored_knowledge_chunks_invalid" }, 409);
    }
    const { results: chunks } = await c.env.PLATFORM_DB.prepare(`SELECT chunk_index,content,content_hash,deleted_at
      FROM kb_chunks WHERE document_id=? AND tenant_id=? AND space_id=?
        AND project_id=? ORDER BY chunk_index`)
      .bind(docId, tenantId, spaceId, document.project_id ?? SPACE_WIDE_PROJECT_SENTINEL)
      .all<{ chunk_index: number; content: string; content_hash: string; deleted_at: string | null }>();
    if (chunks.length !== document.chunk_count || chunks.some((chunk, index) => chunk.chunk_index !== index
      || chunk.deleted_at !== null || typeof chunk.content !== "string" || !/^[a-f0-9]{64}$/.test(chunk.content_hash))) {
      return c.json({ error_code: "restored_knowledge_chunks_invalid" }, 409);
    }
    for (const chunk of chunks) {
      if (await sha256Hex(chunk.content) !== chunk.content_hash) return c.json({ error_code: "restored_knowledge_chunk_hash_mismatch" }, 409);
    }
    if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease)) {
      return c.json({ error_code: "document_deletion_in_progress" }, 410);
    }
    const content = chunks.map((chunk) => chunk.content).join("\n\n");
    if (!content || content.length > 1_048_576) return c.json({ error_code: "restored_knowledge_reindex_size_limit" }, 413);
    return c.json({ id: document.id, title: document.title, content, source: "restored_indexed_chunks" }, 200,
      { "cache-control": "private, no-store" });
  } finally {
    await releaseKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease);
  }
});

// Workflow-only large-document endpoints. These internal routes are guarded by the
// tenant-bound HMAC middleware registered above.
app.put("/internal/spaces/:spaceId/kb/documents/:docId/status", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const docId = c.req.param("docId");
  const body = await readBoundedJson<{ status?: unknown; chunk_count?: unknown; project_id?: unknown }>(c.req.raw, 16 * 1024);
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !new Set(["processing", "indexed", "failed"]).has(String(body.status)) ||
      typeof body.project_id !== "string" || !body.project_id || body.project_id.length > 256 ||
      (body.chunk_count !== undefined && (!Number.isSafeInteger(body.chunk_count) || Number(body.chunk_count) < 0 || Number(body.chunk_count) > 12_000))) {
    throw badRequest("Invalid workflow document status update");
  }
  const doc = await c.env.PLATFORM_DB.prepare(
    "SELECT id, status FROM kb_documents WHERE id = ? AND space_id = ? AND tenant_id = ? AND project_id = ?"
  ).bind(docId, spaceId, tenantId, body.project_id).first<{ id: string; status: string }>();
  if (!doc) throw notFound("KbDocument");
  if (doc.status === "deleting") return c.json({ error_code: "document_deletion_in_progress" }, 410);
  if (doc.status === "indexed" && body.status !== "indexed") return c.json({ error_code: "invalid_document_transition" }, 409);
  const result = await c.env.PLATFORM_DB.prepare(
    `UPDATE kb_documents SET status = ?, chunk_count = COALESCE(?, chunk_count), updated_at = datetime('now')
     WHERE id = ? AND space_id = ? AND tenant_id = ? AND project_id = ? AND status!='deleting'
       AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`
  ).bind(body.status, body.chunk_count ?? null, docId, spaceId, tenantId, body.project_id, docId).run();
  if (result.meta.changes === 0) throw notFound("KbDocument");
  return c.json({ id: docId, status: body.status });
});

app.post("/internal/spaces/:spaceId/kb/documents/:docId/ingest-chunks", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const docId = c.req.param("docId");
  if (await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);
  const body = await readBoundedJson<{
    chunks?: unknown; projectId?: unknown; chunkOffset?: unknown; byteOffset?: unknown; lineOffset?: unknown;
    requiredRoleRank?: unknown; allowedUserIds?: unknown;
  }>(c.req.raw, 700_000);
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      typeof body.projectId !== "string" || !body.projectId || body.projectId.length > 256 ||
      !Number.isSafeInteger(body.chunkOffset) || Number(body.chunkOffset) < 0 || Number(body.chunkOffset) >= 600 ||
      !Number.isSafeInteger(body.byteOffset) || Number(body.byteOffset) < 0 || Number(body.byteOffset) > 5 * 1024 * 1024 ||
      !Number.isSafeInteger(body.lineOffset) || Number(body.lineOffset) < 1 || Number(body.lineOffset) > 5 * 1024 * 1024 ||
      (body.requiredRoleRank !== undefined && (!Number.isSafeInteger(body.requiredRoleRank) || Number(body.requiredRoleRank) < 0 || Number(body.requiredRoleRank) > 50)) ||
      (body.allowedUserIds !== undefined && (!Array.isArray(body.allowedUserIds) || body.allowedUserIds.length > 100 ||
        body.allowedUserIds.some((id) => typeof id !== "string" || !id || id.length > 256))) ||
      !Array.isArray(body.chunks) || body.chunks.length === 0 || body.chunks.length > 50 ||
      body.chunks.some((chunk) => typeof chunk !== "string" || chunk.length === 0 || chunk.length > 10 * 1024)) {
    throw badRequest("Invalid workflow chunks");
  }
  const rawChunks = body.chunks as string[];
  const rawBytes = rawChunks.reduce((total, chunk) => total + new TextEncoder().encode(chunk).byteLength, 0);
  if (rawBytes > 5 * 1024 * 1024) throw new HttpError(413, "payload_too_large", "Workflow chunks exceed 5 MiB");
  for (const chunk of rawChunks) {
    for (let start = 0; start < chunk.length; start += 2_000) {
      const moderation = moderateInput(chunk.slice(start, start + 2_000));
      if (moderation.blocked) throw badRequest(`Document content contains disallowed content: ${moderation.reason}`);
    }
  }

  const doc = await c.env.PLATFORM_DB.prepare(
    `SELECT id, title, status, chunk_count, required_role_rank, allowed_user_ids_json
       FROM kb_documents WHERE id = ? AND space_id = ? AND tenant_id = ? AND project_id = ?`
  ).bind(docId, spaceId, tenantId, body.projectId).first<{ id: string; title: string; status: string; chunk_count: number;
    required_role_rank: number; allowed_user_ids_json: string | null }>();
  if (!doc) throw notFound("KbDocument");
  if (doc.status === "indexed") return c.json({ chunk_count: doc.chunk_count, idempotent: true });
  if (doc.status !== "processing" && doc.status !== "flagged") return c.json({ error_code: "document_not_processing" }, 409);
  const chunkOffset = Number(body.chunkOffset);
  if (doc.chunk_count < 1 || chunkOffset + rawChunks.length > doc.chunk_count) throw badRequest("Workflow chunk range is outside the document");

  const chunks = rawChunks.map((chunk) => sanitizeKbContent(chunk).sanitized);
  if (chunks.some((chunk) => chunk.length === 0)) throw badRequest("Workflow chunks cannot be empty after sanitization");
  const embeddings: Array<{ embedding: number[]; tokenCount: number }> = [];
  for (let start = 0; start < chunks.length; start += 50) embeddings.push(...await embedBatch(c.env.AI, chunks.slice(start, start + 50)));
  if (embeddings.length !== chunks.length) throw internalError("Embedding provider returned an incomplete batch");
  if (!(await verifySpaceOwnership(c.env.PLATFORM_DB, spaceId, tenantId))) throw notFound("Space");
  const mutationLease = await acquireKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, { documentId: docId, tenantId, spaceId });
  if (!mutationLease) return c.json({ error_code: "document_deletion_in_progress" }, 410);
  try {
  const projectId = body.projectId;
  const projectScope = projectId || SPACE_WIDE_PROJECT_SENTINEL;
  const requiredRoleRank = Number.isSafeInteger(doc.required_role_rank) ? doc.required_role_rank : Number(body.requiredRoleRank ?? 0);
  let allowedUserIds: string[];
  if (doc.allowed_user_ids_json !== null) {
    try {
      const storedAcl: unknown = JSON.parse(doc.allowed_user_ids_json);
      if (!Array.isArray(storedAcl) || storedAcl.length > 100 || storedAcl.some((id) => typeof id !== "string" || !id || id.length > 256)) {
        throw new Error("invalid_stored_acl");
      }
      allowedUserIds = [...new Set(storedAcl as string[])];
    } catch {
      throw internalError("Stored workflow access metadata is invalid");
    }
  } else {
    // Compatibility for work queued before the canonical ACL column was introduced.
    allowedUserIds = [...new Set((body.allowedUserIds ?? []) as string[])];
  }
  const now = new Date().toISOString();
  const roles = allowedUserIds.length > 0 ? [] : Object.entries(ROLE_RANK)
    .filter(([role, rank]) => role in KNOWLEDGE_ROLE_MASK && rank >= requiredRoleRank)
    .map(([role]) => role);
  const accessMask = roles.reduce((mask, role) => mask | KNOWLEDGE_ROLE_MASK[role as KnowledgeRole], 0);
  const visibility = requiredRoleRank === 0 && allowedUserIds.length === 0 ? "public" : "restricted";
  const vectors: VectorizeVector[] = [];
  let storageBytes = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease)) {
      throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
    }
    if (!(await verifySpaceOwnership(c.env.PLATFORM_DB, spaceId, tenantId))) throw notFound("Space");
    const chunk = chunks[i]!;
    const chunkIndex = chunkOffset + i;
    const byteLength = new TextEncoder().encode(chunk).byteLength;
    const lineStart = Number(body.lineOffset) + chunks.slice(0, i).reduce((lines, value) => lines + (value.match(/\n/g)?.length ?? 0), 0);
    const byteStart = Number(body.byteOffset) + chunks.slice(0, i).reduce((bytes, value) => bytes + new TextEncoder().encode(value).byteLength, 0);
    const lineEnd = lineStart + (chunk.match(/\n/g)?.length ?? 0);
    const coordinate = { byteStart, byteEnd: byteStart + byteLength, lineStart, lineEnd };
    const chunkId = `${docId}_chunk_${chunkIndex}`;
    const contentHash = await sha256Hex(chunk);
    const record: ChunkRecord = {
      docId, chunkIndex, content: chunk, spaceId, tenantId, projectId: projectScope,
      visibility: projectId ? "project" : "space", requiredRoleRank, chunkId, contentHash, sourceFreshness: now,
      headingPath: [], ...coordinate,
    };
    const serialized = JSON.stringify(record);
    const citationKey = citationR2Key(spaceId, projectId, docId, chunkIndex);
    await c.env.KB_BUCKET.put(chunkR2Key(spaceId, projectId, docId, chunkIndex), serialized);
    await c.env.KB_BUCKET.put(citationKey, chunk, { customMetadata: { contentHash, tenantId, spaceId, projectId: projectScope } });
    storageBytes += new TextEncoder().encode(serialized).byteLength + byteLength;
    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO kb_chunks (id, tenant_id, space_id, project_id, document_id, chunk_index, content, content_hash,
        visibility, required_role_rank, source_freshness, heading_path, r2_key, byte_start, byte_end, line_start, line_end, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, content_hash = excluded.content_hash,
        source_freshness = excluded.source_freshness, r2_key = excluded.r2_key, byte_start = excluded.byte_start,
        byte_end = excluded.byte_end, line_start = excluded.line_start, line_end = excluded.line_end, deleted_at = NULL`
    ).bind(chunkId, tenantId, spaceId, projectScope, docId, chunkIndex, chunk, contentHash,
      projectId ? "project" : "space", requiredRoleRank, now, citationKey,
      coordinate.byteStart, coordinate.byteEnd, coordinate.lineStart, coordinate.lineEnd, now).run();
    vectors.push({ id: chunkId, values: embeddings[i]!.embedding, metadata: {
      space_id: spaceId, tenant_id: tenantId, project_id: projectScope, visibility,
      allowed_roles: roles, allowed_user_ids: allowedUserIds, access_mask: accessMask, allowedRolesMask: accessMask,
      required_role_rank: requiredRoleRank, doc_id: docId, chunk_id: chunkId, content_hash: contentHash,
      source_freshness: now, ...coordinate, chunk_index: chunkIndex, title: doc.title, content_preview: chunk.slice(0, 200),
    } });
  }
  if (!(await verifySpaceOwnership(c.env.PLATFORM_DB, spaceId, tenantId))) throw notFound("Space");
  for (let start = 0; start < vectors.length; start += 100) {
    if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease)) {
      throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
    }
    await c.env.KB_VECTORS.upsert(vectors.slice(start, start + 100));
  }
  await reportKnowledgeStorageWrite(c.env, tenantId, spaceId, projectId, docId, storageBytes, true, `workflow-ingest:${docId}:${chunkOffset}`);
  return c.json({ id: docId, chunk_count: doc.chunk_count, batch_count: chunks.length });
  } finally {
    await releaseKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease);
  }
});

// ── POST /spaces/:spaceId/kb/documents ────────────────────────────────────────

app.post("/spaces/:spaceId/kb/projects/:projectId/sources/website/preview", async (c) => {
  const tenantId = requireTenant(c);
  const { spaceId, projectId } = c.req.param();
  if (await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);
  const access = await requireProjectAccess(c, projectId, 40);
  if (access instanceof Response) return access;
  const body = await readBoundedJson<{ connection_id?: unknown; url?: unknown; document_id?: unknown; idempotency_key?: unknown }>(c.req.raw, 8 * 1024);
  if ((body.connection_id !== undefined && (typeof body.connection_id !== "string" || !body.connection_id || body.connection_id.length > 256))
    || typeof body.url !== "string" || !body.url.trim() || body.url.length > WEB_TARGET_URL_MAX_CHARS) {
    throw badRequest("A URL from the approved website connection is required");
  }
  const refreshDocumentId = body.document_id === undefined ? null : typeof body.document_id === "string" && body.document_id.length <= 256 ? body.document_id : null;
  if (body.document_id !== undefined && (!refreshDocumentId || typeof body.idempotency_key !== "string"
    || !/^[A-Za-z0-9_-]{16,128}$/.test(body.idempotency_key))) {
    throw badRequest("Refreshing a saved website source requires a document ID and a 16–128 character idempotency key");
  }
  if (!refreshDocumentId && typeof body.connection_id !== "string") throw badRequest("connection_id is required for a new website source");
  let requested: URL;
  try { requested = new URL(body.url); }
  catch { throw badRequest("Website source URL is invalid"); }
  if (requested.protocol !== "https:" || requested.username || requested.password || requested.search || requested.hash) {
    throw badRequest("Website Knowledge sources must use HTTPS public page URLs without credentials, query strings, or fragments");
  }
  type RefreshDocument = { id: string; source_url: string; source_requested_url: string | null; source_revision: number;
    source_connection_ref: string; source_state: string; source_adapter: string };
  let refreshDocument: RefreshDocument | null = null;
  let connectionId = typeof body.connection_id === "string" ? body.connection_id : "";
  if (refreshDocumentId) {
    refreshDocument = await c.env.PLATFORM_DB.prepare(`SELECT id,source_url,source_requested_url,source_revision,source_connection_ref,source_state,source_adapter
      FROM kb_documents WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND status IN ('indexed','failed')`)
      .bind(refreshDocumentId, tenantId, spaceId, projectId).first<RefreshDocument>();
    if (!refreshDocument || refreshDocument.source_adapter !== "website" || refreshDocument.source_state !== "current"
      || !refreshDocument.source_url || (connectionId && refreshDocument.source_connection_ref !== connectionId)
      || (refreshDocument.source_requested_url ?? refreshDocument.source_url) !== requested.href) return c.json({ error_code: "website_source_not_refreshable" }, 404);
    connectionId = refreshDocument.source_connection_ref;
  }
  const connection = await c.env.PLATFORM_DB.prepare(`SELECT id,tenant_id,space_id,owner_user_id,project_id,origins_json,knowledge_path_prefixes_json,status
    FROM website_connections WHERE id=? AND tenant_id=? AND space_id=? AND owner_user_id=? AND project_id=? AND status='active'`)
    .bind(connectionId, tenantId, spaceId, access.userId, projectId).first<WebsiteConnectionGrant>();
  if (!connection) return c.json({ error_code: "website_connection_not_found" }, 404);
  const origins = websiteConnectionOrigins(connection);
  const pathPrefixes = websiteConnectionPathPrefixes(connection);
  if (!origins || !pathPrefixes) return c.json({ error_code: "website_connection_policy_invalid" }, 409);
  if (!origins.includes(requested.origin)) return c.json({ error_code: "website_origin_not_authorized" }, 403);

  let refreshOperationId: string | null = null;
  let refreshAttempt = 1;
  try {
    if (refreshDocument && typeof body.idempotency_key === "string") {
      const now = new Date().toISOString();
      const nextAttempt = await c.env.PLATFORM_DB.prepare(`SELECT id,request_sha256,state,attempt_count,next_attempt_at,last_attempt_at FROM kb_source_refresh_operations
        WHERE tenant_id=? AND space_id=? AND document_id=? AND idempotency_key_hash=?`)
        .bind(tenantId, spaceId, refreshDocument.id, await sha256Hex(body.idempotency_key))
        .first<{ id: string; request_sha256: string; state: string; attempt_count: number; next_attempt_at: string | null; last_attempt_at: string }>();
      const requestSha256 = await sha256Hex(JSON.stringify({ tenantId, spaceId, projectId, documentId: refreshDocument.id,
        connectionId: connection.id, sourceRevision: refreshDocument.source_revision, requestedUrl: requested.href }));
      if (nextAttempt && nextAttempt.request_sha256 !== requestSha256) {
        throw new HttpError(409, "website_refresh_key_reused", "This refresh request key was already used for another source version");
      }
      if (nextAttempt?.state === "completed" || nextAttempt?.state === "superseded") {
        throw new HttpError(409, "website_refresh_request_stale", "This source has already advanced; reload its current version before refreshing again");
      }
      if (nextAttempt?.state === "fetching") {
        const lastAttemptMs = Date.parse(nextAttempt.last_attempt_at);
        if (!Number.isFinite(lastAttemptMs) || Date.now() - lastAttemptMs < WEBSITE_REFRESH_LEASE_MS) {
          throw new HttpError(409, "website_refresh_in_progress", "A refresh attempt is already in progress");
        }
        const recoveredAt = new Date();
        const retryAt = new Date(recoveredAt.getTime() + Math.min(360, 2 ** Math.min(nextAttempt.attempt_count - 1, 8)) * 60_000).toISOString();
        const recovered = await c.env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_operations SET state='failed',
          error_code='website_refresh_interrupted',next_attempt_at=?,updated_at=?
          WHERE id=? AND state='fetching' AND last_attempt_at=?`)
          .bind(retryAt, recoveredAt.toISOString(), nextAttempt.id, nextAttempt.last_attempt_at).run();
        if (!recovered.meta.changes) throw new HttpError(409, "website_refresh_in_progress", "A refresh attempt is already being recovered");
        await c.env.PLATFORM_DB.prepare(`UPDATE kb_documents SET source_refresh_failures=source_refresh_failures+1,
          source_last_error_code='website_refresh_interrupted',source_next_attempt_at=?
          WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND source_revision=?
            AND source_connection_ref=? AND source_state='current'`)
          .bind(retryAt, refreshDocument.id, tenantId, spaceId, projectId, refreshDocument.source_revision, connection.id).run();
        return c.json({ error_code: "website_refresh_interrupted", retry_at: retryAt }, 429,
          { "retry-after": String(Math.max(1, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000))) });
      }
      if (nextAttempt?.next_attempt_at && Date.parse(nextAttempt.next_attempt_at) > Date.now()) {
        return c.json({ error_code: "website_refresh_backoff", retry_at: nextAttempt.next_attempt_at }, 429,
          { "retry-after": String(Math.max(1, Math.ceil((Date.parse(nextAttempt.next_attempt_at) - Date.now()) / 1000))) });
      }
      refreshOperationId = nextAttempt?.id ?? crypto.randomUUID();
      refreshAttempt = nextAttempt ? nextAttempt.attempt_count + 1 : 1;
      const claim = nextAttempt
        ? c.env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_operations SET state='fetching',attempt_count=attempt_count+1,
            final_url=NULL,preview_sha256=NULL,last_attempt_at=?,next_attempt_at=NULL,error_code=NULL,updated_at=?
          WHERE id=? AND state IN ('failed','preview_ready') AND request_sha256=?`)
          .bind(now, now, refreshOperationId, requestSha256)
        : c.env.PLATFORM_DB.prepare(`INSERT INTO kb_source_refresh_operations
          (id,tenant_id,space_id,project_id,document_id,connection_ref,source_revision,idempotency_key_hash,request_sha256,
           state,attempt_count,requested_url,last_attempt_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'fetching',1,?,?,?,?)`)
          .bind(refreshOperationId, tenantId, spaceId, projectId, refreshDocument.id, connection.id,
            refreshDocument.source_revision, await sha256Hex(body.idempotency_key), requestSha256, requested.href, now, now, now);
      try {
        const statements = [
          ...(!nextAttempt ? [c.env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_operations SET state='superseded',
            error_code='newer_refresh_requested',updated_at=? WHERE tenant_id=? AND space_id=? AND document_id=?
              AND source_revision=? AND state='preview_ready'`).bind(now, tenantId, spaceId, refreshDocument.id, refreshDocument.source_revision)] : []),
          claim,
          c.env.PLATFORM_DB.prepare(`UPDATE kb_documents SET source_last_attempt_at=?,source_last_error_code=NULL,source_next_attempt_at=NULL
            WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND source_revision=? AND source_connection_ref=?
              AND source_state='current' AND status IN ('indexed','failed') AND EXISTS (
                SELECT 1 FROM website_connections wc WHERE wc.id=source_connection_ref AND wc.status='active'
                  AND wc.tenant_id=kb_documents.tenant_id AND wc.space_id=kb_documents.space_id
                  AND wc.project_id=kb_documents.project_id
              )`).bind(now, refreshDocument.id, tenantId, spaceId, projectId, refreshDocument.source_revision, connection.id),
        ];
        const claimed = await c.env.PLATFORM_DB.batch(statements);
        const claimIndex = nextAttempt ? 0 : 1;
        if (!claimed[claimIndex]?.meta.changes) throw new HttpError(409, "website_refresh_in_progress", "A refresh attempt is already active for this source");
        if (!claimed[claimIndex + 1]?.meta.changes) {
          await c.env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_operations SET state='superseded',error_code='source_changed',updated_at=?
            WHERE id=? AND state='fetching'`).bind(now, refreshOperationId).run();
          throw new HttpError(409, "website_refresh_superseded", "The source changed or its connection was revoked before refresh started");
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(409, "website_refresh_in_progress", "A refresh attempt is already active for this source");
      }
    }
    const failRefresh = async (errorCode: string) => {
      if (!refreshOperationId || !refreshDocument) return;
      const backoffMinutes = Math.min(360, 2 ** Math.min(refreshAttempt - 1, 8));
      const now = new Date();
      const retryAt = new Date(now.getTime() + backoffMinutes * 60_000).toISOString();
      await c.env.PLATFORM_DB.batch([
        c.env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_operations SET state='failed',error_code=?,next_attempt_at=?,updated_at=?
          WHERE id=? AND state='fetching'`).bind(errorCode, retryAt, now.toISOString(), refreshOperationId),
        c.env.PLATFORM_DB.prepare(`UPDATE kb_documents SET source_refresh_failures=source_refresh_failures+1,
          source_last_error_code=?,source_next_attempt_at=? WHERE id=? AND tenant_id=? AND space_id=? AND source_revision=?
            AND source_connection_ref=? AND source_state='current'`)
          .bind(errorCode, retryAt, refreshDocument.id, tenantId, spaceId, refreshDocument.source_revision, connection.id),
      ]).catch(() => undefined);
    };
    const websiteFetchSignal = AbortSignal.timeout(45_000);
    const authorizeWebsiteTarget = createWebsiteTargetAuthorizer(origins, pathPrefixes, websiteFetchSignal);
    const guarded = await fetchSsrfGuarded(requested.href, {
      headers: { "user-agent": "naelao-knowledge/1.0", accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.7" },
      signal: websiteFetchSignal,
    }, origins, authorizeWebsiteTarget);
    if (!guarded.ok) {
      await failRefresh(guarded.status === 403 ? "website_destination_rejected" : "website_upstream_unavailable");
      return c.json({ error_code: guarded.status === 403 ? "forbidden" : "bad_gateway", message: guarded.message }, guarded.status);
    }
    if (!guarded.response.ok) {
      await failRefresh("website_upstream_status");
      return c.json({ error_code: "website_upstream_status", upstream_status: guarded.response.status }, 502);
    }
    const mime = (guarded.response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (!["text/markdown", "text/plain", "text/html", "application/xhtml+xml"].includes(mime)) {
      await guarded.response.body?.cancel().catch(() => undefined);
      await failRefresh("website_content_type_unsupported");
      return c.json({ error_code: "website_content_type_unsupported", message: "Only HTML, Markdown, and plain-text pages are supported" }, 415);
    }
    const fetched = await readBoundedText(guarded.response, WEBSITE_SOURCE_CONTENT_CAP);
    if (fetched.truncated) {
      await failRefresh("website_source_too_large");
      return c.json({ error_code: "website_source_too_large", limit_bytes: WEBSITE_SOURCE_CONTENT_CAP }, 413);
    }
    const { sanitized, injectionDetected } = sanitizeKbContent(fetched.content);
    if (!sanitized.trim()) {
      await failRefresh("website_source_empty");
      return c.json({ error_code: "website_source_empty" }, 422);
    }
    const approvedPreview = sanitized.trim();
    const previewSha256 = await sha256TextHex(approvedPreview);
    const token = await createWebsitePreviewToken({ secret: c.env.PLATFORM_SECRET,
      scope: { tenantId, spaceId, projectId, userId: access.userId, connectionId: connection.id },
      requestedUrl: requested.href, finalUrl: guarded.url.href, previewSha256,
      ...(refreshDocument && refreshOperationId ? { operation: "refresh" as const, documentId: refreshDocument.id,
        sourceRevision: refreshDocument.source_revision, refreshOperationId } : {}) });
    if (refreshDocument && refreshOperationId) {
      const now = new Date().toISOString();
      const ready = await c.env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_operations SET state='preview_ready',final_url=?,preview_sha256=?,
        next_attempt_at=NULL,error_code=NULL,updated_at=? WHERE id=? AND state='fetching' AND source_revision=?
          AND EXISTS (SELECT 1 FROM kb_documents d JOIN website_connections wc ON wc.id=d.source_connection_ref
            WHERE d.id=? AND d.source_revision=? AND d.status IN ('indexed','failed') AND d.source_state='current'
              AND wc.status='active' AND wc.id=kb_source_refresh_operations.connection_ref)`)
        .bind(guarded.url.href, previewSha256, now, refreshOperationId, refreshDocument.source_revision,
          refreshDocument.id, refreshDocument.source_revision).run();
      if (!ready.meta.changes) throw new HttpError(409, "website_refresh_superseded", "The source changed or its connection was revoked during refresh");
    }
    const warnings = ["Review the extracted page text before adding it. HTML markup is stripped; this is a bounded page snapshot and will not refresh automatically."];
    if (mime === "text/html" || mime === "application/xhtml+xml") warnings.push("Page extraction strips markup and may not preserve layout, tables, or client-rendered content.");
    if (injectionDetected) warnings.push("Potential prompt-injection text was detected. Indexed content remains untrusted and is subject to Knowledge safety filtering.");
    return c.json({ preview: { content: approvedPreview, requested_url: requested.href, final_url: guarded.url.href,
      content_type: mime, preview_sha256: previewSha256, preview_token: token, expires_in_seconds: 900, warnings,
      ...(refreshOperationId ? { refresh_operation_id: refreshOperationId, expected_source_revision: refreshDocument?.source_revision } : {}) } }, 200,
      { "cache-control": "private, no-store" });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (refreshOperationId && refreshDocument) {
      const now = new Date();
      const retryAt = new Date(now.getTime() + Math.min(360, 2 ** Math.min(refreshAttempt - 1, 8)) * 60_000).toISOString();
      await c.env.PLATFORM_DB.batch([
        c.env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_operations SET state='failed',error_code='website_preview_failed',
          next_attempt_at=?,updated_at=? WHERE id=? AND state='fetching'`).bind(retryAt, now.toISOString(), refreshOperationId),
        c.env.PLATFORM_DB.prepare(`UPDATE kb_documents SET source_refresh_failures=source_refresh_failures+1,
          source_last_error_code='website_preview_failed',source_next_attempt_at=? WHERE id=? AND source_revision=? AND source_state='current'`)
          .bind(retryAt, refreshDocument.id, refreshDocument.source_revision),
      ]).catch(() => undefined);
    }
    return c.json({ error_code: "website_preview_unavailable", message: "The website could not be fetched safely. Retry the preview." }, 502);
  }
});

app.post("/spaces/:spaceId/kb/documents/preview", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  if (await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);
  const body = await readBoundedJson<{ content?: string; project_id?: string; source_file_name?: string }>(c.req.raw, 8_000_000);
  if (body.project_id !== undefined && (typeof body.project_id !== "string" || !body.project_id || body.project_id.length > 256)) {
    throw badRequest("project_id must be a nonempty string of at most 256 characters");
  }
  const projectId = body.project_id ?? null;
  if (projectId) {
    const access = await requireProjectAccess(c, projectId);
    if (access instanceof Response) return access;
  }
  if (typeof body.content !== "string" || !body.content) throw badRequest("PDF content is required");
  const sourceFileName = safeKnowledgeSourceFileName(body.source_file_name);
  const sourceBytes = decodePdfContent(body.content);
  const contentLimit = projectId ? 5 * 1024 * 1024 : 1_048_576;
  if (sourceBytes.byteLength > contentLimit) {
    throw new HttpError(413, "knowledge_pdf_scope_limit_exceeded",
      projectId ? "Project Knowledge PDF files are limited to 5 MiB" : "Space-wide Knowledge PDF files are limited to 1 MiB");
  }
  if (new TextDecoder().decode(sourceBytes.subarray(0, 5)) !== "%PDF-") throw badRequest("The selected file is not a valid PDF document");

  let parsed: string;
  try {
    parsed = await createParseV5Request(sourceBytes, "application/pdf", c.env);
  } catch (error) {
    preserveHttpStatus(error);
  }
  const { sanitized: previewContent, injectionDetected } = sanitizeKbContent(parsed);
  if (!previewContent) throw badRequest("The PDF parser did not produce readable text");
  const previewBytes = new TextEncoder().encode(previewContent);
  if (previewBytes.byteLength > contentLimit) {
    throw new HttpError(413, "knowledge_pdf_extraction_limit_exceeded",
      projectId ? "Extracted text exceeds the 5 MiB Project Knowledge limit" : "Extracted text exceeds the 1 MiB Space-wide Knowledge limit; use a Project Knowledge Base");
  }
  const sourceSha256 = await sha256BytesHex(sourceBytes);
  const extractionSha256 = await sha256BytesHex(previewBytes);
  const previewToken = await createKnowledgePdfPreviewToken({ secret: c.env.PLATFORM_SECRET,
    scope: { tenantId, spaceId, projectId }, sourceSha256, extractionSha256 });
  const extractionWarnings = ["Review reading order, tables, and scanned pages before saving; automated PDF extraction can omit or misread them."];
  if (injectionDetected) extractionWarnings.push("Potential prompt-injection text was detected. The document will remain subject to Knowledge safety filtering.");
  return c.json({ preview: { content: previewContent, source_sha256: sourceSha256, extraction_sha256: extractionSha256,
    parser_version: KNOWLEDGE_PDF_PARSER_VERSION, preview_token: previewToken, source_file_name: sourceFileName,
    source_bytes: sourceBytes.byteLength, extracted_bytes: previewBytes.byteLength, extraction_warnings: extractionWarnings } });
});

app.post("/spaces/:spaceId/kb/documents", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  if (await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);

  const body = await readBoundedJson<{
    title?: string;
    content?: string;
    content_type?: string;
    source_url?: string;
    preview_content?: string;
    preview_token?: string;
    preview_extraction_sha256?: string;
    source_file_name?: string;
    website_connection_id?: string;
    website_requested_url?: string;
    website_preview_sha256?: string;
    website_preview_token?: string;
    idempotency_key: string;
    /** WS-4: optional — isolates this document to a single project's own KB, distinct from the
     *  space-wide default (omitted/null). */
    project_id?: string;
    required_role_rank?: number;
    /** Explicit sovereign-user allowlist. IDs are indexed, never evaluated after ranking. */
    allowed_user_ids?: string[];
  }>(c.req.raw, 14_000_000);
  if (typeof body.idempotency_key !== "string" || body.idempotency_key.length < 16 || body.idempotency_key.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(body.idempotency_key)) {
    throw badRequest("idempotency_key is required and must contain 16–128 URL-safe characters");
  }
  if (body.project_id !== undefined && (typeof body.project_id !== "string" || !body.project_id || body.project_id.length > 256)) {
    throw badRequest("project_id must be a nonempty string of at most 256 characters");
  }
  const projectId = body.project_id ?? null;
  if (body.required_role_rank !== undefined && (!Number.isSafeInteger(body.required_role_rank) || body.required_role_rank < 0 || body.required_role_rank > 50)) {
    throw badRequest("required_role_rank must be an integer from 0 to 50");
  }
  const requiredRoleRank = body.required_role_rank ?? 0;
  const rawAllowedUserIds: unknown = body.allowed_user_ids ?? [];
  if (!Array.isArray(rawAllowedUserIds) || rawAllowedUserIds.length > 100 || rawAllowedUserIds.some((id) => typeof id !== "string" || !id || id.length > 256)) {
    throw badRequest("allowed_user_ids must contain at most 100 nonempty IDs of at most 256 characters");
  }
  const allowedUserIds = [...new Set(rawAllowedUserIds as string[])];
  // An explicit user allowlist is USER_PRIVATE and therefore outranks role/project visibility.
  const allowedRoles = allowedUserIds.length > 0
    ? []
    : Object.entries(ROLE_RANK)
      .filter(([role, rank]) => role in KNOWLEDGE_ROLE_MASK && rank >= requiredRoleRank)
      .map(([role]) => role);
  const accessMasks = allowedRoles.map((role) => KNOWLEDGE_ROLE_MASK[role as KnowledgeRole]);
  const creatingWebsiteSource = body.website_connection_id !== undefined;
  if (projectId) {
    const access = await requireProjectAccess(c, projectId, creatingWebsiteSource ? 40 : 0);
    if (access instanceof Response) return access;
  }

  // Validate required fields
  if (!body.title || typeof body.title !== "string" || body.title.trim().length === 0) {
    throw badRequest("title is required");
  }
  if (body.title.length > 500) throw badRequest("title exceeds maximum size of 500 characters");
  if (typeof body.content !== "string" || !body.content.trim()) {
    throw badRequest("nonempty content is required");
  }

  const validContentTypes = new Set(["text", "url", "code", "pdf"]);
  const contentType = body.content_type ?? "text";
  if (!validContentTypes.has(contentType)) {
    throw badRequest(`content_type must be one of: text, url, code, pdf`);
  }

  const MAX_SYNC_CONTENT_BYTES = 1_048_576;
  const MAX_WORKFLOW_CONTENT_BYTES = 5 * 1024 * 1024;
  if (body.source_url !== undefined && (typeof body.source_url !== "string" || body.source_url.length > 2_048)) {
    throw badRequest("source_url must be a string of at most 2048 characters");
  }
  const originalBytes = contentType === "pdf" ? decodePdfContent(body.content) : new TextEncoder().encode(body.content);
  if (originalBytes.byteLength > MAX_WORKFLOW_CONTENT_BYTES) throw badRequest("content exceeds the 5 MiB ingestion limit");
  const sourceFileName = contentType === "pdf" ? safeKnowledgeSourceFileName(body.source_file_name) : null;
  const contentLimit = projectId ? MAX_WORKFLOW_CONTENT_BYTES : MAX_SYNC_CONTENT_BYTES;
  let indexContent = body.content;
  let pdfLineage: { sourceSha256: string; extractionSha256: string; approvedContentSha256: string } | undefined;
  if (contentType === "pdf") {
    if (new TextDecoder().decode(originalBytes.subarray(0, 5)) !== "%PDF-") throw badRequest("The selected file is not a valid PDF document");
    if (typeof body.preview_content !== "string" || !body.preview_content.trim() || typeof body.preview_extraction_sha256 !== "string") {
      throw new HttpError(409, "knowledge_pdf_preview_required", "Preview and approve the extracted PDF text before saving");
    }
    const sourceSha256 = await sha256BytesHex(originalBytes);
    const extractionSha256 = body.preview_extraction_sha256;
    if (!/^[a-f0-9]{64}$/.test(extractionSha256)) throw badRequest("PDF extraction hash is invalid");
    const previewApproval = sanitizeKbContent(body.preview_content.trim());
    indexContent = previewApproval.sanitized;
    const approvedBytes = new TextEncoder().encode(indexContent);
    if (approvedBytes.byteLength > contentLimit) throw badRequest("Approved extracted text exceeds this Knowledge scope's content limit");
    pdfLineage = { sourceSha256, extractionSha256, approvedContentSha256: await sha256BytesHex(approvedBytes) };
  }
  if (contentType !== "pdf" && originalBytes.byteLength > contentLimit) {
    throw badRequest(projectId ? "Project Knowledge content exceeds the 5 MiB limit" : "Space-wide Knowledge content exceeds the 1 MiB limit");
  }
  // Bare URL excerpts remain unsupported. A source is current only when this exact owner and
  // Project approve text returned by a scoped, signed website preview receipt.
  let sourceConnectionRef: string | null = null;
  let sourceGrantRevision: number | null = null;
  let sourceAdapter: "manual" | "website" = contentType === "url" ? "website" : "manual";
  let sourceState: "current" | "unsupported" = contentType === "url" ? "unsupported" : "current";
  if (creatingWebsiteSource) {
    if (!projectId || contentType !== "url" || typeof body.website_connection_id !== "string"
      || body.website_connection_id.length < 1 || body.website_connection_id.length > 256
      || typeof body.website_requested_url !== "string" || body.website_requested_url.length > WEB_TARGET_URL_MAX_CHARS
      || typeof body.website_preview_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.website_preview_sha256)
      || typeof body.website_preview_token !== "string" || typeof body.source_url !== "string") {
      throw badRequest("A Project website preview receipt is required for website Knowledge sources");
    }
    let requestedUrl: URL;
    let finalUrl: URL;
    try { requestedUrl = new URL(body.website_requested_url); finalUrl = new URL(body.source_url); }
    catch { throw badRequest("Website preview URLs are invalid"); }
    if (requestedUrl.protocol !== "https:" || finalUrl.protocol !== "https:" || requestedUrl.username || requestedUrl.password
      || finalUrl.username || finalUrl.password || requestedUrl.href !== body.website_requested_url || finalUrl.href !== body.source_url) {
      throw badRequest("Website preview URLs must be canonical HTTPS URLs without credentials");
    }
    const userId = c.req.header("x-naelao-user-id") ?? "";
    const connection = await c.env.PLATFORM_DB.prepare(`SELECT id,tenant_id,space_id,owner_user_id,project_id,origins_json,knowledge_path_prefixes_json,status
      FROM website_connections WHERE id=? AND tenant_id=? AND space_id=? AND owner_user_id=? AND project_id=? AND status='active'`)
      .bind(body.website_connection_id, tenantId, spaceId, userId, projectId).first<WebsiteConnectionGrant>();
    const origins = connection ? websiteConnectionOrigins(connection) : null;
    const pathPrefixes = connection ? websiteConnectionPathPrefixes(connection) : null;
    if (!connection || !origins || !pathPrefixes || !origins.includes(requestedUrl.origin) || !origins.includes(finalUrl.origin)
      || !websitePathAllowed(requestedUrl.pathname, pathPrefixes) || !websitePathAllowed(finalUrl.pathname, pathPrefixes)) {
      throw new HttpError(409, "website_connection_changed", "The approved website connection is no longer active for this Project and URL");
    }
    const previewValid = await verifyWebsitePreviewToken({ token: body.website_preview_token, secret: c.env.PLATFORM_SECRET,
      scope: { tenantId, spaceId, projectId, userId, connectionId: connection.id }, requestedUrl: requestedUrl.href,
      finalUrl: finalUrl.href, previewSha256: body.website_preview_sha256 });
    if (!previewValid) throw new HttpError(409, "website_preview_expired_or_changed", "Preview this website page again before saving");
    const connectionCount = await c.env.PLATFORM_DB.prepare(`SELECT COUNT(*) AS count FROM kb_documents
      WHERE tenant_id=? AND space_id=? AND source_connection_ref=?`).bind(tenantId, spaceId, connection.id).first<{ count: number }>();
    if ((connectionCount?.count ?? 0) >= 100) throw new HttpError(429, "website_connection_document_limit", "This website connection has reached its 100-page Knowledge limit");
    sourceConnectionRef = connection.id;
    sourceGrantRevision = 1; // The host connection scope is immutable; revocation changes its active state.
    sourceState = "current";
  }
  const sourceContentSha256 = await sha256BytesHex(originalBytes);

  const requestSha256 = await sha256Hex(JSON.stringify({
    version: 3, tenantId, spaceId, projectId, title: body.title.trim(), contentType, sourceAdapter, sourceState,
    sourceUrl: body.source_url ?? null, sourceRequestedUrl: creatingWebsiteSource ? body.website_requested_url : null,
    sourceFileName, sourceConnectionRef, sourceGrantRevision,
    sourceSha256: await sha256BytesHex(originalBytes),
    parserVersion: pdfLineage ? KNOWLEDGE_PDF_PARSER_VERSION : null,
    extractionSha256: pdfLineage?.extractionSha256 ?? null,
    approvedContentSha256: pdfLineage?.approvedContentSha256 ?? null,
    requiredRoleRank, allowedUserIds: [...allowedUserIds].sort(),
  }));
  const idempotencyKeyHash = await sha256Hex(body.idempotency_key);
  const idempotencyScope = { tenantId, spaceId, projectId, keySha256: idempotencyKeyHash };
  const returnExistingKnowledgeDocument = async (claim: IdempotentKnowledgeCreate): Promise<Response> => {
    const existing = claim.document;
    if (existing.status === "processing" && existing.project_id && originalBytes.byteLength > MAX_SYNC_CONTENT_BYTES) {
      const r2Key = `staging/${tenantId}/${spaceId}/${existing.project_id}/${existing.id}/original`;
      const mutationLease = await acquireKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, { documentId: existing.id, tenantId, spaceId });
      if (!mutationLease) return c.json(existing, 202);
      let queueSubmissionAttempted = false;
      try {
        if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, existing.id, mutationLease)) {
          throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
        }
        let staged = !!await c.env.KB_BUCKET.head(r2Key);
        if (!staged && claim.dispatchState === "claimed") {
          const stagedBytes = new TextEncoder().encode(indexContent);
          if (stagedBytes.byteLength > MAX_WORKFLOW_CONTENT_BYTES) throw badRequest("Parsed document exceeds the 5 MiB ingestion limit");
          if (existing.content_type === "pdf") {
            const sourceKey = `kb/${spaceId}/${existing.project_id}/${existing.id}/original`;
            await c.env.KB_BUCKET.put(sourceKey, originalBytes, { httpMetadata: { contentType: "application/pdf" } });
          }
          await c.env.KB_BUCKET.put(r2Key, stagedBytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
          staged = true;
        }
        // A missing stage after dispatch began means a Workflow may already have consumed it.
        // Do not recreate it or risk leaving a duplicate staged object after that Workflow ends.
        if (!staged) return c.json(existing, 202);
        const stagedBytes = new TextEncoder().encode(indexContent);
        await reportKnowledgeStorageWrite(c.env, tenantId, spaceId, existing.project_id, existing.id,
          stagedBytes.byteLength, true, `workflow-stage:${existing.id}`);
        if (existing.content_type === "pdf") await reportKnowledgeStorageWrite(c.env, tenantId, spaceId, existing.project_id, existing.id,
          originalBytes.byteLength, true, `workflow-pdf-source:${existing.id}`);
        const dispatching = await c.env.PLATFORM_DB.prepare(`UPDATE kb_document_idempotency_requests
          SET dispatch_state='dispatching' WHERE tenant_id=? AND space_id=? AND project_scope=? AND key_sha256=?
            AND document_id=? AND state='active' AND dispatch_state IN ('claimed','dispatching')
            AND EXISTS (SELECT 1 FROM kb_documents WHERE id=? AND status='processing'
              AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?))`)
          .bind(tenantId, spaceId, existing.project_id, idempotencyKeyHash, existing.id, existing.id, existing.id).run();
        if (!dispatching.meta.changes) throw new HttpError(410, "document_deletion_in_progress", "Document is no longer available for ingestion");
        queueSubmissionAttempted = true;
        await c.env.EVENTS_QUEUE.send({ type: "kb.ingest", docId: existing.id, spaceId, tenantId,
          projectId: existing.project_id, r2Key, title: existing.title, contentType: existing.content_type,
          requiredRoleRank, allowedUserIds });
      } catch (error) {
        if (error instanceof HttpError && error.status === 410)
          return c.json({ error_code: "document_deletion_in_progress", message: error.message }, 410);
        return c.json({
          error_code: queueSubmissionAttempted ? "ingestion_dispatch_uncertain" : "ingestion_stage_unavailable",
          message: queueSubmissionAttempted ? "The upload is staged; retry the same request to resume ingestion" : "The upload could not be staged; retry the same request to resume ingestion",
        }, 503);
      } finally {
        await releaseKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, existing.id, mutationLease);
      }
    }
    return c.json(existing, existing.status === "processing" ? 202 : 200);
  };
  const existing = await findKnowledgeCreateByIdempotency(c.env.PLATFORM_DB, idempotencyScope, requestSha256);
  if (existing) return returnExistingKnowledgeDocument(existing);
  if (contentType === "pdf" && !await verifyKnowledgePdfPreviewToken({
    token: body.preview_token ?? "", secret: c.env.PLATFORM_SECRET,
    scope: { tenantId, spaceId, projectId }, sourceSha256: pdfLineage!.sourceSha256,
    extractionSha256: pdfLineage!.extractionSha256,
  })) {
    throw new HttpError(409, "knowledge_pdf_preview_expired_or_source_changed",
      "This PDF preview expired or belongs to a different file or scope. Preview it again.");
  }

  // G-AA26: Scan document content for prompt injection before indexing
  const titleMod = moderateInput(body.title.trim());
  if (titleMod.blocked) {
    throw badRequest(`Document title contains disallowed content: ${titleMod.reason}`);
  }
  // Sample the content in 2000-char windows to catch injections in long docs
  const SAMPLE_WINDOW = 2000;
  for (let pos = 0; pos < indexContent.length; pos += SAMPLE_WINDOW) {
    const window = indexContent.slice(pos, pos + SAMPLE_WINDOW);
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

  if (originalBytes.byteLength > MAX_SYNC_CONTENT_BYTES) {
    if (!projectId) throw badRequest("Documents over 1 MiB currently require a project scope");
    const docId = crypto.randomUUID();
    const now = new Date().toISOString();
    const stagedText = indexContent;
    const stagedBytes = new TextEncoder().encode(stagedText);
    if (stagedBytes.byteLength > MAX_WORKFLOW_CONTENT_BYTES) throw badRequest("Parsed document exceeds the 5 MiB ingestion limit");
    const r2Key = `staging/${tenantId}/${spaceId}/${projectId}/${docId}/original`;
    const sourceKey = `kb/${spaceId}/${projectId}/${docId}/original`;
    const documentValues = [docId, spaceId, tenantId, projectId, body.title.trim(), body.source_url ?? null, contentType,
      requiredRoleRank, JSON.stringify(allowedUserIds), pdfLineage?.sourceSha256 ?? null, sourceFileName,
      pdfLineage ? KNOWLEDGE_PDF_PARSER_VERSION : null, pdfLineage?.extractionSha256 ?? null,
      pdfLineage?.approvedContentSha256 ?? null, now, now, sourceAdapter, sourceContentSha256, sourceState,
      sourceConnectionRef, sourceGrantRevision, creatingWebsiteSource ? now : null, creatingWebsiteSource ? now : null,
      creatingWebsiteSource ? body.website_requested_url ?? null : null];
    const created = await insertKnowledgeDocumentOnce(c.env.PLATFORM_DB, { values: documentValues,
      idempotency: { ...idempotencyScope, requestSha256, documentId: docId, createdAt: now } });
    if (!created.created && created.existing) return returnExistingKnowledgeDocument(created.existing);
    const mutationLease = await acquireKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, { documentId: docId, tenantId, spaceId });
    if (!mutationLease) {
      return c.json({ error_code: "document_deletion_in_progress" }, 410);
    }
    let queueSubmissionAttempted = false;
    try {
      if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease)) {
        throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
      }
      if (contentType === "pdf") {
        await c.env.KB_BUCKET.put(sourceKey, originalBytes, { httpMetadata: { contentType: "application/pdf" } });
      }
      await c.env.KB_BUCKET.put(r2Key, stagedBytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
      await reportKnowledgeStorageWrite(c.env, tenantId, spaceId, projectId, docId, stagedBytes.byteLength, true, `workflow-stage:${docId}`);
      if (contentType === "pdf") await reportKnowledgeStorageWrite(c.env, tenantId, spaceId, projectId, docId, originalBytes.byteLength, true, `workflow-pdf-source:${docId}`);
      const dispatching = await c.env.PLATFORM_DB.prepare(`UPDATE kb_document_idempotency_requests SET dispatch_state='dispatching'
        WHERE tenant_id=? AND space_id=? AND project_scope=? AND key_sha256=? AND document_id=? AND state='active'
          AND EXISTS (SELECT 1 FROM kb_documents WHERE id=? AND status='processing'
            AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?))`)
        .bind(tenantId, spaceId, projectId ?? "", idempotencyKeyHash, docId, docId, docId).run();
      if (!dispatching.meta.changes) throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
      queueSubmissionAttempted = true;
      await c.env.EVENTS_QUEUE.send({
        type: "kb.ingest", docId, spaceId, tenantId, projectId, r2Key,
        title: body.title.trim(), contentType, requiredRoleRank, allowedUserIds,
      });
      return c.json({ id: docId, space_id: spaceId, project_id: projectId, status: "processing", ingestion: "queued" }, 202);
    } catch (error) {
      // A send acknowledgement can be lost after acceptance, so preserve the deterministic job.
      // Before a send is attempted, the claimed key remains resumable and a retry can restage it.
      if (!queueSubmissionAttempted) {
        await Promise.allSettled([c.env.KB_BUCKET.delete(r2Key),
          ...(contentType === "pdf" ? [c.env.KB_BUCKET.delete(sourceKey)] : [])]);
        if (error instanceof HttpError && error.status === 410)
          return c.json({ error_code: "document_deletion_in_progress", message: error.message }, 410);
        return c.json({ error_code: "ingestion_stage_unavailable",
          message: "The upload could not be staged; retry the same request to resume ingestion" }, 503);
      }
      return c.json({ error_code: "ingestion_dispatch_uncertain",
        message: "The upload is staged; retry the same request to resume ingestion" }, 503);
    } finally {
      await releaseKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease);
    }
  }

  const docId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Insert doc record with status=processing
  const documentValues = [docId, spaceId, tenantId, projectId, body.title.trim(), body.source_url ?? null, contentType,
    requiredRoleRank, JSON.stringify(allowedUserIds), pdfLineage?.sourceSha256 ?? null, sourceFileName,
    pdfLineage ? KNOWLEDGE_PDF_PARSER_VERSION : null, pdfLineage?.extractionSha256 ?? null,
    pdfLineage?.approvedContentSha256 ?? null, now, now, sourceAdapter, sourceContentSha256, sourceState,
    sourceConnectionRef, sourceGrantRevision, creatingWebsiteSource ? now : null, creatingWebsiteSource ? now : null,
    creatingWebsiteSource ? body.website_requested_url ?? null : null];
  const created = await insertKnowledgeDocumentOnce(c.env.PLATFORM_DB, { values: documentValues,
    idempotency: { ...idempotencyScope, requestSha256, documentId: docId, createdAt: now } });
  if (!created.created && created.existing) return returnExistingKnowledgeDocument(created.existing);
  const mutationLease = await acquireKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, { documentId: docId, tenantId, spaceId });
  if (!mutationLease) {
    await c.env.PLATFORM_DB.prepare(`UPDATE kb_documents SET status='failed',updated_at=datetime('now')
      WHERE id=? AND status='processing' AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`)
      .bind(docId, docId).run().catch(() => undefined);
    return c.json({ error_code: "document_deletion_in_progress" }, 410);
  }

  let storageBytesWritten = 0;
  try {
    // ── G-BD01: Sanitize content — strip HTML, detect injection patterns ────
    const originalKey = `kb/${spaceId}/${projectId ?? "_space"}/${docId}/original`;
    await c.env.KB_BUCKET.put(originalKey, originalBytes, { httpMetadata: { contentType: contentType === "pdf" ? "application/pdf" : "text/plain; charset=utf-8" } });
    storageBytesWritten += originalBytes.byteLength;
    const parsedContent = indexContent;
    const { sanitized: sanitizedContent, injectionDetected } = sanitizeKbContent(parsedContent);
    if (injectionDetected) {
      // Flag in DB but do NOT reject — builders may legitimately document attacks
      await c.env.PLATFORM_DB.prepare(
        `UPDATE kb_documents SET status = 'flagged', updated_at = ? WHERE id = ? AND status!='deleting'
          AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`
      ).bind(new Date().toISOString(), docId, docId).run();
      console.warn(`[kb] Injection pattern detected in doc ${docId} for space ${spaceId}`);
    }

    // ── Chunking ────────────────────────────────────────────────────────────
    const structuralChunks = contentType === "pdf" ? chunkStructuredMarkdown(sanitizedContent) : [];
    const chunks = structuralChunks.length ? structuralChunks.map((chunk) => chunk.content) : chunkText(sanitizedContent);

    if (chunks.length === 0) {
      // Content too short to chunk — treat as one chunk
      chunks.push(sanitizedContent.trim());
    }
    const coordinates = chunkCoordinates(sanitizedContent, chunks, structuralChunks.length ? structuralChunks : undefined);

    // ── Embedding (batch, 50 chunks per CF AI call) ─────────────────────────
    const EMBED_BATCH_SIZE = 50;
    const allEmbedResults: Array<{ embedding: number[]; tokenCount: number }> = [];

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batchChunks = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const batchResults = await embedBatch(c.env.AI, batchChunks);
      allEmbedResults.push(...batchResults);
    }

    // Persist the expected vector range before writes begin. If Vectorize partially accepts a
    // batch and then fails, the failed-document sweeper can remove every possible chunk ID.
    const rangeUpdate = await c.env.PLATFORM_DB.prepare(
      `UPDATE kb_documents SET chunk_count = ? WHERE id = ? AND status IN ('processing', 'flagged')
        AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`
    ).bind(chunks.length, docId, docId).run();
    if (!rangeUpdate.meta.changes) throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");

    // ── R2 storage + Vectorize upsert ───────────────────────────────────────
    const vectorUpserts: VectorizeVector[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease)) {
        throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
      }
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
      if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease)) {
        throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
      }
      const batch = vectorUpserts.slice(i, i + VECTOR_BATCH_SIZE);
      await c.env.KB_VECTORS.upsert(batch);
    }

    // §A1.19: best-effort whole-document mirror for AutoRAG (only written when an instance is
    // configured — cheap, and a failed mirror write never fails ingestion since the legacy
    // pipeline above already succeeded and is the default retrieval path regardless).
    if (c.env.AUTORAG_KB_INSTANCE) {
      if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease)) {
        throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
      }
      try {
        await c.env.KB_BUCKET.put(autoragKbKey(spaceId, projectId, docId), sanitizedContent);
        storageBytesWritten += new TextEncoder().encode(sanitizedContent).byteLength;
      } catch {
        /* best-effort — legacy retrieval is unaffected */
      }
    }

    // ── Update DB: status=indexed ────────────────────────────────────────────
    const publish = await c.env.PLATFORM_DB.prepare(
      `UPDATE kb_documents
       SET status = 'indexed', chunk_count = ?, required_role_rank=?, allowed_user_ids_json=COALESCE(allowed_user_ids_json, ?), updated_at = datetime('now')
       WHERE id = ? AND status IN ('processing', 'flagged')
         AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`
    )
      .bind(chunks.length, requiredRoleRank, JSON.stringify(allowedUserIds), docId, docId)
      .run();
    if (!publish.meta.changes) throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");

    const doc = publicKnowledgeDocument(await c.env.PLATFORM_DB.prepare(
      `SELECT id, space_id, tenant_id, project_id, title, source_url, content_type, status,
              chunk_count, source_adapter, source_revision, source_state, source_content_sha256,
              source_connection_ref, source_grant_revision, created_at, updated_at FROM kb_documents WHERE id = ?`
    )
      .bind(docId)
      .first<Record<string, unknown>>());

    await reportKnowledgeStorageWrite(c.env, tenantId, spaceId, projectId, docId, storageBytesWritten, true);
    return c.json(doc, 201);
  } catch (err) {
    // Mark document as failed on any error during processing
    await c.env.PLATFORM_DB.prepare(
      `UPDATE kb_documents SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status!='deleting'
        AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`
    )
      .bind(docId, docId)
      .run()
      .catch(() => {/* best-effort */});
    await reportKnowledgeStorageWrite(c.env, tenantId, spaceId, projectId, docId, storageBytesWritten, false);

    preserveHttpStatus(err);
  } finally {
    await releaseKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease);
  }
});

// ── PATCH /spaces/:spaceId/kb/documents/:docId ───────────────────────────────
// G-X09: Document update must delete old stale vectors before upserting new ones

app.patch("/spaces/:spaceId/kb/documents/:docId", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const docId = c.req.param("docId");

  const body = await readBoundedJson<{
    title?: string;
    content?: string;
    website_refresh?: {
      operation_id?: string;
      expected_source_revision?: number;
      requested_url?: string;
      final_url?: string;
      preview_sha256?: string;
      preview_token?: string;
    };
  }>(c.req.raw, 6_500_000);

  if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim() || body.title.length > 500)) {
    throw badRequest("title must contain 1 to 500 characters");
  }
  if (body.content !== undefined && (typeof body.content !== "string" || !body.content || body.content.length > 1_048_576)) {
    throw badRequest("content must contain 1 to 1048576 characters");
  }
  if (body.title === undefined && body.content === undefined) {
    throw badRequest("At least one of title or content is required");
  }

  // A title-only edit stays in D1. Content changes invoke Workers AI and Vectorize and therefore
  // must be rejected before document state or existing vectors are mutated.
  if (body.content !== undefined && await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);

  // Verify ownership and get current state
  const existing = await c.env.PLATFORM_DB.prepare(
    `SELECT id, title, chunk_count, project_id, required_role_rank, allowed_user_ids_json,
       source_adapter,source_state,source_revision,source_connection_ref,source_url,source_requested_url,source_content_sha256,
       (SELECT required_role_rank FROM kb_chunks WHERE document_id=kb_documents.id AND chunk_index=0 LIMIT 1) AS legacy_required_role_rank
     FROM kb_documents WHERE id = ? AND space_id = ? AND tenant_id = ?`
  ).bind(docId, spaceId, tenantId).first<{ id: string; title: string; chunk_count: number; project_id: string | null;
    required_role_rank: number; allowed_user_ids_json: string | null; legacy_required_role_rank: number | null;
    source_adapter: string; source_state: string; source_revision: number; source_connection_ref: string | null; source_url: string | null;
    source_requested_url: string | null;
    source_content_sha256: string | null }>();

  if (!existing) throw notFound("KbDocument");
  const projectId = existing.project_id;
  if (projectId) {
    const access = await requireProjectAccess(c, projectId);
    if (access instanceof Response) return access;
  }

  let websiteRefresh: { operationId: string; expectedRevision: number; finalUrl: string; previewSha256: string; attemptCount: number } | null = null;
  if (existing.source_adapter === "website" && existing.source_state === "current" && body.content !== undefined) {
    if (!projectId || !body.website_refresh || typeof body.website_refresh.expected_source_revision !== "number"
      || !Number.isSafeInteger(body.website_refresh.expected_source_revision)
      || typeof body.website_refresh.operation_id !== "string" || typeof body.website_refresh.requested_url !== "string"
      || typeof body.website_refresh.final_url !== "string" || typeof body.website_refresh.preview_sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(body.website_refresh.preview_sha256) || typeof body.website_refresh.preview_token !== "string") {
      throw new HttpError(409, "website_refresh_approval_required", "Preview and approve the current website page before replacing this snapshot");
    }
    const ownerAccess = await requireProjectAccess(c, projectId, 40);
    if (ownerAccess instanceof Response) return ownerAccess;
    let requestedUrl: URL;
    let finalUrl: URL;
    try { requestedUrl = new URL(body.website_refresh.requested_url); finalUrl = new URL(body.website_refresh.final_url); }
    catch { throw badRequest("Website refresh URLs are invalid"); }
    if (!existing.source_url || requestedUrl.href !== (existing.source_requested_url ?? existing.source_url)
      || requestedUrl.href !== body.website_refresh.requested_url
      || finalUrl.href !== body.website_refresh.final_url || requestedUrl.protocol !== "https:" || finalUrl.protocol !== "https:"
      || requestedUrl.username || requestedUrl.password || requestedUrl.search || requestedUrl.hash
      || finalUrl.username || finalUrl.password || finalUrl.search || finalUrl.hash) {
      throw new HttpError(409, "website_refresh_source_changed", "The website source URL changed; preview it again");
    }
    const userId = c.req.header("x-naelao-user-id") ?? "";
    const connection = existing.source_connection_ref ? await c.env.PLATFORM_DB.prepare(`SELECT id,tenant_id,space_id,owner_user_id,project_id,origins_json,knowledge_path_prefixes_json,status
      FROM website_connections WHERE id=? AND tenant_id=? AND space_id=? AND owner_user_id=? AND project_id=? AND status='active'`)
      .bind(existing.source_connection_ref, tenantId, spaceId, userId, projectId).first<WebsiteConnectionGrant>() : null;
    const origins = connection ? websiteConnectionOrigins(connection) : null;
    const pathPrefixes = connection ? websiteConnectionPathPrefixes(connection) : null;
    if (!connection || !origins || !pathPrefixes || !origins.includes(requestedUrl.origin) || !origins.includes(finalUrl.origin)
      || !websitePathAllowed(requestedUrl.pathname, pathPrefixes) || !websitePathAllowed(finalUrl.pathname, pathPrefixes)) {
      throw new HttpError(409, "website_connection_changed", "The approved website connection is no longer active for this Project and URL");
    }
    const operation = await c.env.PLATFORM_DB.prepare(`SELECT id,state,source_revision,connection_ref,requested_url,final_url,preview_sha256,attempt_count
      FROM kb_source_refresh_operations WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND document_id=?`)
      .bind(body.website_refresh.operation_id, tenantId, spaceId, projectId, docId)
      .first<{ id: string; state: string; source_revision: number; connection_ref: string; requested_url: string; final_url: string | null; preview_sha256: string | null; attempt_count: number }>();
    if (operation?.state === "completed" && body.website_refresh.expected_source_revision + 1 === existing.source_revision
      && operation.source_revision === body.website_refresh.expected_source_revision && operation.final_url === finalUrl.href
      && operation.preview_sha256 === body.website_refresh.preview_sha256
      && existing.source_url === finalUrl.href && existing.source_content_sha256 === await sha256Hex(body.content)) {
      const replay = publicKnowledgeDocument(await c.env.PLATFORM_DB.prepare(
        `SELECT id,space_id,tenant_id,project_id,title,source_url,content_type,status,chunk_count,source_adapter,source_revision,
          source_state,source_content_sha256,created_at,updated_at FROM kb_documents WHERE id=? AND tenant_id=? AND space_id=?`
      ).bind(docId, tenantId, spaceId).first<Record<string, unknown>>());
      return c.json(replay, 200);
    }
    if (body.website_refresh.expected_source_revision !== existing.source_revision) {
      throw new HttpError(409, "website_source_revision_changed", "This source changed while the refresh was being reviewed");
    }
    if (!operation || operation.state !== "preview_ready" || operation.source_revision !== existing.source_revision
      || operation.connection_ref !== connection.id || operation.requested_url !== requestedUrl.href
      || operation.final_url !== finalUrl.href || operation.preview_sha256 !== body.website_refresh.preview_sha256) {
      throw new HttpError(409, "website_refresh_receipt_expired", "The website refresh preview expired or was superseded");
    }
    const previewValid = await verifyWebsitePreviewToken({ token: body.website_refresh.preview_token, secret: c.env.PLATFORM_SECRET,
      scope: { tenantId, spaceId, projectId, userId, connectionId: connection.id }, requestedUrl: requestedUrl.href,
      finalUrl: finalUrl.href, previewSha256: body.website_refresh.preview_sha256, operation: "refresh", documentId: docId,
      sourceRevision: existing.source_revision, refreshOperationId: operation.id });
    if (!previewValid) throw new HttpError(409, "website_refresh_receipt_expired", "Preview this website page again before saving");
    websiteRefresh = { operationId: operation.id, expectedRevision: existing.source_revision,
      finalUrl: finalUrl.href, previewSha256: body.website_refresh.preview_sha256, attemptCount: operation.attempt_count };
  } else if (body.website_refresh !== undefined) {
    throw badRequest("website_refresh is valid only when updating a current website source");
  }

  // If only updating title (no content re-index needed)
  if (body.title !== undefined && body.content === undefined) {
    const newTitle = body.title.trim();
    const titleMod = moderateInput(newTitle);
    if (titleMod.blocked) throw badRequest(`Title contains disallowed content: ${titleMod.reason}`);

    await c.env.PLATFORM_DB.prepare(
      `UPDATE kb_documents SET title = ?, updated_at = datetime('now') WHERE id = ? AND status!='deleting'
        AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`
    ).bind(newTitle, docId, docId).run().then((result) => {
      if (!result.meta.changes) throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
    });

    const updated = publicKnowledgeDocument(await c.env.PLATFORM_DB.prepare(
      `SELECT id, space_id, tenant_id, project_id, title, source_url, content_type, status,
              chunk_count, source_adapter, source_revision, source_state, source_content_sha256,
              source_connection_ref, source_grant_revision, created_at, updated_at FROM kb_documents WHERE id = ?`
    ).bind(docId).first<Record<string, unknown>>());
    return c.json(updated, 200);
  }

  const newContent = body.content!;
  const newTitle = body.title?.trim() ?? existing.title;
  const newSourceContentSha256 = await sha256Hex(newContent);

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

  // ACL metadata must survive a content rewrite. The chunk table stores the role rank and
  // Vectorize stores the explicit sovereign-user allowlist. Read both before deleting anything;
  // if the prior vector is unavailable, fail closed instead of silently making private content public.
  let requiredRoleRank = Number.isSafeInteger(existing.required_role_rank) ? Number(existing.required_role_rank) : 0;
  let allowedUserIds: string[] = [];
  if (existing.allowed_user_ids_json !== null) {
    try {
      const storedAcl: unknown = JSON.parse(existing.allowed_user_ids_json);
      if (!Array.isArray(storedAcl) || storedAcl.length > 100 || storedAcl.some((id) => typeof id !== "string" || !id || id.length > 256)) {
        throw new Error("invalid_stored_acl");
      }
      allowedUserIds = [...new Set(storedAcl as string[])];
    } catch {
      throw internalError("Existing knowledge access metadata is invalid");
    }
  }
  const legacyRequiredRoleRank = existing.legacy_required_role_rank;
  if (Number.isSafeInteger(legacyRequiredRoleRank) && Number(legacyRequiredRoleRank) >= 0 && Number(legacyRequiredRoleRank) <= 50) {
    requiredRoleRank = Math.max(requiredRoleRank, Number(legacyRequiredRoleRank));
  }
  if ((existing.chunk_count ?? 0) > 0) {
    if (existing.allowed_user_ids_json === null) {
      const oldVectors = await c.env.KB_VECTORS.getByIds([`${docId}_chunk_0`]);
      const oldVector = oldVectors.find((vector) => vector.id === `${docId}_chunk_0`);
      if (!oldVector) throw new HttpError(503, "upstream_error", "Existing knowledge access metadata is unavailable");
      const rawAllowedUserIds = oldVector.metadata?.allowed_user_ids;
      if (rawAllowedUserIds !== undefined && (!Array.isArray(rawAllowedUserIds) || rawAllowedUserIds.some((id) => typeof id !== "string" || !id || id.length > 256))) {
        throw internalError("Existing knowledge access metadata is invalid");
      }
      const vectorRoleRank = oldVector.metadata?.required_role_rank;
      if (vectorRoleRank !== undefined && (!Number.isSafeInteger(vectorRoleRank) || Number(vectorRoleRank) < 0 || Number(vectorRoleRank) > 50)) {
        throw internalError("Existing knowledge role metadata is invalid");
      }
      if (typeof vectorRoleRank === "number") requiredRoleRank = Math.max(requiredRoleRank, vectorRoleRank);
      allowedUserIds = Array.isArray(rawAllowedUserIds) ? [...new Set(rawAllowedUserIds as string[])] : [];
      await c.env.PLATFORM_DB.prepare(`UPDATE kb_documents SET required_role_rank=?,allowed_user_ids_json=?
        WHERE id=? AND tenant_id=? AND space_id=? AND allowed_user_ids_json IS NULL
          AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`)
        .bind(requiredRoleRank, JSON.stringify(allowedUserIds), docId, tenantId, spaceId, docId).run();
    }
  }
  const allowedRoles = allowedUserIds.length > 0
    ? []
    : Object.entries(ROLE_RANK)
      .filter(([role, rank]) => role in KNOWLEDGE_ROLE_MASK && rank >= requiredRoleRank)
      .map(([role]) => role);
  const accessMask = allowedRoles.reduce((mask, role) => mask | KNOWLEDGE_ROLE_MASK[role as KnowledgeRole], 0);

  const storageOperationId = websiteRefresh?.operationId ?? crypto.randomUUID();
  let storageBytesWritten = 0;
  let reindexStarted = false;
  let mutationLease: string | null = null;
  try {
    // Finish every fallible embedding request before replacing the current index. A provider
    // timeout or malformed embedding must leave the previously indexed document usable.
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

    mutationLease = await acquireKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, { documentId: docId, tenantId, spaceId });
    if (!mutationLease) throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
    const startReindex = await c.env.PLATFORM_DB.prepare(
      `UPDATE kb_documents SET status = 'processing', updated_at = datetime('now') WHERE id = ? AND status!='deleting'
        AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`
    ).bind(docId, docId).run();
    if (!startReindex.meta.changes) throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
    reindexStarted = true;

    // G-X09: Delete ALL old vectors before re-indexing to prevent stale accumulation
    const oldChunkCount = existing.chunk_count ?? 0;
    if (oldChunkCount > 0) {
      const oldVectorIds: string[] = [];
      for (let i = 0; i < oldChunkCount; i++) oldVectorIds.push(`${docId}_chunk_${i}`);
      const VECTOR_DELETE_BATCH = 100;
      for (let i = 0; i < oldVectorIds.length; i += VECTOR_DELETE_BATCH) {
        if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease)) {
          throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
        }
        await c.env.KB_VECTORS.deleteByIds(oldVectorIds.slice(i, i + VECTOR_DELETE_BATCH));
      }
    }
    await c.env.PLATFORM_DB.prepare(
      "DELETE FROM kb_chunks WHERE document_id=? AND tenant_id=? AND space_id=? AND project_id=?"
    ).bind(docId, tenantId, spaceId, projectId ?? SPACE_WIDE_PROJECT_SENTINEL).run();

    const setChunkCount = await c.env.PLATFORM_DB.prepare(
      `UPDATE kb_documents SET chunk_count = ? WHERE id = ? AND status = 'processing'
        AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`
    ).bind(chunks.length, docId, docId).run();
    if (!setChunkCount.meta.changes) throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");

    // Delete old R2 chunks
    const prefix = docR2Prefix(spaceId, projectId, docId);
    let cursor: string | undefined;
    do {
      if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease)) {
        throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
      }
      const listOpts: R2ListOptions = cursor !== undefined ? { prefix, cursor } : { prefix };
      const listed: R2Objects = await c.env.KB_BUCKET.list(listOpts);
      if (listed.objects.length > 0) {
        await Promise.all(listed.objects.map(o => c.env.KB_BUCKET.delete(o.key)));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    const vectorUpserts: VectorizeVector[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease)) {
        throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
      }
      const chunk = chunks[i];
      const embedResult = allEmbedResults[i];
      const coordinate = coordinates[i];
      if (chunk === undefined || embedResult === undefined || coordinate === undefined) continue;
      const chunkId = `${docId}_chunk_${i}`;
      const contentHash = await sha256Hex(chunk);

      const serializedChunk = JSON.stringify({ docId, chunkIndex: i, content: chunk, spaceId, tenantId,
          projectId: projectId ?? SPACE_WIDE_PROJECT_SENTINEL, visibility: projectId ? "project" : "space",
          requiredRoleRank, chunkId, contentHash, sourceFreshness: indexedAt, headingPath: [], ...coordinate } satisfies ChunkRecord);
      await c.env.KB_BUCKET.put(chunkR2Key(spaceId, projectId, docId, i), serializedChunk);
      storageBytesWritten += new TextEncoder().encode(serializedChunk).byteLength;
      await c.env.KB_BUCKET.put(citationR2Key(spaceId, projectId, docId, i), chunk, {
        customMetadata: { contentHash, tenantId, spaceId, projectId: projectId ?? SPACE_WIDE_PROJECT_SENTINEL },
      });
      storageBytesWritten += new TextEncoder().encode(chunk).byteLength;
      await c.env.PLATFORM_DB.prepare(
        `INSERT INTO kb_chunks (id,tenant_id,space_id,project_id,document_id,chunk_index,content,
         content_hash,visibility,required_role_rank,source_freshness,heading_path,r2_key,byte_start,
         byte_end,line_start,line_end,created_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'[]',?,?,?,?,?,?,NULL)`
      ).bind(chunkId, tenantId, spaceId, projectId ?? SPACE_WIDE_PROJECT_SENTINEL, docId, i, chunk,
        contentHash, projectId ? "project" : "space", requiredRoleRank, indexedAt, citationR2Key(spaceId, projectId, docId, i),
        0, new TextEncoder().encode(chunk).byteLength, coordinate.lineStart, coordinate.lineEnd, indexedAt).run();

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
          access_mask: accessMask,
          allowedRolesMask: accessMask,
          required_role_rank: requiredRoleRank,
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
      if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease)) {
        throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
      }
      await c.env.KB_VECTORS.upsert(vectorUpserts.slice(i, i + VECTOR_BATCH_SIZE));
    }

    // §A1.19: keep the AutoRAG mirror in sync with the re-indexed content (best-effort, same
    // posture as the POST route's mirror write).
    if (c.env.AUTORAG_KB_INSTANCE) {
      if (!await renewKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease)) {
        throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
      }
      try {
        await c.env.KB_BUCKET.put(autoragKbKey(spaceId, projectId, docId), newContent);
        storageBytesWritten += new TextEncoder().encode(newContent).byteLength;
      } catch {
        /* best-effort — legacy retrieval is unaffected */
      }
    }

    const refreshFlag = websiteRefresh ? 1 : 0;
    const publishReindex = await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(
        `UPDATE kb_documents SET status = 'indexed', title = ?, chunk_count = ?, required_role_rank=?,
          allowed_user_ids_json=COALESCE(allowed_user_ids_json, ?), source_revision=source_revision+1,
          source_content_sha256=?, source_url=COALESCE(?,source_url),
          source_state=CASE WHEN ?=1 THEN 'current' ELSE source_state END,
          source_last_success_at=CASE WHEN ?=1 THEN datetime('now') ELSE source_last_success_at END,
          source_refresh_failures=CASE WHEN ?=1 THEN 0 ELSE source_refresh_failures END,
          source_last_error_code=CASE WHEN ?=1 THEN NULL ELSE source_last_error_code END,
          source_next_attempt_at=CASE WHEN ?=1 THEN NULL ELSE source_next_attempt_at END,updated_at = datetime('now')
        WHERE id = ? AND status='processing' AND (? IS NULL OR source_revision=?)
          AND (? IS NULL OR EXISTS (SELECT 1 FROM website_connections wc WHERE wc.id=source_connection_ref
            AND wc.tenant_id=kb_documents.tenant_id AND wc.space_id=kb_documents.space_id
            AND wc.project_id=kb_documents.project_id AND wc.status='active'))
          AND (? IS NULL OR EXISTS (SELECT 1 FROM kb_source_refresh_operations ro WHERE ro.id=?
            AND ro.document_id=kb_documents.id AND ro.state='preview_ready' AND ro.source_revision=? AND ro.preview_sha256=?))
          AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`
      ).bind(newTitle, chunks.length, requiredRoleRank, JSON.stringify(allowedUserIds), newSourceContentSha256,
        websiteRefresh?.finalUrl ?? null, refreshFlag, refreshFlag, refreshFlag, refreshFlag, refreshFlag, refreshFlag,
        docId, websiteRefresh?.expectedRevision ?? null, websiteRefresh?.expectedRevision ?? null,
        websiteRefresh?.operationId ?? null, websiteRefresh?.operationId ?? null, websiteRefresh?.expectedRevision ?? null,
        websiteRefresh?.previewSha256 ?? null, docId),
      ...(websiteRefresh ? [c.env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_operations SET state='completed',
        completed_at=datetime('now'),next_attempt_at=NULL,error_code=NULL,updated_at=datetime('now')
        WHERE id=? AND state='preview_ready' AND source_revision=? AND preview_sha256=? AND EXISTS (
          SELECT 1 FROM kb_documents d WHERE d.id=kb_source_refresh_operations.document_id AND d.source_revision=?+1
            AND d.source_url=kb_source_refresh_operations.final_url AND d.source_content_sha256=? AND d.source_state='current'
        )`).bind(websiteRefresh.operationId, websiteRefresh.expectedRevision, websiteRefresh.previewSha256,
        websiteRefresh.expectedRevision, newSourceContentSha256)] : []),
      ...revisionExternalPublicationsForDocument(c.env.PLATFORM_DB,
        { tenantId, spaceId, projectId, documentId: docId, updatedAt: new Date().toISOString() }),
    ]);
    if (!publishReindex[0]?.meta.changes) {
      if (websiteRefresh) throw new HttpError(409, "website_refresh_superseded", "The source or its approved connection changed during refresh");
      throw new HttpError(410, "document_deletion_in_progress", "Document deletion has started");
    }
    if (websiteRefresh && !publishReindex[1]?.meta.changes) {
      throw new HttpError(409, "website_refresh_receipt_expired", "The refresh receipt could not be completed; reload the source status");
    }

    const updated = publicKnowledgeDocument(await c.env.PLATFORM_DB.prepare(
      `SELECT id, space_id, tenant_id, project_id, title, source_url, content_type, status,
              chunk_count, source_adapter, source_revision, source_state, source_content_sha256,
              source_connection_ref, source_grant_revision, created_at, updated_at FROM kb_documents WHERE id = ?`
    ).bind(docId).first<Record<string, unknown>>());
    await reportKnowledgeStorageWrite(c.env, tenantId, spaceId, projectId, docId, storageBytesWritten, true, storageOperationId);
    return c.json(updated, 200);
  } catch (err) {
    if (reindexStarted) {
      await c.env.PLATFORM_DB.prepare(
        `UPDATE kb_documents SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status!='deleting'
          AND NOT EXISTS (SELECT 1 FROM kb_document_deletion_operations WHERE document_id=?)`
      ).bind(docId, docId).run().catch(() => {});
    }
    if (websiteRefresh) {
      const now = new Date();
      const retryAt = new Date(now.getTime() + Math.min(360, 2 ** Math.min(websiteRefresh.attemptCount - 1, 8)) * 60_000).toISOString();
      await c.env.PLATFORM_DB.batch([
        c.env.PLATFORM_DB.prepare(`UPDATE kb_source_refresh_operations SET state='failed',error_code='website_reindex_failed',
          next_attempt_at=?,updated_at=? WHERE id=? AND state='preview_ready'`)
          .bind(retryAt, now.toISOString(), websiteRefresh.operationId),
        c.env.PLATFORM_DB.prepare(`UPDATE kb_documents SET source_refresh_failures=source_refresh_failures+1,
          source_last_error_code='website_reindex_failed',source_next_attempt_at=? WHERE id=? AND tenant_id=? AND space_id=?
            AND source_revision=? AND source_state='current'`)
          .bind(retryAt, docId, tenantId, spaceId, websiteRefresh.expectedRevision),
      ]).catch(() => undefined);
    }
    await reportKnowledgeStorageWrite(c.env, tenantId, spaceId, projectId, docId, storageBytesWritten, false, storageOperationId);
    if (err instanceof HttpError && (err.status === 409 || err.status === 410)) preserveHttpStatus(err);
    throw internalError(`Document update failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (mutationLease) await releaseKnowledgeDocumentMutationLease(c.env.PLATFORM_DB, docId, mutationLease);
  }
});

// ── DELETE /spaces/:spaceId/kb/documents/:docId ───────────────────────────────

app.delete("/spaces/:spaceId/kb/documents/:docId", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const docId = c.req.param("docId");

  const doc = await c.env.PLATFORM_DB.prepare(
    "SELECT id, chunk_count, project_id FROM kb_documents WHERE id = ? AND space_id = ? AND tenant_id = ?"
  )
    .bind(docId, spaceId, tenantId)
    .first<{ id: string; chunk_count: number; project_id: string | null }>();

  let deletion: KnowledgeDocumentDeletion | null = null;
  if (doc) {
    if (doc.project_id) {
      const access = await requireProjectAccess(c, doc.project_id);
      if (access instanceof Response) return access;
    }
    const now = new Date().toISOString();
    // One D1 batch makes the read barrier, content redaction, publication unlink, and retry
    // intent durable together before any Vectorize, R2, or cache operation begins.
    const publicationRevisionUpdates = revisionExternalPublicationsForDocument(c.env.PLATFORM_DB,
      { tenantId, spaceId, projectId: doc.project_id, documentId: docId, updatedAt: now });
    await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO kb_document_deletion_operations
        (document_id,tenant_id,space_id,project_id,chunk_count,state,next_attempt_at,created_at,updated_at)
        VALUES(?,?,?,?,?,'pending',?,?,?)`)
        .bind(docId, tenantId, spaceId, doc.project_id, doc.chunk_count ?? 0, now, now, now),
      c.env.PLATFORM_DB.prepare(`UPDATE kb_documents SET status='deleting',title='Deleted document',source_url=NULL,
        source_revision=source_revision+1,source_state='revoked',source_content_sha256=NULL,
        source_connection_ref=NULL,source_grant_revision=NULL,updated_at=?
        WHERE id=? AND tenant_id=? AND space_id=?`)
        .bind(now, docId, tenantId, spaceId),
      c.env.PLATFORM_DB.prepare(`DELETE FROM kb_chunks WHERE document_id=? AND tenant_id=? AND space_id=? AND project_id=?`)
        .bind(docId, tenantId, spaceId, doc.project_id ?? SPACE_WIDE_PROJECT_SENTINEL),
      ...publicationRevisionUpdates,
      c.env.PLATFORM_DB.prepare(`DELETE FROM kb_external_publication_documents
        WHERE document_id=? AND tenant_id=? AND space_id=?`)
        .bind(docId, tenantId, spaceId),
    ]);
  } else {
    deletion = await c.env.PLATFORM_DB.prepare(`SELECT * FROM kb_document_deletion_operations
      WHERE document_id=? AND tenant_id=? AND space_id=?`)
      .bind(docId, tenantId, spaceId).first<KnowledgeDocumentDeletion>();
    if (!deletion) throw notFound("KbDocument");
  }

  deletion ??= await c.env.PLATFORM_DB.prepare(`SELECT * FROM kb_document_deletion_operations
    WHERE document_id=? AND tenant_id=? AND space_id=?`)
    .bind(docId, tenantId, spaceId).first<KnowledgeDocumentDeletion>();
  if (!deletion) throw new HttpError(503, "upstream_error", "Document deletion receipt is unavailable");
  if (deletion.project_id) {
    const access = await requireProjectAccess(c, deletion.project_id);
    if (access instanceof Response) return access;
  }
  const outcome = await processKnowledgeDocumentDeletion(deletionBindings(c.env), docId);
  if (outcome.state === "complete") return new Response(null, { status: 204 });
  return c.json({ deletion: { document_id: docId, state: "pending", attempts: outcome.attempts ?? deletion.attempts,
    retry_after_seconds: 300, provider_mirror_status: deletion.provider_mirror_status } }, 202, { "retry-after": "300" });
});

// Website connection revocation is the host grant boundary. Revoke every attached page through
// the same durable deletion ledger used by explicit document deletion; the connection status
// itself is checked at every retrieval and citation boundary before this cleanup runs.
app.post("/internal/spaces/:spaceId/kb/sources/website/revoke", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const body = await readBoundedJson<{ connection_id?: unknown }>(c.req.raw, 8 * 1024);
  if (typeof body.connection_id !== "string" || !body.connection_id || body.connection_id.length > 256) {
    throw badRequest("connection_id is required");
  }
  const connection = await c.env.PLATFORM_DB.prepare(`SELECT id,tenant_id,space_id,owner_user_id,project_id,origins_json,status
    FROM website_connections WHERE id=? AND tenant_id=? AND space_id=? AND status='revoked'`)
    .bind(body.connection_id, tenantId, spaceId).first<WebsiteConnectionGrant>();
  if (!connection) return c.json({ error_code: "revoked_website_connection_not_found" }, 404);
  const { results: documents } = await c.env.PLATFORM_DB.prepare(`SELECT id,project_id,chunk_count FROM kb_documents
    WHERE tenant_id=? AND space_id=? AND source_connection_ref=? AND status!='deleting' AND status!='purged'
    ORDER BY id LIMIT 100`)
    .bind(tenantId, spaceId, connection.id).all<{ id: string; project_id: string | null; chunk_count: number }>();
  const now = new Date().toISOString();
  for (let offset = 0; offset < documents.length; offset += 10) {
    const batchDocs = documents.slice(offset, offset + 10);
    const statements = batchDocs.flatMap((doc) => [
      c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO kb_document_deletion_operations
        (document_id,tenant_id,space_id,project_id,chunk_count,state,next_attempt_at,created_at,updated_at)
        VALUES(?,?,?,?,?,'pending',?,?,?)`).bind(doc.id, tenantId, spaceId, doc.project_id, doc.chunk_count ?? 0, now, now, now),
      c.env.PLATFORM_DB.prepare(`UPDATE kb_documents SET status='deleting',title='Revoked website source',source_url=NULL,
        source_revision=source_revision+1,source_state='revoked',source_content_sha256=NULL,
        source_connection_ref=NULL,source_grant_revision=NULL,updated_at=?
        WHERE id=? AND tenant_id=? AND space_id=? AND source_connection_ref=? AND status!='deleting'`)
        .bind(now, doc.id, tenantId, spaceId, connection.id),
      c.env.PLATFORM_DB.prepare(`DELETE FROM kb_chunks WHERE document_id=? AND tenant_id=? AND space_id=? AND project_id=?`)
        .bind(doc.id, tenantId, spaceId, doc.project_id ?? SPACE_WIDE_PROJECT_SENTINEL),
      ...revisionExternalPublicationsForDocument(c.env.PLATFORM_DB,
        { tenantId, spaceId, projectId: doc.project_id, documentId: doc.id, updatedAt: now }),
      c.env.PLATFORM_DB.prepare(`DELETE FROM kb_external_publication_documents WHERE document_id=? AND tenant_id=? AND space_id=?`)
        .bind(doc.id, tenantId, spaceId),
    ]);
    await c.env.PLATFORM_DB.batch(statements);
  }
  let completed = 0;
  for (const doc of documents) {
    const outcome = await processKnowledgeDocumentDeletion(deletionBindings(c.env), doc.id).catch(() => null);
    if (outcome?.state === "complete") completed += 1;
  }
  return c.json({ revoked: documents.length, cleanup_completed: completed, cleanup_pending: documents.length - completed });
});

app.get("/spaces/:spaceId/kb/documents/:docId/deletion", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const documentId = c.req.param("docId");
  const deletion = await c.env.PLATFORM_DB.prepare(`SELECT document_id,project_id,state,attempts,next_attempt_at,last_error,provider_mirror_status,cache_cleanup_status,completed_at
    FROM kb_document_deletion_operations WHERE document_id=? AND tenant_id=? AND space_id=?`)
    .bind(documentId, tenantId, spaceId).first<Pick<KnowledgeDocumentDeletion, "document_id" | "project_id" | "state" | "attempts" | "next_attempt_at" | "last_error" | "provider_mirror_status" | "cache_cleanup_status" | "completed_at">>();
  if (!deletion) throw notFound("Document deletion");
  if (deletion.project_id) {
    const access = await requireProjectAccess(c, deletion.project_id);
    if (access instanceof Response) return access;
  }
  if (deletion.state === "pending" && deletion.last_error === "resource_cleanup_retry_required") {
    return c.json({ deletion: { ...deletion, state: "pending" } }, 200);
  }
  return c.json({ deletion }, 200);
});

// Canonical citation resolver. Neither model nor browser supplies an R2 key: the key and range
// are loaded from the immutable chunk record after tenant/project/role authorization.
app.get("/spaces/:spaceId/projects/:projectId/citations/:documentId/:chunkId", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const projectId = c.req.param("projectId");
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const roleRank = await projectRoleRank(c.env.PLATFORM_DB, tenantId, spaceId, projectId, userId);
  if (roleRank === null) throw notFound("Citation not found");
  const scope = { tenantId, spaceId, projectId, roleRank };
  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT id, document_id, r2_key, content_hash, byte_start, byte_end, line_start, line_end
     FROM kb_chunks k JOIN kb_documents d ON d.id=k.document_id
     WHERE k.id=? AND k.document_id=? AND k.tenant_id=? AND k.space_id=? AND k.project_id=?
       AND k.required_role_rank<=? AND k.deleted_at IS NULL AND d.status='indexed'
       AND (d.source_adapter!='website' OR (d.source_state='current' AND EXISTS (
         SELECT 1 FROM website_connections wc WHERE wc.id=d.source_connection_ref AND wc.tenant_id=d.tenant_id
           AND wc.space_id=d.space_id AND wc.project_id=d.project_id AND wc.status='active'
       )))`
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
  const topK = parseBoundedInteger(url.searchParams.get("top_k"), 10, 1, 50);
  // WS-4: no project_id param = the pre-existing default, search space-wide documents only —
  // never silently mixes in a project's own isolated KB.
  const projectId = url.searchParams.get("project_id");
  if (projectId !== null) {
    const access = await requireProjectAccess(c, projectId);
    if (access instanceof Response) return access;
  }
  // §A1.19: opt-in per request (the caller — e.g. the knowledge-base prebuilt or dashboard —
  // decides), not a stored per-space policy. Falls back to the legacy hybrid pipeline whenever
  // AutoRAG isn't configured on this worker, even if the caller asked for it — never a hard
  // error for an unconfigured optional integration.
  // AutoRAG currently exposes no metadata-filter parameter. It must remain disabled here rather
  // than retrieve broadly and filter afterward (which would leak ranking density).
  const useAutoRag: boolean = false;

  if (!query || query.trim().length === 0 || query.length > 1_000) {
    throw badRequest("q parameter is required and cannot exceed 1000 characters");
  }

  const userId = c.req.header("x-naelao-user-id") ?? "";
  const roleRank = projectId !== null
    ? await projectRoleRank(c.env.PLATFORM_DB, tenantId, spaceId, projectId, userId)
    : effectiveRoleRank(c);
  if (roleRank === null) throw notFound("Project not found");
  const retrievalStartedAt = new Date().toISOString();
  const scope: RetrievalScope = {
    tenantId,
    spaceId,
    projectId: projectId ?? SPACE_WIDE_PROJECT_SENTINEL,
    roleRank,
  };
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
  const deletionPending = await hasPendingKnowledgeDocumentDeletion(c.env.PLATFORM_DB, tenantId, spaceId);
  const cacheGeneration = await readSemanticCacheGeneration(c.env.SEMANTIC_CACHE_KV, tenantId, spaceId).catch(() => null);
  const cacheReadsAllowed = c.env.KNOWLEDGE_RESPONSE_CACHE_ENABLED === "true" && !deletionPending && cacheGeneration !== null;
  const namespace = `${tenantId}:${spaceId}:${scope.projectId}:${roleRank}:${userId}:${mode}:${policyVersion}:${cacheGeneration ?? crypto.randomUUID()}`;
  // Semantic answer cache is checked before any document or web retrieval. Its Vectorize filter
  // enforces space isolation in hardware and the helper applies the strict >.96 threshold.
  const queryEmbedding = await embedText(c.env.AI, query.trim());
  const semanticHit = cacheReadsAllowed
    ? await lookupSemanticCache(
      { vectors: c.env.SEMANTIC_CACHE_VECTORS, kv: c.env.SEMANTIC_CACHE_KV },
      queryEmbedding.embedding,
      { tenantId, spaceId, generation: cacheGeneration! },
    ).catch(() => null)
    : null;
  if (semanticHit && !await hasPendingKnowledgeDocumentDeletion(c.env.PLATFORM_DB, tenantId, spaceId) &&
      await readSemanticCacheGeneration(c.env.SEMANTIC_CACHE_KV, tenantId, spaceId).catch(() => null) === cacheGeneration) {
    return c.json({ answer: semanticHit.text, data: [], citations: [], cached: true,
      cache_id: semanticHit.id, similarity: semanticHit.score, retrieval_mode: "semantic-cache",
      confidence: semanticHit.score, live_grounding: false });
  }
  let lexicalSearchAvailable = true;
  const result = await googleModeSearch(query.trim(), scope, {
    now: Date.now,
    cache: {
      lookup: async (q, _scope, nowMs) => timed("cache_lookup_ms", async () => {
        if (!cacheReadsAllowed || await hasPendingKnowledgeDocumentDeletion(c.env.PLATFORM_DB, tenantId, spaceId) ||
            await readSemanticCacheGeneration(c.env.SEMANTIC_CACHE_KV, tenantId, spaceId).catch(() => null) !== cacheGeneration) return null;
        const key = `grounded:${await sha256Hex(`${namespace}:${q}`)}`;
        const value = await c.env.KB_CACHE.get(key, "json") as { createdAt: number; expiresAt: number; hits: GroundedSearchHit[] } | null;
        if (!value) return null;
        if (value.expiresAt <= nowMs || value.createdAt > nowMs) { await c.env.KB_CACHE.delete(key); return null; }
        return value;
      }),
      store: async (q, _scope, hits, expiresAt) => {
        if (!hits.length || !cacheReadsAllowed ||
            await hasPendingKnowledgeDocumentDeletion(c.env.PLATFORM_DB, tenantId, spaceId) ||
            await readSemanticCacheGeneration(c.env.SEMANTIC_CACHE_KV, tenantId, spaceId).catch(() => null) !== cacheGeneration) return;
        const key = `grounded:${await sha256Hex(`${namespace}:${q}`)}`;
        await safeKvPut(c.env.KB_CACHE, key, JSON.stringify({ createdAt: Date.now(), expiresAt, hits }), { expirationTtl: 3600 });
      },
    },
    dense: async (_q, scoped) => timed("dense_search_ms", async () => {
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
         WHERE k.id IN (${placeholders}) AND ${retrievalPredicate.sql} AND k.deleted_at IS NULL AND d.status='indexed'
           AND (d.source_adapter!='website' OR (d.source_state='current' AND EXISTS (
             SELECT 1 FROM website_connections wc WHERE wc.id=d.source_connection_ref AND wc.tenant_id=d.tenant_id
               AND wc.space_id=d.space_id AND wc.project_id=d.project_id AND wc.status='active'
           )))`
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
    }),
    sparse: async (q, scoped) => timed("sparse_search_ms", async () => {
      try {
        const lexicalCandidates = await queryScopedFtsCandidates({
          db: c.env.PLATFORM_DB,
          query: q,
          tenantId: scoped.tenantId,
          spaceId: scoped.spaceId,
          projectId: scoped.projectId,
          userId,
          roleRank: scoped.roleRank,
        });
        return sparseRank(q, lexicalCandidates);
      } catch {
        lexicalSearchAvailable = false;
        console.warn("[kb] permissioned lexical candidate search unavailable");
        return [];
      }
    }),
    web: async (q, scoped) => timed("web_grounding_ms", async () => {
      if (!c.env.TAVILY_API_KEY) return [];
      const response = await fetch(TAVILY_SEARCH_URL, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: c.env.TAVILY_API_KEY, query: q, max_results: Math.min(topK, 5), search_depth: "basic" }) });
      if (!response.ok) return [];
      // Web excerpts stay external/untrusted until separately ingested. They deliberately receive
      // no fake internal R2 coordinates or citation identity.
      const data = await readBoundedResponseJson<{ results?: TavilyResult[] }>(response, 4 * 1024 * 1024);
      return (data.results ?? []).map((item, index) => ({ id: `web:${index}`, score: item.score ?? 0,
        content: item.content ?? "", r2Key: "", byteStart: 0, byteEnd: 0, title: item.title ?? "", url: item.url ?? "" }));
    }),
    emitTelemetry: (event) => {
      const payload = { ...event, ...telemetry, retrieval_mode: mode, lexical_search: lexicalSearchAvailable ? "available" : "unavailable", result_count: 0 };
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
  const deletionStartedDuringRetrieval = await hasKnowledgeDocumentDeletionSince(
    c.env.PLATFORM_DB, tenantId, spaceId, retrievalStartedAt,
  );
  const finalCacheGeneration = await readSemanticCacheGeneration(c.env.SEMANTIC_CACHE_KV, tenantId, spaceId).catch(() => null);
  if (deletionStartedDuringRetrieval || (cacheGeneration !== null && finalCacheGeneration !== cacheGeneration)) {
    return c.json({ data: [], citations: [], context_instruction: UNTRUSTED_CONTEXT_INSTRUCTION,
      cached: false, retrieval_mode: mode, confidence: 0, live_grounding: false, latency_ms: result.latencyMs });
  }
  return c.json({ data, citations, context_instruction: UNTRUSTED_CONTEXT_INSTRUCTION, cached: result.cacheHit, retrieval_mode: mode,
    lexical_search: lexicalSearchAvailable ? "available" : "unavailable", confidence: result.confidence,
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

async function semanticCacheGenerationKey(tenantId: string, spaceId: string): Promise<string> {
  return `sc-generation:${await sha256Hex(`${tenantId}:${spaceId}`)}`;
}

async function readSemanticCacheGeneration(kv: KVNamespace, tenantId: string, spaceId: string): Promise<string> {
  const generation = await kv.get(await semanticCacheGenerationKey(tenantId, spaceId));
  return generation && generation.length <= 128 ? generation : "0";
}

// A1.16.9 (layer-3 backstop): these routes had NO auth check at all — not even a truthy
// header, just an open POST/DELETE anyone reaching this worker could call. Covers lookup,
// store, and the DELETE invalidation route below (prefix wildcard).
app.use("/internal/semantic-cache/*", requireInternalHmac((c) => (c as unknown as { env: KnowledgeEnv }).env.PLATFORM_SECRET));

app.post("/internal/semantic-cache/lookup", async (c) => {
  const body = await readBoundedJson<{ query: string; spaceId: string }>(c.req.raw, 16 * 1024);
  if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 1_000
    || typeof body.spaceId !== "string" || !body.spaceId || body.spaceId.length > 256) {
    return c.json({ error: "query and spaceId required" }, 400);
  }
  const tenantId = requireTenant(c);
  if (!(await verifySpaceOwnership(c.env.PLATFORM_DB, body.spaceId, tenantId))) throw notFound("Space");
  if (c.env.KNOWLEDGE_RESPONSE_CACHE_ENABLED !== "true") return c.json({ hit: false, reason: "cache_disabled" });
  if (await knowledgeEgressDenied(c.env, body.spaceId)) return airGapResponse(c);
  if (await hasPendingKnowledgeDocumentDeletion(c.env.PLATFORM_DB, tenantId, body.spaceId)) {
    return c.json({ hit: false, reason: "knowledge_deletion_pending" });
  }

  // Fail open if Vectorize binding not available (optional binding)
  if (!c.env.SEMANTIC_CACHE_VECTORS || !c.env.SEMANTIC_CACHE_KV) {
    return c.json({ hit: false });
  }

  try {
    const generation = await readSemanticCacheGeneration(c.env.SEMANTIC_CACHE_KV, tenantId, body.spaceId);
    const embedding = await embedText(c.env.AI, body.query);

    const results = await c.env.SEMANTIC_CACHE_VECTORS.query(embedding.embedding, {
      topK: 1,
      filter: { tenant_id: { $eq: tenantId }, space_id: { $eq: body.spaceId }, generation: { $eq: generation } },
      returnMetadata: "indexed",
    });

    const top = results.matches?.[0];
    if (!top || (top.score ?? 0) <= SEMANTIC_CACHE_SIMILARITY_THRESHOLD) {
      return c.json({ hit: false });
    }

    const cacheId = top.id;
    const metadata = top.metadata as Record<string, unknown> | undefined;
    const expiresAt = metadata?.["expires_at"];

    // Check if expired (Vectorize has no TTL — checked via metadata)
    if (!Number.isSafeInteger(expiresAt) || Number(expiresAt) <= Date.now()) {
      // Async cleanup of stale vector — don't block response
      c.executionCtx.waitUntil(c.env.SEMANTIC_CACHE_VECTORS.deleteByIds([cacheId]));
      return c.json({ hit: false });
    }

    const cachedResponse = await c.env.SEMANTIC_CACHE_KV.get(`sc:${cacheId}`);
    if (!cachedResponse) {
      return c.json({ hit: false });
    }
    if (cachedResponse.length > 1_048_576) {
      c.executionCtx.waitUntil(c.env.SEMANTIC_CACHE_KV.delete(`sc:${cacheId}`));
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
  const body = await readBoundedJson<{ query: string; spaceId: string; response: string }>(c.req.raw, 2 * 1024 * 1024);
  if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 1_000
    || typeof body.spaceId !== "string" || !body.spaceId || body.spaceId.length > 256
    || typeof body.response !== "string" || !body.response || body.response.length > 1_048_576) {
    return c.json({ error: "query, spaceId, and response required" }, 400);
  }
  const tenantId = requireTenant(c);
  if (!(await verifySpaceOwnership(c.env.PLATFORM_DB, body.spaceId, tenantId))) throw notFound("Space");
  if (c.env.KNOWLEDGE_RESPONSE_CACHE_ENABLED !== "true") return c.json({ stored: false, reason: "cache_disabled" });
  if (await knowledgeEgressDenied(c.env, body.spaceId)) return airGapResponse(c);
  if (await hasPendingKnowledgeDocumentDeletion(c.env.PLATFORM_DB, tenantId, body.spaceId)) {
    return c.json({ stored: false, reason: "knowledge_deletion_pending" });
  }

  if (!c.env.SEMANTIC_CACHE_VECTORS || !c.env.SEMANTIC_CACHE_KV) {
    return c.json({ stored: false, reason: "semantic cache not configured" });
  }

  try {
    const generation = await readSemanticCacheGeneration(c.env.SEMANTIC_CACHE_KV, tenantId, body.spaceId);
    const cacheId = crypto.randomUUID();
    const embedding = await embedText(c.env.AI, body.query);
    // Pair the generation read with a final tombstone check. If deletion begins after this
    // check, its generation rotation makes this write unreachable; if it began before, reject.
    if (await hasPendingKnowledgeDocumentDeletion(c.env.PLATFORM_DB, tenantId, body.spaceId)) {
      return c.json({ stored: false, reason: "knowledge_deletion_pending" });
    }
    const expiresAt = Date.now() + SEMANTIC_CACHE_TTL_SECS * 1000;

    await c.env.SEMANTIC_CACHE_VECTORS.upsert([{
      id: cacheId,
      values: embedding.embedding,
      metadata: {
        tenant_id: tenantId,
        space_id: body.spaceId,
        generation,
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

// Durable, request-scoped semantic-cache purge for whole-Space erasure.
app.delete("/internal/semantic-cache", async (c) => {
  const spaceId = c.req.query("spaceId");
  if (!spaceId || spaceId.length > 256) return c.json({ error: "spaceId must contain 1..256 characters" }, 400);
  const tenantId = requireTenant(c);
  const requestId = c.req.query("requestId");
  if (!requestId || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
    return c.json({ error: "requestId is required" }, 400);
  }
  const request = await c.env.PLATFORM_DB.prepare(`SELECT status FROM gdpr_requests
    WHERE id=? AND tenant_id=? AND request_type='erasure'`)
    .bind(requestId, tenantId).first<{ status: string }>();
  if (!request || !["processing", "completed"].includes(request.status)) throw notFound("Erasure request");

  const operationId = `spacecache_${await sha256Hex(`${tenantId}:${requestId}:${spaceId}`)}`;
  let operation = await c.env.PLATFORM_DB.prepare(`SELECT * FROM kb_document_deletion_operations
    WHERE tenant_id=? AND space_id=? AND operation_kind='space_cache' AND erasure_request_id=?`)
    .bind(tenantId, spaceId, requestId).first<KnowledgeDocumentDeletion>();
  if (!operation) {
    // A completed request may only resume an operation created while the exact Space still
    // belonged to this tenant; it cannot use the internal route to start new cleanup work.
    if (request.status !== "processing" ||
        !(await verifySpaceTenantOwnership(c.env.PLATFORM_DB, spaceId, tenantId))) throw notFound("Space");
    const now = new Date().toISOString();
    await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO kb_document_deletion_operations
        (document_id,tenant_id,space_id,project_id,chunk_count,state,next_attempt_at,created_at,updated_at,
         operation_kind,erasure_request_id,cache_generation_to_purge,cache_cleanup_status)
        VALUES(?,?,?,NULL,0,'pending',?,?,?,'space_cache',?,'*','not_started')`)
        .bind(operationId, tenantId, spaceId, now, now, now, requestId),
      c.env.PLATFORM_DB.prepare(`UPDATE gdpr_requests SET cache_cleanup_status='pending',updated_at=?
        WHERE id=? AND tenant_id=? AND request_type='erasure' AND status='processing'`)
        .bind(now, requestId, tenantId),
    ]);
    operation = await c.env.PLATFORM_DB.prepare(`SELECT * FROM kb_document_deletion_operations
      WHERE tenant_id=? AND space_id=? AND operation_kind='space_cache' AND erasure_request_id=?`)
      .bind(tenantId, spaceId, requestId).first<KnowledgeDocumentDeletion>();
  }
  if (!operation) throw new HttpError(503, "upstream_error", "Space cache cleanup receipt is unavailable");

  try {
    const result = await processKnowledgeDocumentDeletion(deletionBindings(c.env), operation.document_id);
    const receipt = await c.env.PLATFORM_DB.prepare(`SELECT state,cache_cleanup_status FROM kb_document_deletion_operations
      WHERE document_id=? AND tenant_id=? AND space_id=? AND erasure_request_id=?`)
      .bind(operation.document_id, tenantId, spaceId, requestId)
      .first<{ state: string; cache_cleanup_status: "not_started" | "pending" | "complete" }>();
    const cleanupPending = !receipt || receipt.state !== "complete" || receipt.cache_cleanup_status !== "complete";
    return c.json({ invalidated: true, cleanup_pending: cleanupPending,
      cache_cleanup_status: receipt?.cache_cleanup_status ?? "pending", state: result.state });
  } catch (err) {
    console.warn(`[SemanticCache] Invalidation error: ${err}`);
    return c.json({ error: "cache_cleanup_unavailable" }, 503);
  }
});

// ── UNIVERSAL / PLATFORM-PROVIDED web search (CLAUDE.md "universal tools") ──────
//
// Web search is bundled by Naelao exactly like Claude/ChatGPT bundle it: the platform holds ONE
// provider key (TAVILY_API_KEY, a Workers Secret) and every agent gets search for free. This is
// the platform-held `commerce` key precedent, NOT the BYO-key `space_credentials` model
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
const WEB_SEARCH_QUERY_MAX_CHARS = 1_000;
const WEB_TARGET_URL_MAX_CHARS = 2_048;

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
  // Egress policy is tenant-owned. A caller must not select another tenant's space to borrow
  // its less restrictive policy or bypass an air-gap decision.
  if (!spaceId) return airGapResponse(c);
  const tenantId = requireTenant(c);
  if (!(await verifySpaceOwnership(c.env.PLATFORM_DB, spaceId, tenantId))) throw notFound("Space");
  if (await knowledgeEgressDenied(c.env, spaceId)) return airGapResponse(c);
  return null;
}

app.post("/internal/web-search/search", async (c) => {
  const denied = await requireWebToolEgress(c);
  if (denied) return denied;
  const body = await readBoundedJsonOr(c.req.raw, 16 * 1024, {} as { query?: string; max_results?: number });
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > WEB_SEARCH_QUERY_MAX_CHARS)
    return c.json({ error_code: "bad_request", message: "query must be 1..1000 characters" }, 400);
  const maxResults = body.max_results === undefined ? 10 : body.max_results;
  if (!Number.isSafeInteger(maxResults) || Number(maxResults) < 1 || Number(maxResults) > 20)
    return c.json({ error_code: "bad_request", message: "max_results must be 1..20" }, 400);

  // Honest degradation: no platform key → report unconfigured, don't fake empty results.
  if (!c.env.TAVILY_API_KEY) {
    return c.json({ configured: false, results: [], message: "platform web search is not configured" });
  }

  try {
    const resp = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
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
    const data = await readBoundedResponseJson<{ answer?: string; results?: TavilyResult[] }>(resp, 4 * 1024 * 1024);
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
  const body = await readBoundedJsonOr(c.req.raw, 16 * 1024, {} as { url?: string; format?: "markdown" | "html" });
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl || rawUrl.length > WEB_TARGET_URL_MAX_CHARS)
    return c.json({ error_code: "bad_request", message: "url must be 1..2048 characters" }, 400);
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
    const guarded = await fetchSsrfGuarded(target.href, {
        headers: {
          "user-agent": "naelao-agent/1.0",
          accept: body.format === "markdown" ? "text/markdown, text/html;q=0.9, */*;q=0.8" : "text/html, */*;q=0.8",
        },
      });
    if (!guarded.ok) return c.json({ error_code: guarded.status === 403 ? "forbidden" : "bad_gateway", message: guarded.message }, guarded.status);
    const resp = guarded.response;
    target = guarded.url;
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

async function readBoundedBytes(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024));
  let bytesRead = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytesRead;
      const take = Math.min(remaining, value.byteLength);
      if (take > 0) {
        const required = bytesRead + take;
        if (required > buffer.byteLength) {
          const capacity = Math.min(maxBytes, Math.max(required, buffer.byteLength * 2));
          const grown = new Uint8Array(capacity);
          grown.set(buffer.subarray(0, bytesRead));
          buffer = grown;
        }
        buffer.set(value.subarray(0, take), bytesRead);
        bytesRead += take;
      }
      if (take < value.byteLength) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: buffer.slice(0, bytesRead), truncated };
}

type GuardedFetchResult =
  | { ok: true; response: Response; url: URL }
  | { ok: false; status: 403 | 502; message: string };

async function fetchSsrfGuarded(rawUrl: string, init: RequestInit, allowedOrigins?: readonly string[],
  authorizeTarget?: (target: URL) => Promise<WebsiteTargetAuthorization>): Promise<GuardedFetchResult> {
  let target: URL;
  try { target = new URL(rawUrl); }
  catch { return { ok: false, status: 403, message: "Destination URL is invalid" }; }
  const signal = init.signal ?? AbortSignal.timeout(30_000);
  for (let hop = 0; hop <= 5; hop++) {
    if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password
      || (allowedOrigins !== undefined && (target.protocol !== "https:" || target.search || target.hash))) {
      return { ok: false, status: 403, message: "Destination must be an http(s) URL without embedded credentials" };
    }
    if (allowedOrigins && !allowedOrigins.includes(target.origin)) {
      return { ok: false, status: 403, message: "Website redirect destination is outside the approved connection origins" };
    }
    const ssrf = await checkSsrf(target.href);
    if (ssrf.blocked) return { ok: false, status: 403, message: ssrf.reason ?? "url failed SSRF validation" };
    if (authorizeTarget) {
      const authorization = await authorizeTarget(target);
      if (!authorization.ok) return authorization;
    }
    const response = await fetch(target.href, { ...init, signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { ok: true, response, url: target };
    const location = response.headers.get("location");
    if (!location) return { ok: false, status: 502, message: "redirect response omitted Location" };
    if (hop === 5) return { ok: false, status: 502, message: "redirect limit exceeded" };
    try { target = new URL(location, target); }
    catch { return { ok: false, status: 403, message: "redirect destination is invalid" }; }
    await response.body?.cancel().catch(() => undefined);
  }
  return { ok: false, status: 502, message: "redirect limit exceeded" };
}

app.post("/internal/web-search/extract", async (c) => {
  const denied = await requireWebToolEgress(c);
  if (denied) return denied;
  const body = await readBoundedJsonOr(c.req.raw, 32 * 1024, {} as { url?: string; schema?: unknown });
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl || rawUrl.length > WEB_TARGET_URL_MAX_CHARS)
    return c.json({ error_code: "bad_request", message: "url must be 1..2048 characters" }, 400);

  const ssrf = await checkSsrf(rawUrl);
  if (ssrf.blocked) return c.json({ error_code: "forbidden", message: ssrf.reason ?? "url failed SSRF validation" }, 403);

  // Prefer the provider's clean extraction; without a platform key fall back to a keyless
  // SSRF-guarded raw fetch so extract still returns *something* usable rather than nothing.
  if (c.env.TAVILY_API_KEY) {
    try {
      const resp = await fetch(TAVILY_EXTRACT_URL, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: c.env.TAVILY_API_KEY, urls: [rawUrl] }),
      });
      if (resp.ok) {
        const data = await readBoundedResponseJson<{ results?: Array<{ url?: string; raw_content?: string }> }>(resp, 4 * 1024 * 1024);
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
    const guarded = await fetchSsrfGuarded(rawUrl, { headers: { "user-agent": "naelao-agent/1.0" } });
    if (!guarded.ok) return c.json({ error_code: guarded.status === 403 ? "forbidden" : "bad_gateway", message: guarded.message }, guarded.status);
    const { content, truncated } = await readBoundedText(guarded.response, WEB_SEARCH_CONTENT_CAP);
    return c.json({ configured: Boolean(c.env.TAVILY_API_KEY), url: guarded.url.href, content, truncated });
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
  const body = await readBoundedJsonOr(c.req.raw, 16 * 1024, {} as { url?: string });
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl || rawUrl.length > WEB_TARGET_URL_MAX_CHARS)
    return c.json({ error_code: "bad_request", message: "url must be 1..2048 characters" }, 400);

  const ssrf = await checkSsrf(rawUrl);
  if (ssrf.blocked) return c.json({ error_code: "forbidden", message: ssrf.reason ?? "url failed SSRF validation" }, 403);

  try {
    const guarded = await fetchSsrfGuarded(rawUrl, { headers: { "user-agent": "naelao-agent/1.0" } });
    if (!guarded.ok) return c.json({ error_code: guarded.status === 403 ? "forbidden" : "bad_gateway", message: guarded.message }, guarded.status);
    const resp = guarded.response;
    const contentType = (resp.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const maxBytes = isTextualContentType(contentType) ? WEB_DOWNLOAD_CONTENT_CAP : WEB_DOWNLOAD_BINARY_CAP;
    const { bytes, truncated } = await readBoundedBytes(resp, maxBytes);

    if (isTextualContentType(contentType)) {
      const full = new TextDecoder().decode(bytes);
      return c.json({
        url: guarded.url.href, status: resp.status, encoding: "text", content_type: contentType || "text/plain",
        content: full.slice(0, WEB_DOWNLOAD_CONTENT_CAP),
        size: full.length, truncated,
      });
    }

    if (truncated) {
      return c.json({
        url: guarded.url.href, status: resp.status, content: null, content_type: contentType,
        error: `file exceeds the ${WEB_DOWNLOAD_BINARY_CAP}-byte download limit. Binary files are not truncated because a partial file is corrupt.`,
      }, 413);
    }
    // Buffer (nodejs_compat is on for this worker) rather than String.fromCharCode(...bytes),
    // which blows the call stack on a large array — the same trap already hit and fixed once in
    // the browser worker's screenshot path.
    return c.json({
      url: guarded.url.href, status: resp.status, encoding: "base64",
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

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: KnowledgeEnv, ctx: ExecutionContext) {
    ctx.waitUntil(reconcileKnowledgeDocumentDeletions(deletionBindings(env), 20));
  },
} satisfies ExportedHandler<KnowledgeEnv>;
