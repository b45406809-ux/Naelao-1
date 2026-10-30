// Naelao team administration API: private team-template access and scoped team API keys.
//
// registerBuilderRoutes(app) is called once from index.ts and adds routes onto the SAME Hono app
// instance (matching this file's existing convention of one flat app — cf-saas.ts is pure logic
// with no routes; this is the first split-out file that DOES register routes, so it takes `app`
// rather than mounting a sub-app, to avoid a circular import with index.ts's own Env type: this
// file declares its own minimal structural Env shape instead of importing index.ts's Env).
//
// AUTH: routes accept a router-authenticated Naelao team session or a scoped team API key.
// The signed router tenant assertion is verified here and the team tenant is enforced.
// Note: wiring naelao-router to actually forward external `Authorization: Bearer nbk_...` calls
// through to this worker (today the router only forwards already-JWT-authenticated sessions) is a
// separate, tracked router-level follow-up — out of this file's scope. The Dashboard UI's own use
// of these routes works today via the x-naelao-tenant-id path.

import type { Context, Hono } from "hono";
import { getDOName } from "@naelao/crypto";
import { verifyInternalToken } from "@naelao/http";
import { FOUNDRY_SPACE_TEMPLATE } from "@naelao/agent-sdk";

/** The minimal env shape this file needs — kept local (not imported from index.ts's Env) so
 *  index.ts -> builder-routes.ts -> index.ts never forms a circular import. index.ts's real Env
 *  is a structural superset and satisfies this at the call site. */
export interface BuilderRoutesEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  BUILDER_ACCOUNT_DO: DurableObjectNamespace;
  /** Naelao team tenant. Empty means fail closed. */
  NAELAO_DASHBOARD_TENANT_ID?: string;
}

interface ResolvedBuilder { tenantId: string; scopes: string[] }

