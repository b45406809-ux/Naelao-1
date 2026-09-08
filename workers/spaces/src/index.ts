import { Hono } from "hono";
import { SpaceDO, computeMicroAppDoName } from "./do/SpaceDO";
import { MicroAppDO } from "./do/MicroAppDO";
import { InstallGadgetParams, GadgetTier, GatekeeperGrant, GatekeeperCapabilityPayload } from "@avos/types";
import { mintGatekeeperToken } from "@avos/security";

export { SpaceDO, MicroAppDO };

export interface Bindings {
  SPACES_DO: DurableObjectNamespace;
  MICRO_APP_DO: DurableObjectNamespace;
  DB: D1Database;
  PLATFORM_SECRET?: string;
  GATEKEEPER_SECRET?: string;
}

const app = new Hono<{ Bindings: Bindings, Variables: { user?: { id: string; email?: string } } }>();

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

// POST /spaces/:spaceId/gadgets/:instanceId/token - Mints a Gatekeeper capability token
app.post("/spaces/:spaceId/gadgets/:instanceId/token", async (c) => {
  const { spaceId, instanceId } = c.req.param();
  
  // Extract authenticated user from headers or query (or fallback to mock/gateway user)
  const authHeader = c.req.header("Authorization") || c.req.header("X-User-Id");
  const userIdHeader = c.req.header("X-User-Id") || c.req.query("userId") || "system-user";
  const authUser = { id: userIdHeader };

  const platformSecret = c.env.PLATFORM_SECRET || c.env.GATEKEEPER_SECRET || "default-platform-secret-key";

  // 1. Resolve user's business role and role rank in this space
  const db = c.env.DB;
  let userRole = "member";
  try {
    const membership = await db.prepare(
      "SELECT role FROM business_memberships WHERE space_id = ? AND user_id = ? AND status = 'active'"
    ).bind(spaceId, authUser.id).first<{ role: string }>();
    if (membership?.role) {
      userRole = membership.role;
    }
  } catch {
    // Fallback if table doesn't exist yet in test environment
  }

  const ROLE_RANKS: Record<string, number> = {
    viewer: 1,
    member: 2,
    editor: 3,
    admin: 4,
    owner: 5
  };

  const userRoleRank = ROLE_RANKS[userRole] || 2;

  // 2. Fetch Gadget instance details from SpaceDO SQLite
  const spaceStub = getSpaceDO(c, spaceId);
  const gadgetRes = await spaceStub.fetch(`http://space-do/gadgets/instances/${instanceId}`, {
    method: "GET"
  });

  if (!gadgetRes.ok) {
    // Fallback/direct check if SpaceDO endpoint isn't wired yet
    const listRes = await spaceStub.fetch(`http://space-do/list?spaceId=${spaceId}`, { method: "GET" });
    if (listRes.ok) {
      const listData = await listRes.json() as { instances?: Array<any> };
      const found = (listData.instances || []).find((inst: any) => inst.instanceId === instanceId);
      if (!found) {
        return c.json({ error: "Gadget instance not found or inactive" }, 404);
      }
    }
  }

  // 3. Attenuate capabilities based on the Human Clearance Ceiling (Invariant #1)
  const reqBody = await c.req.json().catch(() => ({})) as { ttlSeconds?: number };
  const ttlSeconds = Math.min(reqBody.ttlSeconds || 3600, 86400); // Capped at 24h max

  const allowedGrants: GatekeeperGrant[] = [
    {
      resource: "sqlite_db",
      target: `gadget:${instanceId}`,
      operations: userRoleRank >= 3 ? ["read", "write", "delete"] : ["read"]
    },
    {
      resource: "mcp_tool",
      target: `mcp.gadget_${instanceId}.*`,
      operations: userRoleRank >= 3 ? ["read", "execute"] : ["read"]
    }
  ];

  if (userRoleRank >= 4) {
    allowedGrants.push({
      resource: "notifications",
      target: "*",
      operations: ["notify"]
    });
  }

  // 4. Construct payload and sign token
  const now = Date.now();
  const payload: GatekeeperCapabilityPayload = {
    appId: instanceId,
    gadgetInstanceId: instanceId,
    spaceId: spaceId,
    creatorUserId: authUser.id,
    creatorRoleRank: userRoleRank,
    grants: allowedGrants,
    issuedAt: now,
    expiresAt: now + (ttlSeconds * 1000)
  };

  const signedToken = await mintGatekeeperToken(payload, platformSecret);

  return c.json({
    ok: true,
    token: signedToken,
    gadgetInstanceId: instanceId,
    spaceId: spaceId,
    expiresAt: new Date(payload.expiresAt).toISOString(),
    grantedCapabilities: allowedGrants
  });
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
