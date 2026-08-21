import { describe, it, expect, vi } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { AGENT_TEMPLATES, agentTemplateSummaries, findAgentTemplate, agentTemplateToConfig, customAgentToConfig } from "../../workers/agents/src/agent-templates.js";

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

// Instantiating the SAME template twice used to mint a second agent with a fresh random id and an
// identical name, so a project's switcher listed "Customer Support" as many times as anyone had
// clicked Add — with no way to tell the copies apart, and each carrying its own separate approval
// policy. Adding a template is meant to be idempotent per space.
describe("Agent template instantiation is idempotent per space", () => {
  /** Like makeEnv, but the fake spaces worker REMEMBERS what has been registered, so the
   *  agent-definitions list route answers truthfully — the contract findExistingTemplateInstance
   *  actually depends on. */
  function makeStatefulEnv() {
    const registered: Array<{ id: string; config: Record<string, unknown> }> = [];
    const projectPatches: Array<string[]> = [];
    const r2 = makeFakeR2();
    const spacesFetch = vi.fn(async (input: RequestInfo) => {
      const req = input as Request;
      const url = new URL(req.url);
      const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
      if (url.pathname.endsWith("/agent-definitions") && req.method === "GET") {
        return Response.json({ data: registered });
      }
      if (url.pathname.endsWith("/agent-definitions") && req.method === "POST") {
        const b = body as { id: string; config: Record<string, unknown> };
        registered.push({ id: b.id, config: b.config });
        return Response.json({ id: b.id }, { status: 201 });
      }
      if (url.pathname.match(/\/agents\/[^/]+\/policy$/) && req.method === "PATCH") {
        return Response.json({ ok: true });
      }
      if (url.pathname === `/spaces/${SPACE_ID}/projects/proj-1` && req.method === "GET") {
        return Response.json({ id: "proj-1", allowed_agent_ids: ["naelao-agent"], default_agent_id: "naelao-agent" });
      }
      if (url.pathname === `/spaces/${SPACE_ID}/projects/proj-1` && req.method === "PATCH") {
        projectPatches.push((body as { allowed_agent_ids: string[] }).allowed_agent_ids);
        return Response.json({ id: "proj-1" });
      }
      return new Response("not found", { status: 404 });
    });
    const env = {
      PLATFORM_SECRET: SECRET,
      SPACES_WORKER: { fetch: spacesFetch },
      SCRIPTS_R2: r2,
    } as unknown as AgentsEnv;
    return { env, registered, projectPatches };
  }

  it("returns the existing agent instead of minting a duplicate", async () => {
    const { env, registered } = makeStatefulEnv();
    const first = await (await app.fetch(await instantiateReq({ space_id: SPACE_ID, template_id: "general" }), env)).json() as { agent_id: string };
    const second = await (await app.fetch(await instantiateReq({ space_id: SPACE_ID, template_id: "general" }), env)).json() as { agent_id: string };

    expect(second.agent_id).toBe(first.agent_id);
    expect(registered).toHaveLength(1);
  });

  it("still creates a genuinely different template alongside it", async () => {
    const { env, registered } = makeStatefulEnv();
    const other = AGENT_TEMPLATES.find((t) => t.id !== "general");
    expect(other).toBeDefined();

    await app.fetch(await instantiateReq({ space_id: SPACE_ID, template_id: "general" }), env);
    await app.fetch(await instantiateReq({ space_id: SPACE_ID, template_id: other!.id }), env);

    expect(registered).toHaveLength(2);
  });

  it("binds an already-existing agent to a project it isn't in yet", async () => {
    // Re-adding a template to a DIFFERENT project is a real request even when the agent exists —
    // the dedupe must not swallow the binding along with the duplicate.
    const { env, projectPatches } = makeStatefulEnv();
    const first = await (await app.fetch(await instantiateReq({ space_id: SPACE_ID, template_id: "general" }), env)).json() as { agent_id: string };
    expect(projectPatches).toHaveLength(0);

    await app.fetch(await instantiateReq({ space_id: SPACE_ID, template_id: "general", project_id: "proj-1" }), env);
    expect(projectPatches).toHaveLength(1);
    expect(projectPatches[0]).toContain(first.agent_id);
  });
});

describe("customAgentToConfig (step 17)", () => {
  it("always includes the universal baseline plus the chosen tools, and carries the instructions", () => {
    const cfg = customAgentToConfig({
      name: "SEO Writer",
      description: "Writes SEO articles",
      instructions: "Write keyword-optimized articles. Never fabricate stats.",
      prebuilt_scripts: ["web-search", "knowledge-base"],
    });
    // Universal baseline is always present, even if the caller didn't list it.
    expect(cfg.scripts.prebuilt).toEqual(expect.arrayContaining(["r2-workspace", "memory", "notifications", "web-search", "knowledge-base"]));
    // No duplicate baseline entries if the caller also listed one.
    const withDup = customAgentToConfig({ name: "X", instructions: "do things", prebuilt_scripts: ["memory", "web-search"] });
    expect(withDup.scripts.prebuilt.filter((s) => s === "memory")).toHaveLength(1);
    // The instructions are in the agents.md identity block.
    expect(cfg.agentsMd).toContain("Never fabricate stats");
    expect(cfg.agentsMd).toContain("SEO Writer");
    // A custom agent starts with no pinned skills (learned skills resolve at run time).
    expect(cfg.skills.skills).toEqual([]);
  });

  it("synthesizes a system prompt when none is given", () => {
    const cfg = customAgentToConfig({ name: "Helper", instructions: "help", prebuilt_scripts: [] });
    expect(cfg.systemPrompt).toContain("Helper");
  });
});