function builderScopeFor(path: string, method: string): string {
  if (path === "/builder/api-keys" && method === "GET") return "spaces:read";
  if (path === "/builder/api-keys" || /^\/builder\/api-keys\//.test(path)) return "spaces:write";
  if (path === "/builder/templates" || /^\/builder\/templates\//.test(path)) return "templates:read";
  return method === "GET" ? "spaces:read" : "spaces:write";
}

function hasBuilderScope(auth: ResolvedBuilder, required: string): boolean {
  if (auth.scopes.includes("*")) return true;
  if (auth.scopes.includes(required)) return true;
  return required === "spaces:read" && auth.scopes.includes("spaces:write");
}

async function builderAuthFor(env: BuilderRoutesEnv, context: Context<any>): Promise<ResolvedBuilder | null> {
  return (context.get("builderAuth") as ResolvedBuilder | undefined) ?? resolveBuilderAuth(env, context.req.raw.headers);
}

async function builderAccountDoStubFor(env: BuilderRoutesEnv, tenantId: string) {
  const doId = env.BUILDER_ACCOUNT_DO.idFromName(
    await getDOName("builder", tenantId, tenantId, env.PLATFORM_SECRET)
  );
  return env.BUILDER_ACCOUNT_DO.get(doId);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Resolve the calling builder's tenant + scopes from either auth path. Null = unauthenticated. */
async function resolveBuilderAuth(
  env: BuilderRoutesEnv,
  headers: { get(name: string): string | null }
): Promise<ResolvedBuilder | null> {
  const headerTenant = headers.get("x-naelao-tenant-id");
  if (headerTenant) {
    // The tenant header is a router assertion, not an identity credential by itself.
    // Verify the router's signature so direct Worker access cannot choose another tenant.
    if (!await verifyInternalToken(headers.get("x-naelao-internal-token") ?? undefined, headerTenant, env.PLATFORM_SECRET)) return null;
    if (headers.get("x-naelao-role") === "team_api_key") {
      const scopes = (headers.get("x-naelao-scopes") ?? "").split(",").filter(Boolean);
      if (scopes.some(scope => !/^[a-z][a-z0-9:_-]{0,63}$/.test(scope))) return null;
      return { tenantId: headerTenant, scopes };
    }
    return { tenantId: headerTenant, scopes: ["*"] };
  }

  const authHeader = headers.get("authorization") ?? "";
  const match = /^Bearer\s+(nbk_\S+)$/.exec(authHeader);
  if (!match) return null;
  const rawKey = match[1]!;
  const keyHash = await sha256Hex(rawKey);

  const indexRow = await env.PLATFORM_DB.prepare(
    "SELECT tenant_id FROM builder_api_key_index WHERE key_hash = ?"
  ).bind(keyHash).first<{ tenant_id: string }>();
  if (!indexRow) return null;

  const stub = await builderAccountDoStubFor(env, indexRow.tenant_id);
  const verifyRes = await stub.fetch(
    new Request("http://do/api-keys/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: rawKey }),
    })
  );
  const verified = await verifyRes.json<{ valid: boolean; scopes?: string[] }>();
  if (!verified.valid) return null;
  return { tenantId: indexRow.tenant_id, scopes: verified.scopes ?? [] };
}

// Hono's Context typing is invariant on Bindings (not just structural), so a narrower
// BuilderRoutesEnv can't be accepted where the caller's Hono<{Bindings: Env}> is expected without
// either importing index.ts's Env here (circular) or widening this parameter. `any` is the
// pragmatic choice for a route-registration split like this; each handler still recovers a
// properly-typed `env` via the `c.env as BuilderRoutesEnv` cast below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerBuilderRoutes(app: Hono<any>): void {
  app.use("/builder/*", async (c, next) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    // Naelao is the only platform builder. Fail closed when the internal team tenant is not
    // configured; otherwise any authenticated tenant or legacy builder API key could use this
    // administration API as a product-building surface.
    if (!env.NAELAO_DASHBOARD_TENANT_ID || auth.tenantId !== env.NAELAO_DASHBOARD_TENANT_ID) {
      return c.json({ error_code: "forbidden", message: "Naelao team access required" }, 403);
    }
    // Router sessions carry a role derived from the verified JWT (client-supplied role headers
    // are stripped by the router). Keep dashboard administration to team owners/admins; scoped
    // API keys remain usable for automation after an authorized admin creates them.
    if (c.req.header("x-naelao-tenant-id") && !["owner", "admin", "team_api_key"].includes(c.req.header("x-naelao-role") ?? "")) {
      return c.json({ error_code: "forbidden", message: "Naelao team administrator access required" }, 403);
    }
    const required = builderScopeFor(c.req.path, c.req.method);
    if (!hasBuilderScope(auth, required)) return c.json({ error_code: "insufficient_scope", required_scope: required }, 403);
    c.set("builderAuth", auth);
    return next();
  });
  // Foundry is distributed only inside the Naelao team tenant. Returning the portable blueprint
  // through this route keeps it out of the public marketplace/catalogue while allowing the team
  // dashboard and team-scoped API keys to inspect the exact dogfood artifact.
  app.get("/builder/templates", async (c) => {
    const auth = await builderAuthFor(c.env as BuilderRoutesEnv, c);
    if (!auth || auth.tenantId !== (c.env as BuilderRoutesEnv).NAELAO_DASHBOARD_TENANT_ID) return c.json({ error_code: "forbidden" }, 403);
    return c.json({ data: [{ visibility: "team_private", template: FOUNDRY_SPACE_TEMPLATE }] });
  });
  // ── /builder/api-keys — consolidates onto Phase 1's BuilderAccountDO ─────────────────────────
  app.post("/builder/api-keys", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);

    const body = await c.req.json<{ name?: unknown; scopes?: unknown; expires_in_days?: unknown }>().catch(() => null);
    if (!body || !Array.isArray(body.scopes)) return c.json({ error_code: "invalid_api_key_configuration" }, 400);
    if (!auth.scopes.includes("*") && body.scopes.some(scope => typeof scope !== "string" || !hasBuilderScope(auth, scope))) {
      return c.json({ error_code: "api_key_scope_escalation_denied" }, 403);
    }
    const stub = await builderAccountDoStubFor(env, auth.tenantId);
    const doRes = await stub.fetch(new Request("http://do/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    if (!doRes.ok) return new Response(doRes.body, { status: doRes.status, headers: { "content-type": "application/json" } });

    const created = await doRes.json<{ id: string; key: string; key_hash: string; name: string; key_prefix: string; scopes: string[]; last_used_at: string | null; expires_at: string | null; created_at: string }>();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO builder_api_key_index (key_hash, tenant_id, key_id) VALUES (?, ?, ?)"
    ).bind(created.key_hash, auth.tenantId, created.id).run();

    // key_hash is worker-internal only (see BuilderAccountDO.ts's comment) — never forward it.
    const { key_hash: _keyHash, ...clientSafe } = created;
    return c.json(clientSafe, 201);
  });

  app.get("/builder/api-keys", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const stub = await builderAccountDoStubFor(env, auth.tenantId);
    const doRes = await stub.fetch(new Request("http://do/api-keys"));
    return new Response(doRes.body, { status: doRes.status, headers: { "content-type": "application/json" } });
  });

  app.delete("/builder/api-keys/:id", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const stub = await builderAccountDoStubFor(env, auth.tenantId);
    const doRes = await stub.fetch(new Request(`http://do/api-keys/${encodeURIComponent(c.req.param("id"))}`, { method: "DELETE" }));
    return new Response(doRes.body, { status: doRes.status });
  });



}
