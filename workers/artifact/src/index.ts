// G-A01: Artifact worker — agent-authored deliverable storage in R2.
//
// Phase 5: this worker existed but was never actually wired into anything — no router route,
// no service binding from any caller, and its own routes/auth were built for a shape that could
// never have worked once wired: routes were registered under /v1/artifacts with spaceId read from
// an `x-naelao-space-id` HEADER (proxyTo strips /v1 before forwarding, and the router only ever
// resets/verifies tenant-id/user-id/role headers — a raw space-id header would have been fully
// caller-spoofable), and there was NO auth gate of any kind, trusting every identity header as-is.
// Rebuilt to match this codebase's real convention: spaceId in the URL PATH (like every other
// worker's /spaces/:spaceId/... routes), requireInternalHmac gating every route (this worker is
// workers_dev=false and reached only via a direct service binding or the router's proxyTo, never
// directly), and a real LIST route (there wasn't one — a per-space artifact browser needs it).
import { badRequest, errorResponse, notFound, requestId, requireInternalHmac } from "@naelao/http";
import { Hono } from "hono";
export { RepositoryDO } from "./RepositoryDO.js";
import { repositoryName, assertSegment } from "./repository.js";

// ── Env ───────────────────────────────────────────────────────────────────────

export interface ArtifactEnv {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  ARTIFACT_BUCKET: R2Bucket;
  REPOSITORY_OBJECTS: R2Bucket;
  REPOSITORY_DO: DurableObjectNamespace;
}

