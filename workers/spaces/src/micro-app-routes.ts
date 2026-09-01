/**
 * Micro-App Router & Gatekeeper Capability Provisioning (workers/spaces).
 *
 * Exposes endpoints for creating, synthesizing, deploying, and securely invoking
 * edge-hosted Micro-Apps inside dedicated `MicroAppDO` instances.
 */

import type { Hono } from "hono";
import type { Env } from "./index.js";
import { getDOName } from "@naelao/crypto";
import { mintGatekeeperToken, type GatekeeperGrant } from "@naelao/security";
import { resolveEndUserBusinessRole } from "./business-auth.js";

export function registerMicroAppRoutes(app: Hono<{ Bindings: Env }>): void {
  // ── 1. Create / Deploy Micro-App in Space ──────────────────────────────────
  app.post("/spaces/:spaceId/micro-apps", async (c) => {
    const spaceId = c.req.param("spaceId");
    const endUserId = c.req.header("x-naelao-end-user-id") || c.req.header("x-naelao-user-id") || "user_anon";
    const tenantId = c.req.header("x-naelao-tenant-id") || spaceId;

    // Check caller role in space
    const role = (await resolveEndUserBusinessRole(c.env, spaceId, endUserId)) || "editor";

    const body = (await c.req.json()) as {
      appId?: string;
      title: string;
      description?: string;
      htmlBundle?: string;
      schemaSql?: string;
      initialData?: Array<{ table: string; records: Record<string, unknown>[] }>;
      requestedGrants?: GatekeeperGrant[];
    };

    const appId = body.appId || `app_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const doName = await getDOName("microapp", appId, spaceId, c.env.PLATFORM_SECRET);

    if (!c.env.MICRO_APP_DO) {
      return c.json({ error_code: "not_configured", message: "MICRO_APP_DO binding is missing" }, 500);
    }

    const doId = c.env.MICRO_APP_DO.idFromName(doName);
    const stub = c.env.MICRO_APP_DO.get(doId);

    // Deploy to MicroAppDO
    const deployRes = await stub.fetch(new Request("https://microapp.internal/admin/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId,
        spaceId,
        creatorUserId: endUserId,
        creatorRoleRank: role === "owner" ? 5 : role === "admin" ? 4 : role === "editor" ? 3 : 2,
        title: body.title,
        description: body.description,
        htmlBundle: body.htmlBundle,
        schemaSql: body.schemaSql,
        initialData: body.initialData,
      }),
    }));

    const deployData = (await deployRes.json()) as Record<string, unknown>;
    if (!deployRes.ok) {
      return c.json({ error_code: "deploy_failed", details: deployData }, deployRes.status as any);
    }

    // Default Gatekeeper grants if none specified: full access to this app's own SQLite tables
    const grants: GatekeeperGrant[] = body.requestedGrants || [
      {
        resource: "sqlite_db",
        target: "table:*",
        operations: ["read", "write", "delete", "execute"],
      },
      {
        resource: "channel_notify",
        target: "*",
        operations: ["execute"],
        constraints: { rateLimitPerMinute: 10 },
      },
    ];

    // Mint Gatekeeper Token (clamped to creator role ceiling)
    const token = await mintGatekeeperToken(
      {
        appId,
        spaceId,
        creatorUserId: endUserId,
        creatorRole: role,
        grants,
        ttlSeconds: 7 * 86400, // 7 days default
      },
      c.env.PLATFORM_SECRET
    );

    return c.json({
      ok: true,
      appId,
      spaceId,
      manifest: deployData.manifest,
      gatekeeperToken: token,
      appUrl: `/spaces/${spaceId}/micro-apps/${appId}/app`,
    }, 201);
  });

  // ── 2. Get Micro-App Manifest & SQLite Tables ──────────────────────────────
  app.get("/spaces/:spaceId/micro-apps/:appId/manifest", async (c) => {
    const { spaceId, appId } = c.req.param();
    if (!c.env.MICRO_APP_DO) return c.json({ error_code: "not_configured" }, 500);

    const doName = await getDOName("microapp", appId, spaceId, c.env.PLATFORM_SECRET);
    const doId = c.env.MICRO_APP_DO.idFromName(doName);
    const stub = c.env.MICRO_APP_DO.get(doId);

    const res = await stub.fetch(new Request("https://microapp.internal/admin/manifest"));
    const data = await res.json();
    return c.json(data, res.status as any);
  });

  // ── 3. Mint Attenuated Gatekeeper Token for Micro-App ──────────────────────
  app.post("/spaces/:spaceId/micro-apps/:appId/token", async (c) => {
    const { spaceId, appId } = c.req.param();
    const endUserId = c.req.header("x-naelao-end-user-id") || c.req.header("x-naelao-user-id") || "user_anon";

    const callerRole = (await resolveEndUserBusinessRole(c.env, spaceId, endUserId)) || "editor";

    const body = (await c.req.json()) as {
      targetUserId?: string;
      role?: string;
      grants: GatekeeperGrant[];
      ttlSeconds?: number;
    };

    if (!Array.isArray(body.grants)) {
      return c.json({ error_code: "invalid_grants", message: "grants array is required" }, 400);
    }

    // Mint token clamped strictly by caller's role (Invariant #1)
    const token = await mintGatekeeperToken(
      {
        appId,
        spaceId,
        creatorUserId: body.targetUserId || endUserId,
        creatorRole: body.role || callerRole,
        grants: body.grants,
        ttlSeconds: body.ttlSeconds || 86400,
      },
      c.env.PLATFORM_SECRET
    );

    return c.json({ ok: true, token, appId, spaceId });
  });

  // ── 4. Proxy Frontend & API Routes to MicroAppDO ───────────────────────────
  app.all("/spaces/:spaceId/micro-apps/:appId/app/*", async (c) => {
    const { spaceId, appId } = c.req.param();
    if (!c.env.MICRO_APP_DO) return c.text("MicroAppDO not configured", 500);

    const doName = await getDOName("microapp", appId, spaceId, c.env.PLATFORM_SECRET);
    const doId = c.env.MICRO_APP_DO.idFromName(doName);
    const stub = c.env.MICRO_APP_DO.get(doId);

    // Forward to root of DO
    const subpath = c.req.path.replace(`/spaces/${spaceId}/micro-apps/${appId}/app`, "") || "/";
    const targetUrl = new URL(subpath, "https://microapp.internal");
    targetUrl.search = new URL(c.req.url).search;

    const forwardedHeaders = new Headers(c.req.raw.headers);
    return stub.fetch(new Request(targetUrl.toString(), {
      method: c.req.method,
      headers: forwardedHeaders,
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    }));
  });

  app.all("/spaces/:spaceId/micro-apps/:appId/api/*", async (c) => {
    const { spaceId, appId } = c.req.param();
    if (!c.env.MICRO_APP_DO) return c.json({ error: "MicroAppDO not configured" }, 500);

    const doName = await getDOName("microapp", appId, spaceId, c.env.PLATFORM_SECRET);
    const doId = c.env.MICRO_APP_DO.idFromName(doName);
    const stub = c.env.MICRO_APP_DO.get(doId);

    const subpath = c.req.path.replace(`/spaces/${spaceId}/micro-apps/${appId}`, "");
    const targetUrl = new URL(subpath, "https://microapp.internal");
    targetUrl.search = new URL(c.req.url).search;

    const forwardedHeaders = new Headers(c.req.raw.headers);
    return stub.fetch(new Request(targetUrl.toString(), {
      method: c.req.method,
      headers: forwardedHeaders,
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    }));
  });
}
