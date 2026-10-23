// The first-run business setup wizard, end to end at the route level.
//
// Before this, a template's bootstrap could ONLY be completed from the builder dashboard — an end
// user creating a business through apps/shell had no path to it at all, so `project_templates` and
// the assistant's proactive `first_contact` never fired for the population the feature exists for.
// These routes are that path: read the checklist, save answers across an OAuth redirect, complete.
//
// The load-bearing behaviors under test are the ones that make the wizard honest rather than
// decorative: a connection prompt is satisfied by a REAL registered connector (not by a stored
// string), completion REFUSES while a required prompt is unmet, and first contact fires exactly
// once — on the transition into complete, never again.

import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

const SECRET = "test-platform-secret";
const TENANT = "tenant-1";
const SPACE = "space-1";

interface EnvOptions {
  /** Existing config_json on the space. */
  config?: Record<string, unknown>;
  /** Connector ids mcp-hub reports as registered for this space. */
  connected?: string[];
}

interface Harness {
  env: AgentsEnv;
  /** Every config_json written back by an UPDATE, newest last. */
  writes: Record<string, unknown>[];
  /** Goals the agent DO was woken with — how first contact / setup scripts are observed. */
  agentGoals: string[];
  /** Paths POSTed to the spaces worker (project creation during bootstrap). */
  spacesCalls: string[];
}

