import { signJwt } from "@naelao/auth";
import { describe, expect, it } from "vitest";
import routerWorker from "../../workers/router/src/index.js";
import { activeTenantDb } from "./helpers/active-tenant-db.js";

// Three-Tier Platform Model, Phase 6: the router required a platform JWT unconditionally
// (api.use("*", jwtAuth(...))) — a product end user, authenticated against ProductUserDO
// (Phase 2, no platform tenant, no JWT), had no way through at all. This is the exact gap
// CLAUDE.md item 23 flagged as deferred ("end-user chat through the router is currently
// non-functional end-to-end"). Fixed with a hybrid auth check: a Bearer nps_... token +
// x-naelao-end-user-id on an ALLOWLISTED path is verified against the space's ProductUserDO via
// the spaces worker's internal endpoint; everything else still requires the ordinary platform
// JWT, unchanged. Phase 6 continued (Product Shell) extended the allowlist beyond sessions* to
// shell/manifest, kb/documents + kb/search (read-only), and product-users/me — see that
// allowlist's own comment in workers/router/src/index.ts for what was deliberately NOT added
// and why.

const execCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
const JWT_SECRET = "test-jwt-secret";

function namedFetcher(
  name: string,
  handler?: (req: Request) => Promise<Response> | Response
): Fetcher {
  return {
    fetch: async (req: Request) =>
      handler ? handler(req) : Response.json({ worker: name }),
  } as unknown as Fetcher;
}

function makeEnv(
  spacesHandler?: (req: Request) => Promise<Response> | Response
) {
  return {
    ENVIRONMENT: "test",
    JWT_SECRET,
    PLATFORM_SECRET: "test-platform-secret",
    PLATFORM_DB: activeTenantDb(),
    SPACES_WORKER: namedFetcher("SPACES", spacesHandler),
    KNOWLEDGE_WORKER: namedFetcher("KNOWLEDGE"),
    AGENTS_WORKER: namedFetcher("AGENTS"),
    CREDENTIALS_WORKER: namedFetcher("CREDENTIALS"),
  };
}

/** Stub SPACES_WORKER's /internal/product-sessions/verify to simulate a valid or invalid
 *  product session, and echo back the claims the router actually forwarded on the real request. */
function makeSpacesStub(opts: {
  validSession: boolean;
  resolvedTenant?: string;
}) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/internal/product-sessions/verify") {
      if (
        req.headers.get("x-naelao-platform-secret") !== "test-platform-secret"
      ) {
        return Response.json({ valid: false }, { status: 403 });
      }
      if (!opts.validSession) return Response.json({ valid: false });
      return Response.json({
        valid: true,
        tenant_id: opts.resolvedTenant ?? "product-owner-tenant",
      });
    }
    // The actual proxied request after auth resolves — echo forwarded identity headers.
    return Response.json({
      worker: "SPACES",
      forwarded_tenant: req.headers.get("x-naelao-tenant-id"),
      forwarded_user: req.headers.get("x-naelao-user-id"),
      forwarded_role: req.headers.get("x-naelao-role"),
    });
  };
}

