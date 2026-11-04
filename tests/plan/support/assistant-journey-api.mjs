/** Isolated fake API for browser tests. This never connects to a user or production Space. */
import { createServer } from "node:http";

const spaceId = "space-bot-e2e";
const projectId = "project-logistics-e2e";
const now = new Date().toISOString();
const project = {
  id: projectId,
  name: "Logistics Project",
  description: "Synthetic browser journey project",
  status: "active",
  default_agent_id: "planner-logistics",
  max_threads: 20,
  allowed_agent_ids: null,
  created_at: now,
};
const createdThread = {
  id: "thread-project-bot-e2e",
  space_id: spaceId,
  project_id: projectId,
  title: "Project Bot",
  status: "active",
  thread_kind: "primary",
  thread_tier: "tier_1_team",
  parent_thread_id: null,
  session_id: "session-project-bot-e2e",
  created_at: now,
  updated_at: now,
};
let persistedThread = null;

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
    persistedThread = null;
    return json(response, 200, { ok: true });
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
  if (path === `/v1/spaces/${spaceId}/threads`) {
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      if (input.project_id !== projectId)
        return json(response, 403, { error_code: "project_scope_required" });
      if (persistedThread)
        return json(response, 409, { error_code: "thread_already_created" });
      persistedThread = {
        ...createdThread,
        title: input.title ?? createdThread.title,
        thread_tier: input.thread_tier ?? createdThread.thread_tier,
      };
      return json(response, 201, persistedThread);
    }
    return json(response, 200, { data: [], count: 0 });
  }
  if (path === `/v1/spaces/${spaceId}/scheduled-jobs`)
    return json(response, 200, { data: [] });
  if (path === `/v1/spaces/${spaceId}/project-steward/reviews`)
    return json(response, 200, { data: [] });
  if (path === `/v1/spaces/${spaceId}/sessions/inbox/approvals`)
    return json(response, 200, { approvals: [] });
  if (path === `/v1/spaces/${spaceId}/threads/${createdThread.id}`)
    return persistedThread
      ? json(response, 200, persistedThread)
      : json(response, 404, { error_code: "thread_not_found" });
  if (path === `/v1/spaces/${spaceId}/projects/${projectId}`)
    return json(response, 200, project);
  return json(response, 404, { error_code: "fixture_route_not_found", path });
});

server.listen(8787, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
