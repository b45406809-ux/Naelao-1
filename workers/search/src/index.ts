// G-BE03: Platform-wide Semantic Search Worker — hybrid dense + sparse retrieval
import { Hono } from "hono";
import { errorResponse, parseBoundedInteger, requestId } from "@naelao/http";
import { embedText, bm25Score, reciprocalRankFusion } from "@naelao/rag";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SPACETYPES_VECTORS: VectorizeIndex;
  AI: Ai;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

interface SpaceTypeRow {
  id: string;
  name: string;
  description: string;
  category: string;
  is_public: number;
}

// GET /search/spacetypes?q=...&limit=20 — hybrid semantic + keyword search across SpaceTypes
app.get("/search/spacetypes", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const url = new URL(c.req.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, 1, 100);
  const category = url.searchParams.get("category") ?? "";

  if (!query) return c.json({ error_code: "bad_request", message: "q parameter required" }, 400);

  // Dense retrieval from Vectorize
  const queryEmbed = await embedText(c.env.AI, query);
  const vectorFilter: VectorizeVectorMetadataFilter | undefined = category
    ? { category: { $eq: category } }
    : undefined;

  const queryOptions: VectorizeQueryOptions = {
    topK: limit * 2,
    returnMetadata: "all",
  };
  if (vectorFilter !== undefined) {
    queryOptions.filter = vectorFilter;
  }

  const denseResp = await c.env.SPACETYPES_VECTORS.query(queryEmbed.embedding, queryOptions);

  const denseResults = (denseResp.matches ?? []).map(m => ({
    id: m.id,
    score: m.score ?? 0,
    metadata: m.metadata ?? {},
  }));

  // Sparse BM25 over names and descriptions from D1
  const denseIds = denseResults.map(r => r.id);
  if (denseIds.length > 0) {
    const placeholders = denseIds.map(() => "?").join(",");
    const { results: dbResults } = await c.env.PLATFORM_DB.prepare(
      `SELECT id, name, description, category, is_public FROM space_types WHERE id IN (${placeholders}) AND (is_public = 1 OR tenant_id = ?)`
    ).bind(...denseIds, tenantId).all<SpaceTypeRow>();

    const sparseResults = bm25Score(
      query,
      dbResults.map(r => ({ id: r.id, content: `${r.name} ${r.description ?? ""}` })),
    );
    const fused = reciprocalRankFusion(
      denseResults.map(r => ({ id: r.id, score: r.score })),
      sparseResults,
    );

    const dbMap = new Map<string, SpaceTypeRow>(dbResults.map(r => [r.id, r]));
    const data = fused.slice(0, limit).flatMap(f => {
      const row = dbMap.get(f.id);
      if (row === undefined) return [];
      return [{ ...row, relevance_score: f.score }];
    });

    return c.json({ data, query, count: data.length });
  }

  return c.json({ data: [], query, count: 0 });
});

// POST /search/spacetypes/:id/index — index a SpaceType into Vectorize (internal)
app.post("/search/spacetypes/:id/index", async (c) => {
  const platformSecret = c.req.header("x-naelao-platform-secret") ?? "";
  if (!c.env.PLATFORM_SECRET || platformSecret !== c.env.PLATFORM_SECRET) {
    return c.json({ error_code: "forbidden", message: "Internal endpoint" }, 403);
  }

  const spaceTypeId = c.req.param("id");
  const spaceType = await c.env.PLATFORM_DB.prepare(
    "SELECT id, name, description, category, tenant_id FROM space_types WHERE id = ?"
  ).bind(spaceTypeId).first<{ id: string; name: string; description: string; category: string; tenant_id: string }>();

  if (!spaceType) return c.json({ error_code: "not_found", message: "SpaceType not found" }, 404);

  const text = `${spaceType.name}: ${spaceType.description ?? ""}`;
  const embed = await embedText(c.env.AI, text);

  await c.env.SPACETYPES_VECTORS.upsert([{
    id: spaceType.id,
    values: embed.embedding,
    metadata: {
      name: spaceType.name,
      category: spaceType.category ?? "",
      tenant_id: spaceType.tenant_id,
    },
  }]);

  return c.json({ indexed: true, id: spaceTypeId });
});

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