function validateEnv(env: ArtifactEnv): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Keyed {tenantId}/{spaceId}/{artifactId}/{filename} — one artifact is exactly one R2 object (no
// chunking, unlike KB documents), so a list-by-prefix at the artifact-id level always returns
// either zero or one real object.
function buildR2Key(tenantId: string, spaceId: string, artifactId: string, filename: string): string {
  return `${tenantId}/${spaceId}/${artifactId}/${filename}`;
}
function buildR2Prefix(tenantId: string, spaceId: string, artifactId?: string): string {
  return artifactId ? `${tenantId}/${spaceId}/${artifactId}/` : `${tenantId}/${spaceId}/`;
}

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

function requireTenant(c: { req: { header: (h: string) => string | undefined } }): string {
  const tenantId = c.req.header("x-naelao-tenant-id");
  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");
  return tenantId;
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: ArtifactEnv }>();

app.use("*", requestId);
app.use("*", async (c, next) => {
  validateEnv(c.env);
  await next();
});

app.use("/spaces/:spaceId/artifacts", requireInternalHmac((c) => (c as unknown as { env: ArtifactEnv }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/artifacts/*", requireInternalHmac((c) => (c as unknown as { env: ArtifactEnv }).env.PLATFORM_SECRET));

// Repository operations are routed to exactly one Durable Object per tenant/space/project. The
// caller cannot select a DO id or R2 prefix directly; both are derived from authenticated scope.
app.use("/spaces/:spaceId/projects/:projectId/repository/*", requireInternalHmac((c) => (c as unknown as { env: ArtifactEnv }).env.PLATFORM_SECRET));
app.all("/spaces/:spaceId/projects/:projectId/repository/:operation", async (c) => {
  const scope = {
    tenantId: assertSegment(requireTenant(c), "tenant"),
    spaceId: assertSegment(c.req.param("spaceId"), "space"),
    projectId: assertSegment(c.req.param("projectId"), "project"),
  };
  const stub = c.env.REPOSITORY_DO.get(c.env.REPOSITORY_DO.idFromName(repositoryName(scope)));
  const source = new URL(c.req.url);
  const target = new URL(`https://repository.internal/${c.req.param("operation")}`);
  target.search = source.search;
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-repository-scope", JSON.stringify(scope));
  return stub.fetch(new Request(target, { method: c.req.method, headers, body: c.req.raw.body }));
});

// POST /spaces/:spaceId/artifacts — create an artifact. Accepts multipart/form-data (a 'file'
// field) OR a JSON body — either {filename, content, content_type?} for plain text (the common
// agent-authored case: HTML/markdown/code) or {filename, content_type, data_base64} for binary.
app.post("/spaces/:spaceId/artifacts", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const artifactId = crypto.randomUUID();
  const contentType = c.req.header("content-type") ?? "";

  let fileBytes: Uint8Array;
  let filename: string;
  let mimeType: string;

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const fileField = formData.get("file");
    if (!fileField || typeof fileField === "string") {
      throw badRequest("multipart body must contain a 'file' field");
    }
    const fileBlob = fileField as unknown as Blob & { name: string; type: string };
    filename = fileBlob.name || `artifact-${artifactId}`;
    mimeType = fileBlob.type || "application/octet-stream";
    fileBytes = new Uint8Array(await fileBlob.arrayBuffer());
  } else {
    let body: { content_type?: string; content?: string; data_base64?: string; filename?: string };
    try {
      body = await c.req.json();
    } catch {
      throw badRequest("Invalid JSON body or unsupported content type");
    }
    if (!body.filename) throw badRequest("filename is required");
    filename = body.filename;
    mimeType = body.content_type || "text/plain";
    if (typeof body.content === "string") {
      fileBytes = new TextEncoder().encode(body.content);
    } else if (body.data_base64) {
      const binaryStr = atob(body.data_base64);
      fileBytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        fileBytes[i] = binaryStr.charCodeAt(i);
      }
    } else {
      throw badRequest("content or data_base64 is required");
    }
  }

  if (fileBytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw badRequest(`Artifact exceeds the maximum size of 5MB`);
  }

  const r2Key = buildR2Key(tenantId, spaceId, artifactId, filename);
  await c.env.ARTIFACT_BUCKET.put(r2Key, fileBytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { tenantId, spaceId, filename, content_type: mimeType },
  });

  return c.json(
    { artifact_id: artifactId, filename, content_type: mimeType, size: fileBytes.byteLength },
    201
  );
});

// GET /spaces/:spaceId/artifacts — list every artifact in this space.
app.get("/spaces/:spaceId/artifacts", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const prefix = buildR2Prefix(tenantId, spaceId);
  const items: Array<{ artifact_id: string; filename: string; content_type: string; size: number; uploaded: string }> = [];
  let cursor: string | undefined;
  do {
    const listed = await c.env.ARTIFACT_BUCKET.list({ prefix, ...(cursor ? { cursor } : {}), limit: 200 });
    for (const o of listed.objects) {
      const rest = o.key.slice(prefix.length); // {artifactId}/{filename}
      const slash = rest.indexOf("/");
      const artifactId = slash === -1 ? rest : rest.slice(0, slash);
      const filename = slash === -1 ? "" : rest.slice(slash + 1);
      items.push({
        artifact_id: artifactId,
        filename,
        content_type: o.customMetadata?.["content_type"] ?? o.httpMetadata?.contentType ?? "application/octet-stream",
        size: o.size,
        uploaded: o.uploaded.toISOString(),
      });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor && items.length < 500);
  return c.json({ data: items, count: items.length });
});

// GET /spaces/:spaceId/artifacts/:artifactId — download/preview one artifact.
app.get("/spaces/:spaceId/artifacts/:artifactId", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const artifactId = c.req.param("artifactId");

  const prefix = buildR2Prefix(tenantId, spaceId, artifactId);
  const listed = await c.env.ARTIFACT_BUCKET.list({ prefix });
  const firstObject = listed.objects[0];
  if (!firstObject) throw notFound("Artifact");

  const object = await c.env.ARTIFACT_BUCKET.get(firstObject.key);
  if (!object) throw notFound("Artifact");

  const mimeType =
    object.customMetadata?.["content_type"] ?? object.httpMetadata?.contentType ?? "application/octet-stream";

  return new Response(object.body, {
    headers: {
      "Content-Type": mimeType,
      "Cache-Control": "private, max-age=3600",
      "X-Artifact-Id": artifactId,
      "X-Artifact-Filename": firstObject.key.slice(prefix.length),
    },
  });
});

// DELETE /spaces/:spaceId/artifacts/:artifactId — delete an artifact.
app.delete("/spaces/:spaceId/artifacts/:artifactId", async (c) => {
  const tenantId = requireTenant(c);
  const spaceId = c.req.param("spaceId");
  const artifactId = c.req.param("artifactId");

  const prefix = buildR2Prefix(tenantId, spaceId, artifactId);
  const listed = await c.env.ARTIFACT_BUCKET.list({ prefix });
  if (listed.objects.length === 0) throw notFound("Artifact");

  const deleteKeys = listed.objects.map((obj) => obj.key);
  await Promise.all(deleteKeys.map((key) => c.env.ARTIFACT_BUCKET.delete(key)));

  return c.json({ deleted: true, count: deleteKeys.length });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

// ── Export ────────────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,
} satisfies ExportedHandler<ArtifactEnv>;
