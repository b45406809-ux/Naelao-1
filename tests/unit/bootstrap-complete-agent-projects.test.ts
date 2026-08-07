import { describe, it, expect, vi } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// Templates now seed projects bound to a default agent (spacetype.ts's TemplateProjectSeed,
// SpaceDO migration v18's projects.default_agent_id) — POST /bootstrap/complete is what turns
// the provisioner's recorded onboarding record into real SpaceDO rows: a project per seed
// (carrying its default_agent_id) plus, for any project that HAS one, a starter thread so the
// builder opens on a pre-wired workspace instead of an empty project. A reference/data project
// (no default_agent_id) gets no starter thread.

const SECRET = "test-platform-secret";
const SPACE_ID = "space-1";
const TENANT_ID = "tenant-1";

interface OnboardingConfig {
  projects?: Array<string | { name: string; default_agent_id?: string }>;
  setup_scripts?: string[];
  status?: string;
}

function makeEnv(onboarding: OnboardingConfig): {
  env: AgentsEnv;
  projectCalls: Array<{ name: string; default_agent_id?: string }>;
  threadCalls: Array<{ project_id: string; title: string }>;
} {
  const projectCalls: Array<{ name: string; default_agent_id?: string }> = [];
  const threadCalls: Array<{ project_id: string; title: string }> = [];
  let projectSeq = 0;

  const spacesFetch = vi.fn(async (input: RequestInfo) => {
    const req = input as Request;
    const url = new URL(req.url);
    if (url.pathname === `/spaces/${SPACE_ID}/projects` && req.method === "POST") {
      const body = await req.json() as { name: string; default_agent_id?: string };
      projectCalls.push(body);
      const id = `proj-${++projectSeq}`;
      return Response.json({ id, name: body.name, status: "active", default_agent_id: body.default_agent_id ?? null }, { status: 201 });
    }
    if (url.pathname === `/spaces/${SPACE_ID}/threads` && req.method === "POST") {
      const body = await req.json() as { project_id: string; title: string };
      threadCalls.push(body);
      return Response.json({ id: "thread-1", project_id: body.project_id, title: body.title }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  });

  const dbRow = { config_json: JSON.stringify({ onboarding }), status: "active" };
  const env = {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PLATFORM_SECRET: SECRET,
    WHOP_API_KEY: "test-whop-key",
    NAELAO_WHOP_COMPANY_ID: "test-company",
    PLATFORM_DB: {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt; },
          async first() {
            // Match on the table, not the exact column list — this double previously hardcoded
            // "SELECT config_json FROM spaces" and silently started 404ing the moment the real query
            // selected one more column (the same brittle-test-double class as the schema_json bug).
            if (/FROM spaces/.test(sql)) return dbRow;
            return null;
          },
          async run() { return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    },
    SPACES_WORKER: { fetch: spacesFetch },
  } as unknown as AgentsEnv;

  return { env, projectCalls, threadCalls };
}

// Go-live audit F1: /bootstrap/complete now requires the signed x-naelao-internal-token
// naelao-router's proxyTo mints for every real request (this worker has no workers_dev=false
// backstop, so a bare spoofed x-naelao-tenant-id can no longer be trusted).
async function bootstrapReq(): Promise<Request> {
  return new Request(`https://agents.naelao.com/spaces/${SPACE_ID}/bootstrap/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": TENANT_ID,
      "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT_ID),
    },
  });
}

describe("POST /spaces/:spaceId/bootstrap/complete — pre-wired projects + starter threads", () => {
  it("creates each seeded project with its default_agent_id and seeds a starter thread for bound ones", async () => {
    const { env, projectCalls, threadCalls } = makeEnv({
      projects: [
        "Products", // unbound, string form
        { name: "Orders", default_agent_id: "launchpad-fulfillment-v1" },
        { name: "Support", default_agent_id: "launchpad-support-v1" },
      ],
      setup_scripts: [],
    });

    const res = await app.fetch(await bootstrapReq(), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { projects_created: string[] };
    expect(body.projects_created).toEqual(["Products", "Orders", "Support"]);

    // The trailing General entry is seedGeneralProject's own retroactive-coverage call (§65) —
    // bootstrap/complete is the one other place every business genuinely passes through, so it
    // seeds the default project here too, not just at provision time.
    expect(projectCalls).toEqual([
      { name: "Products" },
      { name: "Orders", default_agent_id: "launchpad-fulfillment-v1" },
      { name: "Support", default_agent_id: "launchpad-support-v1" },
      { name: "General", description: expect.any(String), default_agent_id: "naelao-agent", visibility: "public" },
    ]);

    // Only the two bound TEMPLATE projects get a starter thread — "Products" (unbound) does not,
    // and General never does either (seedGeneralProject only creates the project itself).
    expect(threadCalls).toHaveLength(2);
    expect(threadCalls.map((t) => t.title)).toEqual(["Orders", "Support"]);
  });

  it("creates no starter threads when every seeded project is unbound", async () => {
    const { env, threadCalls } = makeEnv({ projects: ["Members", "Escalations", "FAQ"], setup_scripts: [] });
    const res = await app.fetch(await bootstrapReq(), env);
    expect(res.status).toBe(200);
    expect(threadCalls).toHaveLength(0);
  });

  it("still works against an older onboarding record whose projects are plain strings", async () => {
    const { env, projectCalls, threadCalls } = makeEnv({ projects: ["Inbox", "FAQ"], setup_scripts: [] });
    const res = await app.fetch(await bootstrapReq(), env);
    expect(res.status).toBe(200);
    expect(projectCalls).toEqual([
      { name: "Inbox" },
      { name: "FAQ" },
      { name: "General", description: expect.any(String), default_agent_id: "naelao-agent", visibility: "public" },
    ]);
    expect(threadCalls).toHaveLength(0);
  });
});
