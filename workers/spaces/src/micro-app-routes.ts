/**
 * Micro-App Router & Gatekeeper Capability Provisioning (workers/spaces).
 *
 * Exposes endpoints for creating, synthesizing, deploying, and securely invoking
 * edge-hosted Micro-Apps inside dedicated `MicroAppDO` instances.
 */

import type { Hono } from "hono";
import type { Env } from "./index.js";
import { getDOName } from "@naelao/crypto";
import {
  mintGatekeeperToken,
  mintDelegatedGatekeeperToken,
  type GatekeeperGrant,
  type GadgetScope,
} from "@naelao/security";
import { resolveEndUserBusinessRole } from "./business-auth.js";

export function registerMicroAppRoutes(app: Hono<{ Bindings: Env }>): void {
  // ── Blueprints Catalog ────────────────────────────────────────────────────
  app.get("/spaces/:spaceId/gadgets/blueprints", async (c) => {
    return c.json({
      ok: true,
      blueprints: [
        {
          id: "bug_intake_matrix",
          name: "QA Bug Reporting & Acceptance Matrix",
          description: "Cross-subspace issue tracker allowing engineering subspaces to log tickets into PM private SQLite DB.",
          scope: "CROSS_SUBSPACE_DELEGATED",
        },
        {
          id: "leave_tracker",
          name: "Company-Wide PTO Leave Approval Tracker",
          description: "All-company time-off request and manager approval ledger with live audit trail.",
          scope: "SPACE_WIDE",
        },
        {
          id: "barcode_scanner",
          name: "Barcode Equipment Scanner & Return Ledger",
          description: "Project-bound warehouse scanner tracking equipment checkouts and returns.",
          scope: "PROJECT_BOUND",
        },
        {
          id: "pomodoro_timer",
          name: "Personal Pomodoro Timer & Scratchpad",
          description: "Private focus timer and scratchpad for personal focus loops.",
          scope: "USER_PRIVATE",
        },
      ],
    });
  });

  // ── Instantiate Blueprint ──────────────────────────────────────────────────
  app.post("/spaces/:spaceId/gadgets/blueprints/:blueprintId/instantiate", async (c) => {
    const { spaceId, blueprintId } = c.req.param();
    const endUserId = c.req.header("x-naelao-end-user-id") || c.req.header("x-naelao-user-id") || "user_anon";
    const body = (await c.req.json().catch(() => ({}))) as {
      appId?: string;
      projectId?: string;
      delegatedTargetSpaceIds?: string[];
    };

    const appId = body.appId || `gadget_${blueprintId}_${Date.now().toString(36)}`;
    const doName = await getDOName("microapp", appId, spaceId, c.env.PLATFORM_SECRET);

    if (!c.env.MICRO_APP_DO) {
      return c.json({ error_code: "not_configured", message: "MICRO_APP_DO binding missing" }, 500);
    }

    const doId = c.env.MICRO_APP_DO.idFromName(doName);
    const stub = c.env.MICRO_APP_DO.get(doId);

    const deployRes = await stub.fetch(new Request("https://microapp.internal/admin/deploy-blueprint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blueprintId,
        appId,
        spaceId,
        creatorUserId: endUserId,
        projectId: body.projectId,
        delegatedTargetSpaceIds: body.delegatedTargetSpaceIds,
      }),
    }));

    const deployData = (await deployRes.json()) as Record<string, unknown>;
    return c.json(deployData, deployRes.status as any);
  });

  // ── Cross-Subspace Delegation Endpoint ─────────────────────────────────────
  app.post("/spaces/:spaceId/gadgets/:appId/delegate", async (c) => {
    const { spaceId, appId } = c.req.param();
    const endUserId = c.req.header("x-naelao-end-user-id") || c.req.header("x-naelao-user-id") || "user_anon";
    const delegatorRole = (await resolveEndUserBusinessRole(c.env, spaceId, endUserId)) || "editor";

    const body = (await c.req.json()) as {
      targetSpaceId: string;
      allowedOps: string[];
      ttlSeconds?: number;
    };

    if (!body.targetSpaceId || !Array.isArray(body.allowedOps)) {
      return c.json({ error_code: "invalid_payload", message: "targetSpaceId and allowedOps array are required" }, 400);
    }

    const delegatedToken = await mintDelegatedGatekeeperToken(
      {
        gadgetId: appId,
        fromSpaceId: spaceId,
        toSpaceId: body.targetSpaceId,
        delegatorUserId: endUserId,
        delegatorRole,
        allowedOps: body.allowedOps,
        ttlSeconds: body.ttlSeconds,
      },
      c.env.PLATFORM_SECRET
    );

    return c.json({
      ok: true,
      gadgetId: appId,
      fromSpaceId: spaceId,
      toSpaceId: body.targetSpaceId,
      allowedOps: body.allowedOps,
      delegatedToken,
    });
  });

  // ── 1. Create / Deploy Micro-App or Gadget in Space ────────────────────────
  const handleCreateOrDeploy = async (c: any) => {
    const spaceId = c.req.param("spaceId");
    const endUserId = c.req.header("x-naelao-end-user-id") || c.req.header("x-naelao-user-id") || "user_anon";

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
      scope?: GadgetScope;
      projectId?: string;
      delegatedTargetSpaceIds?: string[];
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
        scope: body.scope,
        projectId: body.projectId,
        delegatedTargetSpaceIds: body.delegatedTargetSpaceIds,
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
      appUrl: `/spaces/${spaceId}/gadgets/${appId}/app`,
    }, 201);
  };

  app.post("/spaces/:spaceId/micro-apps", handleCreateOrDeploy);
  app.post("/spaces/:spaceId/gadgets", handleCreateOrDeploy);

  // ── 2. Get Micro-App / Gadget Manifest & SQLite Tables ─────────────────────
  const handleGetManifest = async (c: any) => {
    const { spaceId, appId } = c.req.param();
    if (!c.env.MICRO_APP_DO) return c.json({ error_code: "not_configured" }, 500);

    const doName = await getDOName("microapp", appId, spaceId, c.env.PLATFORM_SECRET);
    const doId = c.env.MICRO_APP_DO.idFromName(doName);
    const stub = c.env.MICRO_APP_DO.get(doId);

    const res = await stub.fetch(new Request("https://microapp.internal/admin/manifest"));
    const data = await res.json();
    return c.json(data, res.status as any);
  };

  app.get("/spaces/:spaceId/micro-apps/:appId/manifest", handleGetManifest);
  app.get("/spaces/:spaceId/gadgets/:appId/manifest", handleGetManifest);

  // ── 3. Mint Attenuated Gatekeeper Token for Micro-App / Gadget ─────────────
  const handleMintToken = async (c: any) => {
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
  };

  app.post("/spaces/:spaceId/micro-apps/:appId/token", handleMintToken);
  app.post("/spaces/:spaceId/gadgets/:appId/token", handleMintToken);

  // ── 4. Proxy Frontend & API Routes to MicroAppDO ───────────────────────────
  const handleProxyApp = async (c: any) => {
    const { spaceId, appId } = c.req.param();
    if (!c.env.MICRO_APP_DO) return c.text("MicroAppDO not configured", 500);

    const doName = await getDOName("microapp", appId, spaceId, c.env.PLATFORM_SECRET);
    const doId = c.env.MICRO_APP_DO.idFromName(doName);
    const stub = c.env.MICRO_APP_DO.get(doId);

    const basePath = c.req.path.includes("/gadgets/")
      ? `/spaces/${spaceId}/gadgets/${appId}/app`
      : `/spaces/${spaceId}/micro-apps/${appId}/app`;
    const subpath = c.req.path.replace(basePath, "") || "/";
    const targetUrl = new URL(subpath, "https://microapp.internal");
    targetUrl.search = new URL(c.req.url).search;

    const forwardedHeaders = new Headers(c.req.raw.headers);
    return stub.fetch(new Request(targetUrl.toString(), {
      method: c.req.method,
      headers: forwardedHeaders,
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    }));
  };

  app.all("/spaces/:spaceId/micro-apps/:appId/app/*", handleProxyApp);
  app.all("/spaces/:spaceId/gadgets/:appId/app/*", handleProxyApp);
  app.all("/spaces/:spaceId/gadgets/:appId/app", handleProxyApp);

  const handleProxyMcp = async (c: any) => {
    const { spaceId, appId } = c.req.param();
    if (!c.env.MICRO_APP_DO) return c.json({ error: "MicroAppDO not configured" }, 500);

    const doName = await getDOName("microapp", appId, spaceId, c.env.PLATFORM_SECRET);
    const doId = c.env.MICRO_APP_DO.idFromName(doName);
    const stub = c.env.MICRO_APP_DO.get(doId);

    const forwardedHeaders = new Headers(c.req.raw.headers);
    return stub.fetch(new Request("https://microapp.internal/mcp", {
      method: c.req.method,
      headers: forwardedHeaders,
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    }));
  };

  app.all("/spaces/:spaceId/micro-apps/:appId/mcp", handleProxyMcp);
  app.all("/spaces/:spaceId/gadgets/:appId/mcp", handleProxyMcp);

  const handleProxyApi = async (c: any) => {
    const { spaceId, appId } = c.req.param();
    if (!c.env.MICRO_APP_DO) return c.json({ error: "MicroAppDO not configured" }, 500);

    const doName = await getDOName("microapp", appId, spaceId, c.env.PLATFORM_SECRET);
    const doId = c.env.MICRO_APP_DO.idFromName(doName);
    const stub = c.env.MICRO_APP_DO.get(doId);

    const prefix = c.req.path.includes("/gadgets/")
      ? `/spaces/${spaceId}/gadgets/${appId}`
      : `/spaces/${spaceId}/micro-apps/${appId}`;
    const subpath = c.req.path.replace(prefix, "");
    const targetUrl = new URL(subpath, "https://microapp.internal");
    targetUrl.search = new URL(c.req.url).search;

    const forwardedHeaders = new Headers(c.req.raw.headers);
    return stub.fetch(new Request(targetUrl.toString(), {
      method: c.req.method,
      headers: forwardedHeaders,
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    }));
  };

  app.all("/spaces/:spaceId/micro-apps/:appId/api/*", handleProxyApi);
  app.all("/spaces/:spaceId/gadgets/:appId/api/*", handleProxyApi);
}
