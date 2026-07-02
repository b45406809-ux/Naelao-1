import { describe, it, expect, vi } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";

// POST /spaces/:spaceId/projects/from-template generalized beyond customer_bot: any catalogue
// entry (workspace-kind included) can be stamped onto a new project in one call — the project
// row (kind, ceiling, cap, thread cap, agent binding/allowlist, channel_config when relevant),
// its rules, and its scheduled jobs.

const SECRET = "test-platform-secret";
const SPACE_ID = "space-1";
const TENANT_ID = "tenant-1";

function makeEnv() {
  const projectCalls: Array<{ path: string; method: string; body: unknown }> = [];
  const spacesFetch = vi.fn(async (input: RequestInfo) => {
    const req = input as Request;
    const url = new URL(req.url);
    const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
    projectCalls.push({ path: url.pathname, method: req.method, body });
    if (url.pathname === `/spaces/${SPACE_ID}/projects` && req.method === "POST") {
      return Response.json({ id: "proj-1", name: (body as { name: string }).name }, { status: 201 });
    }
    if (url.pathname === `/spaces/${SPACE_ID}/projects/proj-1` && req.method === "PATCH") {
      return Response.json({ id: "proj-1" }, { status: 200 });
    }
    if (url.pathname === `/spaces/${SPACE_ID}/projects/proj-1/rules` && req.method === "POST") {
      return Response.json({ id: "rule-1" }, { status: 201 });
    }
    if (url.pathname === `/spaces/${SPACE_ID}/scheduled-jobs` && req.method === "POST") {
      return Response.json({ id: "job-1" }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  });

  const env = {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PLATFORM_SECRET: SECRET,
    WHOP_API_KEY: "test-whop-key",
    NAELAO_WHOP_COMPANY_ID: "test-company",
    SPACES_WORKER: { fetch: spacesFetch },
  } as unknown as AgentsEnv;

  return { env, projectCalls };
}

function req(templateId: string): Request {
  return new Request(`https://agents.naelao.com/spaces/${SPACE_ID}/projects/from-template`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT_ID },
    body: JSON.stringify({ template_id: templateId }),
  });
}

describe("POST /spaces/:spaceId/projects/from-template — generalized beyond customer_bot", () => {
  it("applies a customer_bot template: kind, channel_config, rules — no scheduled jobs", async () => {
    const { env, projectCalls } = makeEnv();
    const res = await app.fetch(req("whatsapp-support-bot"), env);
    expect(res.status).toBe(201);
    const body = await res.json() as { kind: string; suggested_channel: string; next_step: string };
    expect(body.kind).toBe("customer_bot");
    expect(body.suggested_channel).toBe("whatsapp");
    expect(body.next_step).toContain("/channels/whatsapp/connect");

    const patchCall = projectCalls.find((c) => c.method === "PATCH")!;
    const patchBody = patchCall.body as { kind: string; channel_config: Record<string, unknown> };
    expect(patchBody.kind).toBe("customer_bot");
    expect(patchBody.channel_config).toEqual({ whatsapp: { connected: false } });

    const ruleCalls = projectCalls.filter((c) => c.path.endsWith("/rules"));
    expect(ruleCalls.length).toBeGreaterThan(0);
    const jobCalls = projectCalls.filter((c) => c.path.endsWith("/scheduled-jobs"));
    expect(jobCalls.length).toBe(0);
  });

  it("applies a workspace-kind template: agent binding at creation, no channel_config, seeds a scheduled job", async () => {
    const { env, projectCalls } = makeEnv();
    const res = await app.fetch(req("community-member-monitoring"), env);
    expect(res.status).toBe(201);
    const body = await res.json() as { kind: string; suggested_channel?: string; next_step?: string };
    expect(body.kind).toBe("workspace");
    expect(body.suggested_channel).toBeUndefined();
    expect(body.next_step).toBeUndefined();

    const createCall = projectCalls.find((c) => c.method === "POST" && c.path === `/spaces/${SPACE_ID}/projects`)!;
    const createBody = createCall.body as { default_agent_id: string; allowed_agent_ids: string[] };
    expect(createBody.default_agent_id).toBe("launchpad-support-v1");
    expect(createBody.allowed_agent_ids).toContain("launchpad-support-v1");

    const patchCall = projectCalls.find((c) => c.method === "PATCH")!;
    const patchBody = patchCall.body as { channel_config?: unknown; max_threads?: number };
    expect(patchBody.channel_config).toBeUndefined();

    const jobCalls = projectCalls.filter((c) => c.path.endsWith("/scheduled-jobs"));
    expect(jobCalls).toHaveLength(1);
    const jobBody = jobCalls[0]!.body as { project_id: string; cron_expression: string };
    expect(jobBody.project_id).toBe("proj-1");
    expect(jobBody.cron_expression).toBeTruthy();
  });

  it("404s for an unknown template id", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(req("does-not-exist"), env);
    expect(res.status).toBe(404);
  });
});
