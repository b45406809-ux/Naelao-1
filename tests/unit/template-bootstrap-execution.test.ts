// Template bootstrap actually EXECUTES — the fix for a live-confirmed production bug.
//
// Before this: the provisioner only RECORDED a template's bootstrap into config_json.onboarding
// with status "pending". The single caller that executed it was the BUILDER dashboard's onboarding
// page, so an end user creating a business through apps/shell got a space with agents installed
// but ZERO of the template's projects. Reproduced live against production first: a real
// whop-seller business reached status 'active' carrying only the auto-provisioned "Wallet"
// project — none of Members/Support/Content existed, and onboarding sat at "pending" forever.

import { describe, it, expect } from "vitest";
import { seedTemplateProjects, normalizeProjectSeeds } from "../../workers/agents/src/launchpad/bootstrap.js";
import { getLaunchpadTemplate, validateLaunchpadSpaceType, LAUNCHPAD_TEMPLATES } from "../../workers/agents/src/launchpad/spacetype.js";

/** A postToSpaces double that records every call and mimics SpaceDO's REAL behavior — which this
 *  fake used to get wrong (returning 409 on a duplicate name) and is exactly why the "idempotent"
 *  test below passed while production had a real, live-reported bug: SpaceDO's createProject
 *  ALWAYS returns 201/ok, even on a duplicate name, because it uses `ON CONFLICT(space_id, name)
 *  DO NOTHING` rather than rejecting — the row (and its real id) still comes back correctly, the
 *  only signal a caller gets is the `created` field this bug prompted adding. Modeling the fake
 *  as a 409 hid the real bug from this whole test file for as long as it existed. */
function makeSpacesDouble() {
  const calls: Array<{ path: string; body: any }> = [];
  const projectIds = new Map<string, string>();
  let nextId = 1;
  return {
    calls,
    deps: {
      async postToSpaces(path: string, body: any): Promise<Response> {
        calls.push({ path, body });
        if (path.endsWith("/projects")) {
          const already = projectIds.has(body.name);
          const id = already ? projectIds.get(body.name)! : `proj-${nextId++}`;
          if (!already) projectIds.set(body.name, id);
          return new Response(JSON.stringify({ id, name: body.name, created: !already }), { status: 201 });
        }
        return new Response(JSON.stringify({ id: `thread-${nextId++}` }), { status: 201 });
      },
    },
  };
}

describe("seedTemplateProjects — the structural bootstrap the provisioner now runs", () => {
  it("creates every project and a starter thread ONLY for agent-bound ones", async () => {
    const { deps, calls } = makeSpacesDouble();
    const created = await seedTemplateProjects(deps, "space-1", "tenant-1", [
      { name: "Members" }, // reference project — nothing runs here, so no starter thread
      { name: "Support", default_agent_id: "launchpad-support-v1" },
      { name: "Content", default_agent_id: "launchpad-content-v1" },
    ]);

    expect(created.map((p) => p.name)).toEqual(["Members", "Support", "Content"]);

    const projectCalls = calls.filter((c) => c.path.endsWith("/projects"));
    const threadCalls = calls.filter((c) => c.path.endsWith("/threads"));
    expect(projectCalls).toHaveLength(3);
    // Two bound projects → two starter threads. "Members" must NOT get one.
    expect(threadCalls).toHaveLength(2);
    expect(threadCalls.map((c) => c.body.title).sort()).toEqual(["Content", "Support"]);

    // The agent binding is set at creation, not patched in afterwards.
    expect(projectCalls.find((c) => c.body.name === "Support")!.body.default_agent_id).toBe("launchpad-support-v1");
    expect(projectCalls.find((c) => c.body.name === "Members")!.body.default_agent_id).toBeUndefined();
  });

  it("is idempotent — a re-run against SpaceDO's UNIQUE(space_id,name) creates no duplicates", async () => {
    const { deps, calls } = makeSpacesDouble();
    const seeds = [{ name: "Support", default_agent_id: "launchpad-support-v1" }];

    const first = await seedTemplateProjects(deps, "space-1", "tenant-1", seeds);
    const second = await seedTemplateProjects(deps, "space-1", "tenant-1", seeds);

    expect(first.map((p) => p.name)).toEqual(["Support"]);
    // Second run still resolves the (already-existing) project's real id — a caller wiring event
    // rules between projects needs that regardless of newness — but critically seeds NO second
    // starter thread for it, which is the actual bug this test exists to catch.
    expect(second.map((p) => p.name)).toEqual(["Support"]);
    expect(calls.filter((c) => c.path.endsWith("/threads"))).toHaveLength(1);
  });

  it("one failing project never aborts the rest (best-effort, matching every other provision step)", async () => {
    let n = 0;
    const deps = {
      async postToSpaces(path: string): Promise<Response> {
        if (path.endsWith("/projects")) {
          n++;
          if (n === 1) throw new Error("transient SpaceDO error");
          return new Response(JSON.stringify({ id: `p${n}` }), { status: 201 });
        }
        return new Response("{}", { status: 201 });
      },
    };
    const created = await seedTemplateProjects(deps, "space-1", "tenant-1", [
      { name: "First" },
      { name: "Second" },
      { name: "Third" },
    ]);
    expect(created.map((p) => p.name)).toEqual(["Second", "Third"]);
  });

  it("normalizes spacetype.ts's mixed string | object seed forms", () => {
    expect(normalizeProjectSeeds(["Members", { name: "Support", default_agent_id: "a" }])).toEqual([
      { name: "Members" },
      { name: "Support", default_agent_id: "a" },
    ]);
    expect(normalizeProjectSeeds(undefined)).toEqual([]);
  });
});

