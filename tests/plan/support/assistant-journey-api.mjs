/** Isolated browser API bridge. It proxies an allowlist to the local Wrangler Router and
 * supplies fixtures only for ancillary UI routes outside this journey. It never connects to a
 * production Space or user account. */
import { createServer } from "node:http";

const spaceId = "space-bot-e2e";
const realSpaceBackend = process.env.NAELAO_REAL_SPACE_BACKEND;

if (realSpaceBackend) {
  const seeded = await fetch(`${realSpaceBackend}/__test/browser/bootstrap`, { method: "POST" });
  const fixture = await seeded.json().catch(() => null);
  if (!seeded.ok || !fixture?.spaceId) throw new Error(`Could not seed local SpaceDO browser fixture: ${seeded.status} ${JSON.stringify(fixture)}`);
}

function json(response, status = 200, body = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      "authorization,content-type,x-naelao-end-user-id",
  });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:8787");
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers":
        "authorization,content-type,x-naelao-end-user-id",
    });
    response.end();
    return;
  }
  const path = url.pathname;
  if (path === "/__health") return json(response, 200, { ok: true });
  if (path === "/__reset" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    let input = {};
    try { input = JSON.parse(body); } catch { /* validation below returns a clear error */ }
    if (typeof input.user_id !== "string" || input.user_id.length > 120)
      return json(response, 400, { error_code: "invalid_test_user" });
    return json(response, 200, { ok: true });
  }
  const isProductRuntimeRoute = /^\/v1\/(?:products\/by-slug\/|spaces\/[^/]+\/(?:end-users\/(?:signup|login)|shell\/manifest|my-spaces|spaces|memberships|product-users\/me|projects(?:\/[^/]+)?|agent-definitions(?:\/.*)?|threads(?:\/.*)?))/.test(path);
  if (realSpaceBackend && isProductRuntimeRoute) {
    const headers = new Headers();
    for (const name of ["authorization", "x-naelao-end-user-id", "content-type", "origin"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const body = ["GET", "HEAD"].includes(request.method ?? "GET") ? undefined : await readJson(request);
    const upstream = await fetch(`${realSpaceBackend}${path}${url.search}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return json(response, upstream.status, await upstream.json().catch(() => ({ error_code: "router_invalid_json" })));
  }
  if (path === "/v1/products/by-slug/launchpad-e2e") {
    return json(response, 200, {
      space_id: spaceId,
      product_name: "Naelao Test Space",
      brand_color: null,
      logo_url: null,
      auth_provider: "password",
    });
  }
  if (path === `/v1/spaces/${spaceId}/my-spaces`) {
    return json(response, 200, {
      data: [
        {
          id: spaceId,
          name: "Test Space",
          role: "owner",
          membership_status: "active",
          space_status: "active",
          joined_at: now,
        },
      ],
    });
  }
  if (path === `/v1/spaces/${spaceId}/shell/manifest`) {
    return json(response, 200, {
      space_id: spaceId,
      space_type_id: "launchpad",
      space_name: "Test Space",
      manifest_name: "Naelao Test",
      manifest_version: "1.0.0",
      icon: "✦",
      ui: {
        sidebar_items: [],
        hidden_core_items: [],
        default_view: "dashboard",
      },
      branding: {
        brand_color: null,
        logo_url: null,
        favicon_url: null,
        product_description: null,
        suppress_naelao_branding: false,
      },
      assistant_mode: "default",
      legal: { cookie_policy: "essential" },
      visibility: "private",
    });
  }
  if (path === `/v1/spaces/${spaceId}/product-users/me`) {
    return json(response, 200, {
      end_user_id: "owner-e2e",
      email: "owner@example.test",
      display_name: "Test Owner",
      joined_at: now,
      last_seen_at: now,
      suspended: false,
      email_verified: true,
      preferred_language: "en",
    });
  }
  if (path === `/v1/spaces/${spaceId}/projects`)
    return json(response, 200, { data: [project], count: 1 });
  if (path === `/v1/spaces/${spaceId}/agent-definitions`)
    return json(response, 200, {
      data: [
        {
          id: "planner-logistics",
          name: "Logistics Project Bot",
          description: "Project scoped planner",
        },
      ],
    });
  if (path === `/v1/spaces/${spaceId}/scheduled-jobs`)
    return json(response, 200, { data: [] });
  if (path === `/v1/spaces/${spaceId}/project-steward/reviews`)
    return json(response, 200, { data: [] });
  if (path === `/v1/spaces/${spaceId}/sessions/inbox/approvals`)
    return json(response, 200, { approvals: [] });
  if (/^\/v1\/spaces\/[^/]+\/scheduled-jobs$/.test(path))
    return json(response, 200, { data: [] });
  if (/^\/v1\/spaces\/[^/]+\/project-steward\/reviews$/.test(path))
    return json(response, 200, { data: [] });
  if (/^\/v1\/spaces\/[^/]+\/sessions\/inbox\/approvals$/.test(path))
    return json(response, 200, { approvals: [] });
  return json(response, 404, { error_code: "fixture_route_not_found", path });
});

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("browser fixture request exceeded the body limit");
  }
  return JSON.parse(body || "{}");
}

server.listen(8787, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
