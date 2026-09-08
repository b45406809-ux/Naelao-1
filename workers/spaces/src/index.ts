import { Hono } from "hono";
import { SpaceDO, computeMicroAppDoName } from "./do/SpaceDO";
import { MicroAppDO } from "./do/MicroAppDO";
import { InstallGadgetParams, GadgetTier } from "@avos/types";

export { SpaceDO, MicroAppDO };

export interface Bindings {
  SPACES_DO: DurableObjectNamespace;
  MICRO_APP_DO: DurableObjectNamespace;
  DB: D1Database;
  GATEKEEPER_SECRET?: string;
}

const app = new Hono<{ Bindings: Bindings }>();

// Helper to get SpaceDO stub
function getSpaceDO(c: { env: Bindings }, spaceId: string) {
  const id = c.env.SPACES_DO.idFromName(spaceId);
  return c.env.SPACES_DO.get(id);
}

// GET /spaces/:spaceId/gadgets - Lists project and personal gadgets
app.get("/spaces/:spaceId/gadgets", async (c) => {
  const spaceId = c.req.param("spaceId");
  const projectId = c.req.query("projectId") || null;
  const userId = c.req.query("userId") || null;
  const tierParam = c.req.query("tier");
  const rosterMode = c.req.query("roster") === "true";

  const spaceStub = getSpaceDO(c, spaceId);

  if (rosterMode) {
    const res = await spaceStub.fetch("http://space-do/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spaceId, projectId, userId }),
    });
    const data = await res.json();
    return c.json(data, res.status as any);
  }

  const queryParams = new URLSearchParams();
  queryParams.set("spaceId", spaceId);
  if (projectId !== null) queryParams.set("projectId", projectId);
  if (userId !== null) queryParams.set("userId", userId);
  if (tierParam) queryParams.set("tier", tierParam);

  const res = await spaceStub.fetch(`http://space-do/list?${queryParams.toString()}`, {
    method: "GET",
  });
  const data = await res.json();
  return c.json(data, res.status as any);
});

// POST /spaces/:spaceId/gadgets - Installs a new gadget (Admin-gated)
app.post("/spaces/:spaceId/gadgets", async (c) => {
  const spaceId = c.req.param("spaceId");
  const body = (await c.req.json()) as Partial<InstallGadgetParams>;

  if (!body.manifestId || !body.slug || !body.tier) {
    return c.json({ error: "Missing required fields: manifestId, slug, tier" }, 400);
  }

  const payload: InstallGadgetParams = {
    spaceId,
    manifestId: body.manifestId,
    slug: body.slug,
    tier: body.tier as GadgetTier,
    projectId: body.projectId ?? null,
    ownerUserId: body.ownerUserId ?? null,
    configJson: typeof body.configJson === "string" ? body.configJson : JSON.stringify(body.configJson || {}),
  };

  const spaceStub = getSpaceDO(c, spaceId);
  const res = await spaceStub.fetch("http://space-do/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  return c.json(data, res.status as any);
});

// Forwarding / proxying to MicroAppDO
app.all("/spaces/:spaceId/micro-apps/:slug/*", async (c) => {
  const spaceId = c.req.param("spaceId");
  const slug = c.req.param("slug");
  const tier = Number(c.req.query("tier") || 2) as GadgetTier;
  const projectId = c.req.query("projectId") || null;
  const userId = c.req.query("userId") || null;

  try {
    const doName = computeMicroAppDoName(tier, spaceId, projectId, userId, slug);
    const doId = c.env.MICRO_APP_DO.idFromName(doName);
    const microAppStub = c.env.MICRO_APP_DO.get(doId);

    const subPath = c.req.path.replace(`/spaces/${spaceId}/micro-apps/${slug}`, "");
    const url = new URL(`http://micro-app-do${subPath || "/"}`);
    for (const [k, v] of Object.entries(c.req.queries())) {
      if (v) {
        for (const item of v) {
          url.searchParams.append(k, item);
        }
      }
    }

    const headers = new Headers(c.req.raw.headers);
    if (c.env.GATEKEEPER_SECRET) {
      headers.set("X-Gatekeeper-Token", c.env.GATEKEEPER_SECRET);
    }

    const forwardReq = new Request(url.toString(), {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
      duplex: "half",
    } as RequestInit);

    return await microAppStub.fetch(forwardReq);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

export default app;
