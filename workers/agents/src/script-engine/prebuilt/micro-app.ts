/**
 * micro-app (Prebuilt Script) — Prompt-to-Application Edge Engine.
 *
 * Enables agents to synthesize, compile, deploy, query, and govern isolated
 * micro-applications running on Cloudflare Workers with private in-DO SQLite
 * databases and Gatekeeper capability tokens.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";
import { mintGatekeeperToken, type GatekeeperGrant } from "@naelao/security";

function reqSpacesWorker(ctx: PrebuiltOpContext): Fetcher {
  if (!ctx.env.spacesWorker) {
    throw new Error("micro-app: SPACES_WORKER binding not configured");
  }
  return ctx.env.spacesWorker;
}

async function internalHeaders(ctx: PrebuiltOpContext, extra?: Record<string, string>): Promise<Record<string, string>> {
  return {
    "x-naelao-tenant-id": ctx.env.tenantId,
    "x-naelao-space-id": ctx.env.spaceId,
    "x-naelao-end-user-id": ctx.env.endUserId || "agent_system",
    "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
    ...extra,
  };
}

export const microApp: PrebuiltScript = {
  name: "micro-app",
  description: "Synthesize, deploy, query, and secure full-stack edge micro-apps with dedicated SQLite databases and Gatekeeper capability tokens.",
  domain: "workspace",
  requires_tier: 1,
  paramHints: {
    "microapp.synthesize": "{title: string, description?: string, prompt?: string, htmlBundle?: string, schemaSql?: string, initialData?: Array<{table: string, records: any[]}>, grants?: GatekeeperGrant[]}",
    "microapp.deploy": "{appId: string, title?: string, description?: string, htmlBundle?: string, schemaSql?: string, initialData?: Array<{table: string, records: any[]}>}",
    "microapp.query": "{appId: string, table?: string, gatekeeperToken: string, limit?: number, offset?: number}",
    "microapp.insert": "{appId: string, table?: string, record: Record<string, unknown>, gatekeeperToken: string}",
    "microapp.mint_token": "{appId: string, targetUserId?: string, targetRole?: string, grants: GatekeeperGrant[], ttlSeconds?: number}",
  },
  operations: {
    async "microapp.synthesize"(args, ctx) {
      const title = String(args["title"] ?? "").trim();
      if (!title) throw new Error("microapp.synthesize requires 'title'");

      const appId = String(args["appId"] || `app_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
      const description = String(args["description"] || "");
      const schemaSql = typeof args["schemaSql"] === "string" ? args["schemaSql"] : undefined;
      const htmlBundle = typeof args["htmlBundle"] === "string" ? args["htmlBundle"] : undefined;
      const initialData = Array.isArray(args["initialData"]) ? args["initialData"] : undefined;
      const grants = (Array.isArray(args["grants"]) ? args["grants"] : undefined) as GatekeeperGrant[] | undefined;

      const resp = await reqSpacesWorker(ctx).fetch(
        new Request(`http://spaces-worker/spaces/${ctx.env.spaceId}/micro-apps`, {
          method: "POST",
          headers: await internalHeaders(ctx, { "content-type": "application/json" }),
          body: JSON.stringify({
            appId,
            title,
            description,
            htmlBundle,
            schemaSql,
            initialData,
            requestedGrants: grants,
          }),
        })
      );

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`microapp.synthesize failed: ${resp.status}${body ? ` — ${body}` : ""}`);
      }
      return await resp.json();
    },

    async "microapp.deploy"(args, ctx) {
      const appId = String(args["appId"] ?? "").trim();
      if (!appId) throw new Error("microapp.deploy requires 'appId'");

      const resp = await reqSpacesWorker(ctx).fetch(
        new Request(`http://spaces-worker/spaces/${ctx.env.spaceId}/micro-apps/${appId}/api/admin/deploy`, {
          method: "POST",
          headers: await internalHeaders(ctx, { "content-type": "application/json" }),
          body: JSON.stringify({
            appId,
            spaceId: ctx.env.spaceId,
            title: args["title"],
            description: args["description"],
            htmlBundle: args["htmlBundle"],
            schemaSql: args["schemaSql"],
            initialData: args["initialData"],
          }),
        })
      );

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`microapp.deploy failed: ${resp.status}${body ? ` — ${body}` : ""}`);
      }
      return await resp.json();
    },

    async "microapp.query"(args, ctx) {
      const appId = String(args["appId"] ?? "").trim();
      const token = String(args["gatekeeperToken"] ?? "").trim();
      if (!appId) throw new Error("microapp.query requires 'appId'");
      if (!token) throw new Error("microapp.query requires 'gatekeeperToken'");

      const table = String(args["table"] || "app_records");
      const limit = Number(args["limit"] || 50);
      const offset = Number(args["offset"] || 0);

      const resp = await reqSpacesWorker(ctx).fetch(
        new Request(`http://spaces-worker/spaces/${ctx.env.spaceId}/micro-apps/${appId}/api/data/${table}?limit=${limit}&offset=${offset}`, {
          method: "GET",
          headers: await internalHeaders(ctx, {
            "x-gatekeeper-token": token,
          }),
        })
      );

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`microapp.query failed: ${resp.status}${body ? ` — ${body}` : ""}`);
      }
      return await resp.json();
    },

    async "microapp.insert"(args, ctx) {
      const appId = String(args["appId"] ?? "").trim();
      const token = String(args["gatekeeperToken"] ?? "").trim();
      const record = (args["record"] || {}) as Record<string, unknown>;

      if (!appId) throw new Error("microapp.insert requires 'appId'");
      if (!token) throw new Error("microapp.insert requires 'gatekeeperToken'");

      const table = String(args["table"] || "app_records");

      const resp = await reqSpacesWorker(ctx).fetch(
        new Request(`http://spaces-worker/spaces/${ctx.env.spaceId}/micro-apps/${appId}/api/data/${table}`, {
          method: "POST",
          headers: await internalHeaders(ctx, {
            "content-type": "application/json",
            "x-gatekeeper-token": token,
          }),
          body: JSON.stringify(record),
        })
      );

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`microapp.insert failed: ${resp.status}${body ? ` — ${body}` : ""}`);
      }
      return await resp.json();
    },

    async "microapp.mint_token"(args, ctx) {
      const appId = String(args["appId"] ?? "").trim();
      const grants = (Array.isArray(args["grants"]) ? args["grants"] : []) as GatekeeperGrant[];
      const role = String(args["targetRole"] || "editor");
      const ttlSeconds = Number(args["ttlSeconds"] || 86400);

      if (!appId) throw new Error("microapp.mint_token requires 'appId'");
      if (!ctx.env.platformSecret) throw new Error("microapp.mint_token: PLATFORM_SECRET missing");

      const token = await mintGatekeeperToken(
        {
          appId,
          spaceId: ctx.env.spaceId,
          creatorUserId: String(args["targetUserId"] || ctx.env.endUserId || "agent_system"),
          creatorRole: role,
          grants,
          ttlSeconds,
        },
        ctx.env.platformSecret
      );

      return { ok: true, token, appId, spaceId: ctx.env.spaceId };
    },
  },
};