describe("POST /agents/custom (step 17)", () => {
  it("writes R2 config, registers the agent, and seeds the chosen autonomy", async () => {
    const { env, r2, spacesCalls } = makeEnv();
    const req = new Request("https://agents.naelao.com/agents/custom", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": TENANT_ID,
        "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT_ID),
      },
      body: JSON.stringify({
        space_id: SPACE_ID,
        name: "SEO Writer",
        instructions: "Write SEO articles, never fabricate stats.",
        prebuilt_scripts: ["web-search", "knowledge-base"],
        approval_mode: "yolo",
      }),
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(201);
    const body = await res.json() as { agent_id: string; custom: boolean };
    expect(body.agent_id).toMatch(/^custom-/);
    expect(body.custom).toBe(true);
    const scripts = JSON.parse(r2.store.get(`spaces/${SPACE_ID}/agents/${body.agent_id}/scripts.json`)!);
    expect(scripts.prebuilt).toEqual(expect.arrayContaining(["r2-workspace", "web-search", "knowledge-base"]));
    const policyCall = spacesCalls.find((c) => c.path.includes("/policy") && c.method === "PATCH");
    expect((policyCall!.body as { approval_mode: string }).approval_mode).toBe("yolo");
  });

  it("rejects with no name or no instructions", async () => {
    const { env } = makeEnv();
    const mk = async (b: Record<string, unknown>) => app.fetch(new Request("https://agents.naelao.com/agents/custom", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT_ID, "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT_ID) },
      body: JSON.stringify(b),
    }), env);
    expect((await mk({ space_id: SPACE_ID, instructions: "x", prebuilt_scripts: [] })).status).toBe(400);
    expect((await mk({ space_id: SPACE_ID, name: "X", prebuilt_scripts: [] })).status).toBe(400);
  });

  // AVOS plan step 5 — capability-firewall archetype (opt-in; omitted = legacy unrestricted
  // behavior, already proven by the first test in this block).
  it("with an archetype: clamps the script list and reports what was rejected", async () => {
    const { env, r2 } = makeEnv();
    const res = await app.fetch(new Request("https://agents.naelao.com/agents/custom", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT_ID, "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT_ID) },
      body: JSON.stringify({
        space_id: SPACE_ID,
        name: "Support Bot",
        instructions: "Answer support questions.",
        // code-exec and local-machine have no business in a customer_support archetype.
        prebuilt_scripts: ["knowledge-base", "code-exec", "local-machine"],
        archetype: "customer_support",
      }),
    }), env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string; rejected_scripts?: string[] };
    expect(body.rejected_scripts?.sort()).toEqual(["code-exec", "local-machine"]);
    const scripts = JSON.parse(r2.store.get(`spaces/${SPACE_ID}/agents/${body.agent_id}/scripts.json`)!);
    expect(scripts.prebuilt).toContain("knowledge-base");
    expect(scripts.prebuilt).not.toContain("code-exec");
    expect(scripts.prebuilt).not.toContain("local-machine");
  });

  it("with an archetype: no rejected_scripts field when everything requested was already allowed", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://agents.naelao.com/agents/custom", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT_ID, "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT_ID) },
      body: JSON.stringify({
        space_id: SPACE_ID, name: "Support Bot", instructions: "Answer support questions.",
        prebuilt_scripts: ["knowledge-base"], archetype: "customer_support",
      }),
    }), env);
    const body = (await res.json()) as { rejected_scripts?: string[] };
    expect(body.rejected_scripts).toBeUndefined();
  });

  it("rejects an unknown archetype with 400 before writing anything", async () => {
    const { env, r2 } = makeEnv();
    const res = await app.fetch(new Request("https://agents.naelao.com/agents/custom", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT_ID, "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT_ID) },
      body: JSON.stringify({
        space_id: SPACE_ID, name: "X", instructions: "y", prebuilt_scripts: [], archetype: "super_admin",
      }),
    }), env);
    expect(res.status).toBe(400);
    expect(r2.store.size).toBe(0);
  });
});

describe("GET /archetypes (AVOS plan step 5)", () => {
  it("lists every archetype preset with its allowlist", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(await getReq("/archetypes"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { archetypes: Array<{ role: string; allowedScripts: string[] }> };
    const roles = body.archetypes.map((a) => a.role).sort();
    expect(roles).toEqual(["architect_delegate", "customer_support", "dev_operator", "growth_operator"]);
    const support = body.archetypes.find((a) => a.role === "customer_support")!;
    expect(support.allowedScripts).not.toContain("code-exec");
    expect(support.allowedScripts).not.toContain("local-machine");
  });
});
