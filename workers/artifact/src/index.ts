// G-A01: Artifact worker — agent-generated file storage in R2
import { badRequest, errorResponse, notFound, requestId } from "@naelao/http";
import { Hono } from "hono";

// ── Env ───────────────────────────────────────────────────────────────────────

export interface ArtifactEnv {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  ARTIFACT_BUCKET: R2Bucket;
}

function validateEnv(env: ArtifactEnv): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildR2Key(tenantId: string, spaceId: string, artifactId: string, filename: string): string {
  return `${tenantId}/${spaceId}/${artifactId}/${filename}`;
}

function buildR2Prefix(tenantId: string, spaceId: string, artifactId: string): string {
  return `${tenantId}/${spaceId}/${artifactId}/`;
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: ArtifactEnv }>();

app.use("*", requestId);
app.use("*", async (c, next) => {
  validateEnv(c.env);
  await next();
});

// POST /v1/artifacts — upload artifact
app.post("/v1/artifacts", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.header("x-naelao-space-id") ?? "";

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");
  if (!spaceId) throw badRequest("x-naelao-space-id header is required");

  const artifactId = crypto.randomUUID();
  const contentType = c.req.header("content-type") ?? "";

  let fileBytes: Uint8Array;
  let filename: string;
  let mimeType: string;

  if (contentType.includes("multipart/form-data")) {
    // Handle multipart/form-data upload
    const formData = await c.req.formData();
    const fileField = formData.get("file");

    if (!fileField || typeof fileField === "string") {
      throw badRequest("multipart body must contain a 'file' field");
    }

    // fileField is a File — cast through Blob which is the common ancestor
    const fileBlob = fileField as unknown as Blob & { name: string; type: string };
    filename = fileBlob.name || `artifact-${artifactId}`;
    mimeType = fileBlob.type || "application/octet-stream";
    const arrayBuffer = await fileBlob.arrayBuffer();
    fileBytes = new Uint8Array(arrayBuffer);
  } else {
    // Handle JSON body: { content_type, data_base64, filename }
    let body: { content_type: string; data_base64: string; filename: string };
    try {
      body = await c.req.json<{ content_type: string; data_base64: string; filename: string }>();
    } catch {
      throw badRequest("Invalid JSON body or unsupported content type");
    }

    if (!body.content_type) throw badRequest("content_type is required");
    if (!body.data_base64) throw badRequest("data_base64 is required");
    if (!body.filename) throw badRequest("filename is required");

    filename = body.filename;
    mimeType = body.content_type;

    // Decode base64
    const binaryStr = atob(body.data_base64);
    fileBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      fileBytes[i] = binaryStr.charCodeAt(i);
    }
  }

  const r2Key = buildR2Key(tenantId, spaceId, artifactId, filename);

  await c.env.ARTIFACT_BUCKET.put(r2Key, fileBytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { tenantId, spaceId, filename, content_type: mimeType },
  });

  const downloadUrl = `/v1/artifacts/${artifactId}`;

  return c.json(
    {
      artifact_id: artifactId,
      key: r2Key,
      download_url: downloadUrl,
    },
    201
  );
});

// GET /v1/artifacts/:artifactId — download artifact
app.get("/v1/artifacts/:artifactId", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.header("x-naelao-space-id") ?? "";
  const artifactId = c.req.param("artifactId");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");
  if (!spaceId) throw badRequest("x-naelao-space-id header is required");

  const prefix = buildR2Prefix(tenantId, spaceId, artifactId);

  // List objects with this prefix to find the key
  const listed = await c.env.ARTIFACT_BUCKET.list({ prefix });

  const firstObject = listed.objects[0];
  if (!firstObject) {
    throw notFound("Artifact");
  }

  const r2Key = firstObject.key;
  const object = await c.env.ARTIFACT_BUCKET.get(r2Key);

  if (!object) {
    throw notFound("Artifact");
  }

  const mimeType =
    object.customMetadata?.["content_type"] ??
    object.httpMetadata?.contentType ??
    "application/octet-stream";

  return new Response(object.body, {
    headers: {
      "Content-Type": mimeType,
      "Cache-Control": "private, max-age=3600",
      "X-Artifact-Id": artifactId,
    },
  });
});

// DELETE /v1/artifacts/:artifactId — delete artifact
app.delete("/v1/artifacts/:artifactId", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.header("x-naelao-space-id") ?? "";
  const artifactId = c.req.param("artifactId");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");
  if (!spaceId) throw badRequest("x-naelao-space-id header is required");

  const prefix = buildR2Prefix(tenantId, spaceId, artifactId);

  // List all objects with this prefix
  const listed = await c.env.ARTIFACT_BUCKET.list({ prefix });

  if (listed.objects.length === 0) {
    throw notFound("Artifact");
  }

  // Delete all objects under this prefix
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
