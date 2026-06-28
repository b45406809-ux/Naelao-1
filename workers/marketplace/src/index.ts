// G-M01..G-M10: Marketplace — SpaceType publishing, review workflow, discovery, ratings, fork
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SPACE_TYPES_INDEX: VectorizeIndex;
}

interface SpaceTypeListing {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  category: string;
  tags: string;
  config_schema: string;
  status: "draft" | "pending" | "published" | "rejected";
  install_count: number;
  avg_rating: number;
  review_count: number;
  published_at: string | null;
  created_at: string;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }) {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
    role: c.req.header("x-naelao-role") ?? "member",
  };
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// Discovery — search and list published SpaceTypes
app.get("/v1/marketplace", async (c) => {
  const url = new URL(c.req.url);
  const q = url.searchParams.get("q") ?? "";
  const category = url.searchParams.get("category");
  const sort = url.searchParams.get("sort") ?? "installs"; // installs | rating | newest
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  let results: SpaceTypeListing[];

  if (q) {
    // Semantic search via Vectorize
    const embedding = await embedText(q, c.env);
    const vectorResults = await c.env.SPACE_TYPES_INDEX.query(embedding, {
      topK: limit + offset,
      filter: { status: { $eq: "published" } },
      returnMetadata: "all",
    });
    const ids = vectorResults.matches
      .slice(offset, offset + limit)
      .map((m) => m.id);
    if (ids.length === 0) return c.json({ data: [], total: 0 });
    const placeholders = ids.map(() => "?").join(",");
    const { results: rows } = await c.env.PLATFORM_DB.prepare(
      `SELECT id, tenant_id, name, description, category, tags, status, install_count, avg_rating, review_count, published_at, created_at
       FROM space_type_listings WHERE id IN (${placeholders}) AND status = 'published'`
    ).bind(...ids).all<SpaceTypeListing>();
    results = rows;
  } else {
    const orderClause = sort === "rating" ? "avg_rating DESC" : sort === "newest" ? "published_at DESC" : "install_count DESC";
    const catClause = category ? "AND category = ?" : "";
    const params: unknown[] = category ? [category, limit, offset] : [limit, offset];
    const { results: rows } = await c.env.PLATFORM_DB.prepare(
      `SELECT id, tenant_id, name, description, category, tags, status, install_count, avg_rating, review_count, published_at, created_at
       FROM space_type_listings WHERE status = 'published' ${catClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`
    ).bind(...params).all<SpaceTypeListing>();
    results = rows;
  }

  return c.json({ data: results });
});

// Get single listing
app.get("/v1/marketplace/:id", async (c) => {
  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT id, tenant_id, name, description, category, tags, config_schema, status, install_count, avg_rating, review_count, published_at, created_at
     FROM space_type_listings WHERE id = ? AND status = 'published'`
  ).bind(c.req.param("id")).first<SpaceTypeListing>();
  if (!row) return c.json({ error_code: "not_found", message: "SpaceType not found" }, 404);
  return c.json({ data: row });
});

// Publish a SpaceType (submit for review)
app.post("/v1/marketplace", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{
    name: string;
    description: string;
    category: string;
    tags?: string[];
    config_schema: Record<string, unknown>;
    space_type_id: string;
  }>();
  if (!body.name || !body.description || !body.category || !body.config_schema || !body.space_type_id) {
    return c.json({ error_code: "bad_request", message: "name, description, category, config_schema, space_type_id required" }, 400);
  }
  // Verify the space_type belongs to this tenant
  const existing = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM space_types WHERE id = ? AND tenant_id = ?"
  ).bind(body.space_type_id, tenantId).first<{ id: string }>();
  if (!existing) return c.json({ error_code: "not_found", message: "SpaceType not found" }, 404);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const tags = JSON.stringify(body.tags ?? []);
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO space_type_listings (id, space_type_id, tenant_id, name, description, category, tags, config_schema, status, install_count, avg_rating, review_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?)`
  ).bind(id, body.space_type_id, tenantId, body.name, body.description, body.category, tags, JSON.stringify(body.config_schema), now, now).run();

  // Index in Vectorize for semantic search
  const text = `${body.name} ${body.description} ${body.category} ${(body.tags ?? []).join(" ")}`;
  const embedding = await embedText(text, c.env);
  await c.env.SPACE_TYPES_INDEX.upsert([{
    id,
    values: embedding,
    metadata: { status: "pending", category: body.category, tenant_id: tenantId },
  }]);

  return c.json({ id, status: "pending", message: "Submitted for review" }, 201);
});

