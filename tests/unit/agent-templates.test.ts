import { describe, it, expect, vi } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { AGENT_TEMPLATES, agentTemplateSummaries, findAgentTemplate, agentTemplateToConfig } from "../../workers/agents/src/agent-templates.js";

// GET /agent-templates (catalogue browse) + POST /agent-templates/instantiate (a project's own
// switcher/#68 depends on both): applying a template writes the 4 R2 config files, registers a
// real agent_definitions row, seeds its own approval policy, and — when a project id is given —
// appends the new agent to that project's allowed_agent_ids.

const SECRET = "test-platform-secret";
const SPACE_ID = "space-1";
const TENANT_ID = "tenant-1";

function makeFakeR2() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      const v = store.get(key);
      return v === undefined ? null : ({ text: async () => v } as unknown as R2ObjectBody);
    },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as R2Bucket & { store: Map<string, string> };
}

function makeEnv(opts: { withProject?: boolean } = {}) {
  const spacesCalls: Array<{ path: string; method: string; body: unknown }> = [];
  const r2 = makeFakeR2();
  const spacesFetch = vi.fn(async (input: RequestInfo) => {
    const req = input as Request;
    const url = new URL(req.url);
    const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
    spacesCalls.push({ path: url.pathname, method: req.method, body });
    if (url.pathname.endsWith("/agent-definitions") && req.method === "POST") {
      return Response.json({ id: (body as { id: string }).id }, { status: 201 });
    }
    if (url.pathname.match(/\/agents\/[^/]+\/policy$/) && req.method === "PATCH") {
      return Response.json({ approval_mode: (body as { approval_mode: string }).approval_mode }, { status: 200 });
    }
    if (url.pathname === `/spaces/${SPACE_ID}/projects/proj-1` && req.method === "GET") {
      return Response.json({ id: "proj-1", allowed_agent_ids: ["naelao-agent"], default_agent_id: "naelao-agent" }, { status: 200 });
    }
    if (url.pathname === `/spaces/${SPACE_ID}/projects/proj-1` && req.method === "PATCH") {
      return Response.json({ id: "proj-1" }, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  const env = {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PLATFORM_SECRET: SECRET,
    WHOP_API_KEY: "test-whop-key",
    NAELAO_WHOP_COMPANY_ID: "test-company",
    SPACES_WORKER: { fetch: spacesFetch },
    SCRIPTS_R2: r2,
  } as unknown as AgentsEnv;

  return { env, spacesCalls, r2 };
}

async function getReq(path: string): Promise<Request> {
  return new Request(`https://agents.naelao.com${path}`, {
    headers: { "x-naelao-tenant-id": TENANT_ID, "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT_ID) },
  });
}

async function instantiateReq(body: Record<string, unknown>): Promise<Request> {
  return new Request("https://agents.naelao.com/agent-templates/instantiate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": TENANT_ID,
      "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT_ID),
    },
    body: JSON.stringify(body),
  });
}

describe("Agent Templates catalogue", () => {
  it("has at least the general default plus real verticals — never empty", () => {
    expect(AGENT_TEMPLATES.length).toBeGreaterThanOrEqual(5);
    expect(findAgentTemplate("general")).toBeDefined();
    expect(findAgentTemplate("customer-support")).toBeDefined();
  });

  it("every template's prebuilt_scripts list is non-empty and distinct per category — not the same generic set copy-pasted", () => {
    const scriptSets = AGENT_TEMPLATES.map((t) => [...t.prebuilt_scripts].sort().join(","));
    // Not asserting global uniqueness (some overlap is expected/fine), but the SET of distinct
    // tool-list shapes must be more than one — otherwise "templates" would just be a label.
    expect(new Set(scriptSets).size).toBeGreaterThan(1);
    for (const t of AGENT_TEMPLATES) expect(t.prebuilt_scripts.length).toBeGreaterThan(0);
  });

  it("the browsable summary never leaks system_prompt/instructions text", () => {
    const raw = JSON.stringify(agentTemplateSummaries());
    for (const t of AGENT_TEMPLATES) {
      expect(raw).not.toContain(t.system_prompt);
      expect(raw).not.toContain(t.instructions);
    }
  });

  it("a customer-support agent never gets code-exec — its whole point is staying inside the KB", () => {
    const support = findAgentTemplate("customer-support")!;
    expect(support.prebuilt_scripts).not.toContain("code-exec");
    const config = agentTemplateToConfig(support);
    expect(config.scripts.prebuilt).not.toContain("code-exec");
  });
});

describe("GET /agent-templates", () => {
  it("returns the catalogue with a real internal token", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(await getReq("/agent-templates"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { templates: Array<{ id: string }> };
    expect(body.templates.length).toBeGreaterThanOrEqual(5);
  });

  it("rejects with no internal token", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://agents.naelao.com/agent-templates"), env);
    expect(res.status).toBe(401);
  });
});

describe("POST /agent-templates/instantiate", () => {
  it("writes real R2 config files and registers a real agent_definitions row", async () => {
    const { env, r2, spacesCalls } = makeEnv();
    const res = await app.fetch(await instantiateReq({ space_id: SPACE_ID, template_id: "code-reviewer" }), env);
    expect(res.status).toBe(201);
    const body = await res.json() as { agent_id: string; agent_definition_id: string; template_id: string };
    expect(body.agent_id).toMatch(/^code-reviewer-/);
    expect(body.agent_definition_id).toBe(`${SPACE_ID}:${body.agent_id}`);

    expect(r2.store.has(`spaces/${SPACE_ID}/agents/${body.agent_id}/agents.md`)).toBe(true);
    expect(r2.store.has(`spaces/${SPACE_ID}/agents/${body.agent_id}/system-prompt.md`)).toBe(true);
    const scripts = JSON.parse(r2.store.get(`spaces/${SPACE_ID}/agents/${body.agent_id}/scripts.json`)!);
    expect(scripts.prebuilt).toContain("code-exec");

    const registerCall = spacesCalls.find((c) => c.path.endsWith("/agent-definitions") && c.method === "POST");
    expect(registerCall).toBeDefined();
    expect((registerCall!.body as { id: string }).id).toBe(`${SPACE_ID}:${body.agent_id}`);

    const policyCall = spacesCalls.find((c) => c.path.includes("/policy") && c.method === "PATCH");
    expect(policyCall).toBeDefined();
    expect((policyCall!.body as { approval_mode: string }).approval_mode).toBe("always_ask");
  });

  it("binds the new agent into a project's allowed_agent_ids when project_id is given, never dropping the existing default", async () => {
    const { env, spacesCalls } = makeEnv();
    const res = await app.fetch(await instantiateReq({ space_id: SPACE_ID, template_id: "customer-support", project_id: "proj-1" }), env);
    expect(res.status).toBe(201);
    const body = await res.json() as { agent_id: string };

    const patchCall = spacesCalls.find((c) => c.path === `/spaces/${SPACE_ID}/projects/proj-1` && c.method === "PATCH");
    expect(patchCall).toBeDefined();
    const allowed = (patchCall!.body as { allowed_agent_ids: string[] }).allowed_agent_ids;
    expect(allowed).toContain(body.agent_id);
    expect(allowed).toContain("naelao-agent"); // the project's pre-existing default is preserved, not overwritten
  });

  it("404s on an unknown template id", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(await instantiateReq({ space_id: SPACE_ID, template_id: "not-a-real-template" }), env);
    expect(res.status).toBe(404);
  });

  it("400s with no template_id", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(await instantiateReq({ space_id: SPACE_ID }), env);
    expect(res.status).toBe(400);
  });

  it("rejects with no internal token", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(
      new Request("https://agents.naelao.com/agent-templates/instantiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ space_id: SPACE_ID, template_id: "general" }),
      }),
      env
    );
    expect(res.status).toBe(401);
  });
});