describe("router — product end-user hybrid auth", () => {
  it("a valid nps_ session token + end-user-id on an allowlisted path resolves and forwards product_end_user claims", async () => {
    const env = makeEnv(
      makeSpacesStub({ validSession: true, resolvedTenant: "builder-tenant-1" })
    );
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer nps_realtoken",
          "x-naelao-end-user-id": "user-42",
        },
      }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forwarded_tenant: string;
      forwarded_user: string;
      forwarded_role: string;
    };
    expect(body.forwarded_tenant).toBe("builder-tenant-1");
    expect(body.forwarded_user).toBe("user-42");
    expect(body.forwarded_role).toBe("product_end_user");
  });

  it("rejects an invalid/expired product session token with 401", async () => {
    const env = makeEnv(makeSpacesStub({ validSession: false }));
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer nps_expired",
          "x-naelao-end-user-id": "user-42",
        },
      }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(401);
  });

  it("a Bearer nps_ token on a NON-allowlisted path is rejected, not silently granted platform access", async () => {
    const env = makeEnv(makeSpacesStub({ validSession: true }));
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/credentials", {
        method: "GET",
        headers: {
          authorization: "Bearer nps_realtoken",
          "x-naelao-end-user-id": "user-42",
        },
      }),
      env as never,
      execCtx
    );
    // Falls through to ordinary JWT verification, which fails for a non-JWT token.
    expect(res.status).toBe(401);
  });

  // Product Shell (Phase 6 continued): kb/documents and kb/search reads, shell/manifest, and
  // product-users/me were deliberately ADDED to the allowlist (Journey 1B: end users read the
  // knowledge base and their own profile). Phase B (§A1.17) later added projects/threads/
  // agent-definitions/presence too, each paired with a requireBusinessMembership floor on the
  // spaces worker — see the tests below. /scheduled-jobs remains deliberately excluded (see the
  // allowlist's own comment: its gate is still tenant-match-only with no per-caller floor, and
  // end-user claims.tid is set to the space's OWNING tenant, so allowlisting it without that
  // floor would silently accept end-user traffic never audited for that caller).
  it("a valid nps_ session CAN reach the allowlisted kb/documents (read) path", async () => {
    const env = makeEnv(
      makeSpacesStub({ validSession: true, resolvedTenant: "builder-tenant-1" })
    );
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/kb/documents", {
        method: "GET",
        headers: {
          authorization: "Bearer nps_realtoken",
          "x-naelao-end-user-id": "user-42",
        },
      }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(200);
  });

  it("a valid nps_ session CAN reach the allowlisted shell/manifest and product-users/me paths", async () => {
    const env = makeEnv(
      makeSpacesStub({ validSession: true, resolvedTenant: "builder-tenant-1" })
    );
    const manifestRes = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/shell/manifest", {
        method: "GET",
        headers: {
          authorization: "Bearer nps_realtoken",
          "x-naelao-end-user-id": "user-42",
        },
      }),
      env as never,
      execCtx
    );
    expect(manifestRes.status).toBe(200);

    const meRes = await routerWorker.fetch(
      new Request(
        "https://router.naelao.com/v1/spaces/prod-1/product-users/me",
        {
          method: "GET",
          headers: {
            authorization: "Bearer nps_realtoken",
            "x-naelao-end-user-id": "user-42",
          },
        }
      ),
      env as never,
      execCtx
    );
    expect(meRes.status).toBe(200);
  });

  // Phase B (§A1.17) revisited this: /projects, /threads, /agent-definitions, and /presence are
  // now allowlisted (the spaces worker's own requireBusinessMembership gate enforces the actual
  // per-method floor — the router only resolves identity, it never authorizes actions).
  it("a valid nps_ session CAN now reach the allowlisted projects, threads, agent-definitions, and presence paths", async () => {
    const env = makeEnv(
      makeSpacesStub({ validSession: true, resolvedTenant: "builder-tenant-1" })
    );
    for (const path of [
      "/spaces/prod-1/projects",
      "/spaces/prod-1/threads",
      "/spaces/prod-1/agent-definitions",
      "/spaces/prod-1/presence",
    ]) {
      const res = await routerWorker.fetch(
        new Request(`https://router.naelao.com/v1${path}`, {
          method: "GET",
          headers: {
            authorization: "Bearer nps_realtoken",
            "x-naelao-end-user-id": "user-42",
          },
        }),
        env as never,
        execCtx
      );
      expect(res.status).toBe(200);
    }
  });

  // WS-2 (Space Assistant surface): /scheduled-jobs (Crons panel) and /assistant-policy (Status
  // panel) are now allowlisted too — the spaces worker added a resolveEndUserBusinessRole floor
  // on GET. PATCH on assistant-policy used to be blocked outright for every product_end_user;
  // it's now admin-gated by requireBusinessMembership instead (item 79) — the router still only
  // resolves identity for either method, real authorization happens on the spaces worker (see
  // that route's own test coverage for the admin-vs-member split).
  it("a valid nps_ session CAN now reach the allowlisted scheduled-jobs and assistant-policy GET paths", async () => {
    const env = makeEnv(
      makeSpacesStub({ validSession: true, resolvedTenant: "builder-tenant-1" })
    );
    for (const path of [
      "/spaces/prod-1/scheduled-jobs",
      "/spaces/prod-1/assistant-policy",
    ]) {
      const res = await routerWorker.fetch(
        new Request(`https://router.naelao.com/v1${path}`, {
          method: "GET",
          headers: {
            authorization: "Bearer nps_realtoken",
            "x-naelao-end-user-id": "user-42",
          },
        }),
        env as never,
        execCtx
      );
      expect(res.status).toBe(200);
    }
  });

  // item 79: a business-admin end user can now change the assistant's own approval policy
  // (guided vs. yolo) for THEIR OWN business — and can reach the new model-config route.
  it("a valid nps_ session CAN reach the allowlisted assistant-policy PATCH and model-config paths", async () => {
    const env = makeEnv(
      makeSpacesStub({ validSession: true, resolvedTenant: "builder-tenant-1" })
    );
    for (const path of [
      "/spaces/prod-1/assistant-policy",
      "/spaces/prod-1/model-config",
    ]) {
      const res = await routerWorker.fetch(
        new Request(`https://router.naelao.com/v1${path}`, {
          method: "PATCH",
          headers: {
            authorization: "Bearer nps_realtoken",
            "x-naelao-end-user-id": "user-42",
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        }),
        env as never,
        execCtx
      );
      expect(res.status).toBe(200);
    }
  });

  it("a valid nps_ session CAN now reach the allowlisted assistant memory/channels/sub-agents/files paths", async () => {
    const env = makeEnv(
      makeSpacesStub({ validSession: true, resolvedTenant: "builder-tenant-1" })
    );
    for (const path of [
      "/spaces/prod-1/assistant/memory",
      "/spaces/prod-1/assistant/channels",
      "/spaces/prod-1/assistant/sub-agents",
      "/spaces/prod-1/assistant/files",
    ]) {
      const res = await routerWorker.fetch(
        new Request(`https://router.naelao.com/v1${path}`, {
          method: "GET",
          headers: {
            authorization: "Bearer nps_realtoken",
            "x-naelao-end-user-id": "user-42",
          },
        }),
        env as never,
        execCtx
      );
      expect(res.status).toBe(200);
    }
  });

  // Phase C (§A1.17) added the business/invite routes: /businesses, /my-businesses (called with a
  // PRODUCT ROOT :spaceId) and /invites*, /business-members* (called with a BUSINESS :spaceId —
  // the first real exerciser of product-sessions/verify's parent-walk).
  it("a valid nps_ session CAN reach the allowlisted business/invite paths", async () => {
    const env = makeEnv(
      makeSpacesStub({ validSession: true, resolvedTenant: "biz-tenant-1" })
    );
    for (const path of [
      "/spaces/prod-1/businesses",
      "/spaces/prod-1/my-businesses",
      "/spaces/biz-1/invites",
      "/spaces/biz-1/invites/some-token/accept",
      "/spaces/biz-1/business-members",
      "/spaces/biz-1/business-members/user-42",
    ]) {
      const res = await routerWorker.fetch(
        new Request(`https://router.naelao.com/v1${path}`, {
          method: "GET",
          headers: {
            authorization: "Bearer nps_realtoken",
            "x-naelao-end-user-id": "user-42",
          },
        }),
        env as never,
        execCtx
      );
      expect(res.status).toBe(200);
    }
  });

  // Phase E (§A1.17) added pricing display + checkout initiation. Same "identity, not
  // authorization" split — requireBusinessMembership on the spaces worker does the actual
  // per-business check; this only proves the router will forward a valid end-user session.
  it("a valid nps_ session CAN reach the allowlisted pricing/checkout paths", async () => {
    const env = makeEnv(
      makeSpacesStub({ validSession: true, resolvedTenant: "biz-tenant-1" })
    );
    for (const path of [
      "/spaces/biz-1/pricing",
      "/spaces/biz-1/business-subscription/checkout",
      "/spaces/biz-1/credit-packs/checkout",
    ]) {
      const res = await routerWorker.fetch(
        new Request(`https://router.naelao.com/v1${path}`, {
          method: "GET",
          headers: {
            authorization: "Bearer nps_realtoken",
            "x-naelao-end-user-id": "user-42",
          },
        }),
        env as never,
        execCtx
      );
      expect(res.status).toBe(200);
    }
  });

  it("a Bearer nps_ token WITHOUT x-naelao-end-user-id falls through to the JWT path and is rejected", async () => {
    const env = makeEnv(makeSpacesStub({ validSession: true }));
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/sessions", {
        method: "POST",
        headers: { authorization: "Bearer nps_realtoken" },
      }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(401);
  });

  it("accepts session_token/end_user_id as query params on GET (EventSource can't set headers) — the real stream endpoint goes to AGENTS_WORKER", async () => {
    const env = makeEnv(
      makeSpacesStub({ validSession: true, resolvedTenant: "builder-tenant-1" })
    );
    (env as Record<string, unknown>).AGENTS_WORKER = namedFetcher(
      "AGENTS",
      (req: Request) =>
        Response.json({
          worker: "AGENTS",
          forwarded_user: req.headers.get("x-naelao-user-id"),
          forwarded_tenant: req.headers.get("x-naelao-tenant-id"),
        })
    );
    const res = await routerWorker.fetch(
      new Request(
        "https://router.naelao.com/v1/spaces/prod-1/sessions/sess-1/agent/runs/run-1/stream?session_token=nps_realtoken&end_user_id=user-42"
      ),
      env as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forwarded_user: string;
      forwarded_tenant: string;
    };
    expect(body.forwarded_user).toBe("user-42");
    expect(body.forwarded_tenant).toBe("builder-tenant-1");
  });

  it("does NOT accept query-param credentials on a non-GET request", async () => {
    const env = makeEnv(makeSpacesStub({ validSession: true }));
    const res = await routerWorker.fetch(
      new Request(
        "https://router.naelao.com/v1/spaces/prod-1/sessions?session_token=nps_realtoken&end_user_id=user-42",
        { method: "POST" }
      ),
      env as never,
      execCtx
    );
    expect(res.status).toBe(401);
  });

  // Phase N (§A1.17) added the manifest-driven operator-shell routes (Revenue/Orders/Products) —
  // same "identity, not authorization" split as pricing above; requireBusinessMembership on the
  // spaces worker does the actual per-business check.
  it("a valid nps_ session CAN reach the allowlisted products/orders/revenue paths", async () => {
    const env = makeEnv(
      makeSpacesStub({ validSession: true, resolvedTenant: "biz-tenant-1" })
    );
    for (const path of [
      "/spaces/biz-1/products",
      "/spaces/biz-1/products/prod-1",
      "/spaces/biz-1/orders",
      "/spaces/biz-1/revenue",
    ]) {
      const res = await routerWorker.fetch(
        new Request(`https://router.naelao.com/v1${path}`, {
          method: "GET",
          headers: {
            authorization: "Bearer nps_realtoken",
            "x-naelao-end-user-id": "user-42",
          },
        }),
        env as never,
        execCtx
      );
      expect(res.status).toBe(200);
    }
  });

  it("an ordinary platform JWT still works on the same allowlisted path — unchanged for Team collaborators", async () => {
    const env = makeEnv(makeSpacesStub({ validSession: true }));
    const token = await signJwt(
      {
        sub: "user-1",
        tid: "tenant-1",
        email: "u@example.com",
        role: "owner",
        scopes: [],
      },
      JWT_SECRET
    );
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces/prod-1/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      env as never,
      execCtx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forwarded_tenant: string;
      forwarded_role: string;
    };
    expect(body.forwarded_tenant).toBe("tenant-1");
    expect(body.forwarded_role).toBe("owner");
  });
});
