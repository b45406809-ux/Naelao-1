/** Isolated browser API bridge. It proxies an allowlist to the local Wrangler Router and
 * supplies fixtures only for ancillary UI routes outside this journey. It never connects to a
 * production Space or user account. */
import { createServer } from "node:http";

const realSpaceBackend = process.env.NAELAO_REAL_SPACE_BACKEND;
if (!realSpaceBackend) throw new Error("NAELAO_REAL_SPACE_BACKEND is required for browser acceptance");

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