// Admin: approve / reject listing
app.patch("/v1/marketplace/:id/review", async (c) => {
  const { role } = getCallerIdentity(c);
  if (role !== "platform_admin") return c.json({ error_code: "forbidden", message: "Platform admin only" }, 403);
  const body = await c.req.json<{ action: "approve" | "reject"; rejection_reason?: string }>();
  if (!body.action) return c.json({ error_code: "bad_request", message: "action required" }, 400);
  const now = new Date().toISOString();
  const status = body.action === "approve" ? "published" : "rejected";
  const publishedAt = body.action === "approve" ? now : null;
  await c.env.PLATFORM_DB.prepare(
    "UPDATE space_type_listings SET status = ?, published_at = ?, rejection_reason = ?, updated_at = ? WHERE id = ?"
  ).bind(status, publishedAt, body.rejection_reason ?? null, now, c.req.param("id")).run();

  // Update Vectorize metadata so discovery filter works
  if (body.action === "approve") {
    const row = await c.env.PLATFORM_DB.prepare(
      "SELECT category, tenant_id FROM space_type_listings WHERE id = ?"
    ).bind(c.req.param("id")).first<{ category: string; tenant_id: string }>();
    if (row) {
      await c.env.SPACE_TYPES_INDEX.upsert([{
        id: c.req.param("id"),
        values: new Array(1536).fill(0) as number[],
        metadata: { status: "published", category: row.category, tenant_id: row.tenant_id },
      }]);
    }
  }

  return c.json({ id: c.req.param("id"), status, updated_at: now });
});

// Submit a review/rating
app.post("/v1/marketplace/:id/reviews", async (c) => {
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized", message: "Missing tenant or user" }, 401);
  const body = await c.req.json<{ rating: number; comment?: string }>();
  if (!body.rating || body.rating < 1 || body.rating > 5) {
    return c.json({ error_code: "bad_request", message: "rating must be 1-5" }, 400);
  }
  const listingId = c.req.param("id");
  // Ensure listing exists and is published
  const listing = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM space_type_listings WHERE id = ? AND status = 'published'"
  ).bind(listingId).first<{ id: string }>();
  if (!listing) return c.json({ error_code: "not_found", message: "Listing not found" }, 404);

  const reviewId = crypto.randomUUID();
  const now = new Date().toISOString();
  // Upsert review (one per user per listing)
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO marketplace_reviews (id, listing_id, tenant_id, user_id, rating, comment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (listing_id, user_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, updated_at = excluded.updated_at`
  ).bind(reviewId, listingId, tenantId, userId, body.rating, body.comment ?? null, now, now).run();

  // Recompute avg_rating and review_count
  const stats = await c.env.PLATFORM_DB.prepare(
    "SELECT COUNT(*) as cnt, AVG(rating) as avg FROM marketplace_reviews WHERE listing_id = ?"
  ).bind(listingId).first<{ cnt: number; avg: number }>();
  await c.env.PLATFORM_DB.prepare(
    "UPDATE space_type_listings SET avg_rating = ?, review_count = ?, updated_at = ? WHERE id = ?"
  ).bind(stats?.avg ?? body.rating, stats?.cnt ?? 1, now, listingId).run();

  return c.json({ id: reviewId, rating: body.rating, created_at: now }, 201);
});

// Get reviews for a listing
app.get("/v1/marketplace/:id/reviews", async (c) => {
  const limit = Math.min(parseInt(new URL(c.req.url).searchParams.get("limit") ?? "20", 10), 100);
  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, user_id, rating, comment, created_at FROM marketplace_reviews WHERE listing_id = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(c.req.param("id"), limit).all();
  return c.json({ data: results });
});

// Fork a published SpaceType into the caller's workspace
app.post("/v1/marketplace/:id/fork", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const listing = await c.env.PLATFORM_DB.prepare(
    "SELECT id, name, description, config_schema, space_type_id FROM space_type_listings WHERE id = ? AND status = 'published'"
  ).bind(c.req.param("id")).first<{ id: string; name: string; description: string; config_schema: string; space_type_id: string }>();
  if (!listing) return c.json({ error_code: "not_found", message: "Listing not found" }, 404);

  const newSpaceTypeId = crypto.randomUUID();
  const now = new Date().toISOString();
  const forkedName = `${listing.name} (fork)`;
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO space_types (id, tenant_id, name, description, config, forked_from, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).bind(newSpaceTypeId, tenantId, forkedName, listing.description, listing.config_schema, listing.space_type_id, now, now).run();

  // Increment install count on the listing
  await c.env.PLATFORM_DB.prepare(
    "UPDATE space_type_listings SET install_count = install_count + 1, updated_at = ? WHERE id = ?"
  ).bind(now, listing.id).run();

  return c.json({ space_type_id: newSpaceTypeId, name: forkedName, created_at: now }, 201);
});

// Stub: embed text using LLM gateway (returns zero vector if not available)
async function embedText(text: string, env: Env): Promise<number[]> {
  try {
    const resp = await fetch(`${(env as unknown as Record<string, string>)["LLM_GATEWAY_URL"] ?? "http://localhost:8788"}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.PLATFORM_SECRET}` },
      body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
    });
    if (!resp.ok) return new Array(1536).fill(0) as number[];
    const data = await resp.json<{ data: { embedding: number[] }[] }>();
    return data.data[0]?.embedding ?? (new Array(1536).fill(0) as number[]);
  } catch {
    return new Array(1536).fill(0) as number[];
  }
}

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