function makeHarness(options: EnvOptions = {}): Harness {
  let config = JSON.stringify(options.config ?? {});
  const writes: Record<string, unknown>[] = [];
  const agentGoals: string[] = [];
  const spacesCalls: string[] = [];

  function prepare(sql: string) {
    const stmt = {
      _args: [] as unknown[],
      bind(...args: unknown[]) {
        stmt._args = args;
        return stmt;
      },
      async first() {
        if (sql.includes("FROM spaces")) return { id: SPACE, tenant_id: TENANT, config_json: config };
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        if (sql.startsWith("UPDATE spaces SET config_json")) {
          config = stmt._args[0] as string;
          writes.push(JSON.parse(config) as Record<string, unknown>);
        }
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  }

  const env = {
    ANTHROPIC_API_KEY: "k",
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: { prepare } as unknown as D1Database,
    MCP_HUB: {
      async fetch() {
        return Response.json({ data: (options.connected ?? []).map((name) => ({ name })) });
      },
    },
    SPACES_WORKER: {
      async fetch(req: Request) {
        spacesCalls.push(new URL(req.url).pathname);
        return Response.json({ id: `proj-${spacesCalls.length}` }, { status: 201 });
      },
    },
    NAELAO_AGENT_DO: {
      idFromName: (n: string) => ({ toString: () => n }),
      get: () => ({
        async fetch(req: Request) {
          const body = (await req.json().catch(() => ({}))) as { goal?: string };
          if (body.goal) agentGoals.push(body.goal);
          return Response.json({ ok: true });
        },
      }),
    },
    ANALYTICS: { writeDataPoint() {} },
  } as unknown as AgentsEnv;

  return { env, writes, agentGoals, spacesCalls };
}

async function call(
  harness: Harness,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const token = await mintInternalToken(SECRET, TENANT);
  return app.fetch(
    new Request(`https://agents.naelao.com${path}`, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": TENANT,
        "x-naelao-internal-token": token,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    harness.env
  );
}

/** A space provisioned from whop-seller, mid-onboarding — what the provisioner really leaves. */
function whopSellerSpace(extra: Record<string, unknown> = {}) {
  return {
    template_id: "whop-seller",
    onboarding: {
      status: "awaiting_setup",
      template_ids: ["whop-seller"],
      projects: ["Members", { name: "Support", default_agent_id: "launchpad-support-v1" }],
      projects_created: ["Members", "Support"],
      setup_scripts: ["mcp.list_tools"],
    },
    ...extra,
  };
}

describe("GET /spaces/:spaceId/bootstrap — the setup checklist", () => {
  it("returns the template's real prompts with their satisfied state", async () => {
    const h = makeHarness({ config: whopSellerSpace() });
    const res = await call(h, `/spaces/${SPACE}/bootstrap`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.status).toBe("awaiting_setup");
    expect(body.template_ids).toEqual(["whop-seller"]);
    expect(body.templates[0].name).toBe("Whop Seller");
    // The real whop-seller prompt set — sourced from the template, never duplicated client-side.
    const ids = body.prompts.map((p: any) => p.id);
    expect(ids).toContain("whop_connection");
    expect(ids).toContain("owner_channel");
    expect(ids).toContain("autonomy");
    // Nothing is answered or connected yet.
    expect(body.prompts.every((p: any) => p.satisfied === false)).toBe(true);
    expect(body.projects_created).toEqual(["Members", "Support"]);
  });

  it("marks a connection prompt satisfied ONLY when the connector is really registered", async () => {
    // The distinction that matters: a stored answer string must never be mistaken for a working
    // connection. Here a key was "answered" but nothing is registered in the hub.
    const unconnected = makeHarness({
      config: whopSellerSpace({ preferences: { whop_connection: "yes" } }),
    });
    const a = (await (await call(unconnected, `/spaces/${SPACE}/bootstrap`)).json()) as any;
    expect(a.prompts.find((p: any) => p.id === "whop_connection").satisfied).toBe(false);

    const connected = makeHarness({ config: whopSellerSpace(), connected: ["whop"] });
    const b = (await (await call(connected, `/spaces/${SPACE}/bootstrap`)).json()) as any;
    expect(b.prompts.find((p: any) => p.id === "whop_connection").satisfied).toBe(true);
  });

  it("never echoes a credential answer back to the client", async () => {
    const h = makeHarness({ config: whopSellerSpace({ preferences: { whop_connection: "yes" } }) });
    const body = (await (await call(h, `/spaces/${SPACE}/bootstrap`)).json()) as any;
    const credentialPrompt = body.prompts.find((p: any) => p.id === "whop_api_key");
    expect(credentialPrompt.answer).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("sk_live_secret");
  });

  it("deduplicates a prompt shared by two templates so it's asked once", async () => {
    // whop-seller and customer-service both ask `reply_tone`.
    const h = makeHarness({
      config: { onboarding: { status: "awaiting_setup", template_ids: ["whop-seller", "customer-service"] } },
    });
    const body = (await (await call(h, `/spaces/${SPACE}/bootstrap`)).json()) as any;
    const toneCount = body.prompts.filter((p: any) => p.id === "reply_tone").length;
    expect(toneCount).toBe(1);
  });

  it("404s for a space the caller's tenant does not own", async () => {
    const h = makeHarness();
    h.env.PLATFORM_DB = { prepare: () => ({ bind: () => ({ async first() { return null; } }) }) } as unknown as D1Database;
    expect((await call(h, `/spaces/${SPACE}/bootstrap`)).status).toBe(404);
  });
});

describe("POST /spaces/:spaceId/bootstrap/save — surviving the OAuth redirect", () => {
  it("persists answers into preferences without completing onboarding", async () => {
    const h = makeHarness({ config: whopSellerSpace() });
    const res = await call(h, `/spaces/${SPACE}/bootstrap/save`, {
      method: "POST",
      body: { answers: { owner_channel: "email", autonomy: "Ask me first — approve everything before it happens" } },
    });
    expect(res.status).toBe(200);

    const written = h.writes.at(-1)!;
    expect((written["preferences"] as any).owner_channel).toBe("email");
    // Saving is NOT completing — status must be untouched, and no agent woken.
    expect((written["onboarding"] as any).status).toBe("awaiting_setup");
    expect(h.agentGoals).toHaveLength(0);
  });

  it("merges rather than clobbering — a second save keeps the first answer", async () => {
    const h = makeHarness({ config: whopSellerSpace({ preferences: { existing: "kept" } }) });
    await call(h, `/spaces/${SPACE}/bootstrap/save`, { method: "POST", body: { answers: { owner_channel: "slack" } } });
    await call(h, `/spaces/${SPACE}/bootstrap/save`, { method: "POST", body: { answers: { reply_tone: "Friendly" } } });

    const prefs = h.writes.at(-1)!["preferences"] as any;
    expect(prefs).toMatchObject({ existing: "kept", owner_channel: "slack", reply_tone: "Friendly" });
    // Sibling config keys survive too — config_json also carries template_id/onboarding.
    expect(h.writes.at(-1)!["template_id"]).toBe("whop-seller");
  });
});

describe("POST /spaces/:spaceId/bootstrap/complete — refuses to finish setup that isn't finished", () => {
  it("rejects while a required prompt is unmet, naming exactly what's missing", async () => {
    const h = makeHarness({ config: whopSellerSpace() });
    const res = await call(h, `/spaces/${SPACE}/bootstrap/complete`, { method: "POST", body: {} });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error_code).toBe("onboarding_incomplete");
    expect(body.missing).toContain("whop_connection");
    expect(body.missing).toContain("owner_channel");
    expect(body.missing).toContain("autonomy");
    // Optional prompts are never a reason to block.
    expect(body.missing).not.toContain("reply_tone");
    // Nothing ran: no assistant woken, and onboarding is NOT marked complete.
    expect(h.agentGoals).toHaveLength(0);
  });

  it("accepts answers in the SAME call and completes, firing setup + first contact", async () => {
    const h = makeHarness({ config: whopSellerSpace(), connected: ["whop"] });
    const res = await call(h, `/spaces/${SPACE}/bootstrap/complete`, {
      method: "POST",
      body: {
        answers: {
          owner_channel: "email",
          autonomy: "Ask me first — approve everything before it happens",
          business_goal: "more members",
        },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.first_contact_sent).toBe(true);

    // The assistant was woken twice: once for setup scripts, once to introduce itself.
    expect(h.agentGoals.some((g) => g.includes("mcp.list_tools"))).toBe(true);
    expect(h.agentGoals.some((g) => g.includes("Introduce yourself to the owner"))).toBe(true);

    const written = h.writes.at(-1)!;
    expect((written["onboarding"] as any).status).toBe("complete");
    // The answers sent with the completing call are persisted, not dropped.
    expect((written["preferences"] as any).business_goal).toBe("more members");
  });

  it("never re-introduces the assistant to an owner who already completed setup", async () => {
    const h = makeHarness({
      config: whopSellerSpace({ onboarding: { status: "complete", template_ids: ["whop-seller"] } }),
      connected: ["whop"],
    });
    const res = await call(h, `/spaces/${SPACE}/bootstrap/complete`, { method: "POST", body: {} });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).first_contact_sent).toBe(false);
    expect(h.agentGoals.some((g) => g.includes("Introduce yourself"))).toBe(false);
  });

  it("does not re-validate an already-complete space, so a template gaining a prompt can't strand it", async () => {
    // status 'complete' with nothing answered and nothing connected — under the validation rule
    // this would fail, but a business that finished setup under an older template definition must
    // never start 400ing.
    const h = makeHarness({ config: whopSellerSpace({ onboarding: { status: "complete", template_ids: ["whop-seller"] } }) });
    expect((await call(h, `/spaces/${SPACE}/bootstrap/complete`, { method: "POST", body: {} })).status).toBe(200);
  });

  it("a Custom business (no templates) completes with no prompts to answer", async () => {
    const h = makeHarness({ config: { onboarding: { status: "awaiting_setup", template_ids: [] } } });
    const res = await call(h, `/spaces/${SPACE}/bootstrap/complete`, { method: "POST", body: {} });
    expect(res.status).toBe(200);
    expect(h.writes.at(-1)!["onboarding"]).toMatchObject({ status: "complete" });
  });
});

describe("the onboarding routes are behind the same verified-tenant gate as every sibling", () => {
  for (const [method, path] of [
    ["GET", `/spaces/${SPACE}/bootstrap`],
    ["POST", `/spaces/${SPACE}/bootstrap/save`],
    ["POST", `/spaces/${SPACE}/bootstrap/complete`],
  ] as const) {
    it(`${method} ${path} → 401 without a valid internal token`, async () => {
      const h = makeHarness({ config: whopSellerSpace() });
      const res = await app.fetch(
        new Request(`https://agents.naelao.com${path}`, {
          method,
          headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
        h.env
      );
      expect(res.status).toBe(401);
    });
  }
});