describe("whop-seller — the populated template", () => {
  const tpl = getLaunchpadTemplate("whop-seller")!;

  it("is the live template (not coming_soon) and installs support + content agents", () => {
    expect(tpl.coming_soon).toBeFalsy();
    expect(tpl.agents).toContain("launchpad-support-v1");
    expect(tpl.agents).toContain("launchpad-content-v1");
  });

  it("leads with the real click-through Whop connect flow, not a pasted API key", () => {
    const connect = tpl.bootstrap!.prompts.find((p) => p.id === "whop_connection")!;
    expect(connect.type).toBe("connection");
    expect(connect.connector).toBe("whop");
    expect(connect.required).toBe(true);

    // The pasted-key path still exists, but only as an explicitly optional fallback — a
    // non-technical owner must never be REQUIRED to go find an API key.
    const pasted = tpl.bootstrap!.prompts.find((p) => p.id === "whop_api_key")!;
    expect(pasted.type).toBe("credential");
    expect(pasted.required).toBe(false);
  });

  it("asks where the assistant should reach the owner, and how autonomous it should be", () => {
    const channel = tpl.bootstrap!.prompts.find((p) => p.id === "owner_channel")!;
    expect(channel.type).toBe("channel");
    expect(channel.required).toBe(true);
    expect(channel.options).toContain("email");

    const autonomy = tpl.bootstrap!.prompts.find((p) => p.id === "autonomy")!;
    expect(autonomy.required).toBe(true);
    expect(autonomy.options).toHaveLength(3);
  });

  it("ships a first-contact plan without creating a hardcoded customer-bot preset", () => {
    expect(tpl.bootstrap!.project_templates ?? []).not.toContain("discord-community-bot");
    const goal = tpl.bootstrap!.first_contact!.goal;
    // The instruction must tell the assistant to LOOK before it plans — a first contact that
    // invents numbers it never checked is exactly the failure mode this wording guards against.
    expect(goal).toMatch(/mcp-connector|Whop account/i);
    expect(goal).toMatch(/autonomy/i);
  });

  it("every prompt is written for a non-technical owner (required ones carry help text)", () => {
    for (const p of tpl.bootstrap!.prompts) {
      expect(p.question.length).toBeGreaterThan(0);
      if (p.required) expect(p.help, `prompt '${p.id}' is required but has no help text`).toBeTruthy();
    }
  });
});

describe("template validation catches misconfiguration at module load", () => {
  it("accepts the real catalogue", () => {
    expect(() => validateLaunchpadSpaceType()).not.toThrow();
  });

  it("rejects a connect prompt naming a connector the template never wires", () => {
    const broken = {
      ...LAUNCHPAD_TEMPLATES[0]!,
      id: "broken-connector",
      connectors: ["whop"],
      bootstrap: {
        prompts: [{ id: "x", type: "connection" as const, connector: "stripe", question: "Connect Stripe" }],
      },
    };
    expect(() =>
      validateLaunchpadSpaceType({ id: "launchpad", version: "1", name: "t", description: "d", templates: [broken], core_agents: [] })
    ).toThrow(/not in this template's own connectors/);
  });

  it("rejects a choice prompt that offers no options (an unanswerable question)", () => {
    const broken = {
      ...LAUNCHPAD_TEMPLATES[0]!,
      id: "broken-choice",
      connectors: [],
      bootstrap: { prompts: [{ id: "x", type: "choice" as const, question: "Pick one" }] },
    };
    expect(() =>
      validateLaunchpadSpaceType({ id: "launchpad", version: "1", name: "t", description: "d", templates: [broken], core_agents: [] })
    ).toThrow(/offers no options/);
  });
});
