// The ultra-cheap web studio template: the pipeline (find -> quote -> build -> deliver) and the
// rules that keep its outreach on the right side of anti-spam and Meta's WhatsApp policy.
//
// The pricing assertions matter more than they look: the same list feeds the Whop storefront the
// assistant provisions AND the skill that quotes a job, so a drift between them would quote a
// customer a price the store cannot actually sell.

import { describe, it, expect } from "vitest";
import { LAUNCHPAD_TEMPLATES, LAUNCHPAD_CORE_AGENTS } from "../../workers/agents/src/launchpad/spacetype.js";
import { LAUNCHPAD_WEBDEV_SKILLS, WEBDEV_TIERS, seedWebdevSkills } from "../../workers/agents/src/launchpad/webdev-skills.js";

const template = LAUNCHPAD_TEMPLATES.find((t) => t.id === "whop-webdev-agency");

describe("the web studio template", () => {
  it("exists, is live, and is usable on the free plan", () => {
    expect(template).toBeDefined();
    // The premise is that someone with no money and no customers can start today; gating it
    // behind a paid plan would defeat it.
    expect(template!.free_tier_eligible).toBe(true);
    expect(template!.coming_soon).toBeFalsy();
  });

  it("publishes the four tiers at the agreed prices", () => {
    const tiers = template!.pricing_tiers ?? [];
    expect(tiers.map((t) => t.id)).toEqual(["basic", "standard", "premium", "enterprise"]);
    const byId = Object.fromEntries(tiers.map((t) => [t.id, t]));
    expect([byId["basic"]!.price_usd_min, byId["basic"]!.price_usd_max]).toEqual([10, 10]);
    expect([byId["standard"]!.price_usd_min, byId["standard"]!.price_usd_max]).toEqual([20, 100]);
    expect([byId["premium"]!.price_usd_min, byId["premium"]!.price_usd_max]).toEqual([120, 150]);
    expect([byId["enterprise"]!.price_usd_min, byId["enterprise"]!.price_usd_max]).toEqual([250, 550]);
  });

  it("prices from the SAME list the storefront is built from", () => {
    // Not two copies that can drift — one list, read by both.
    expect(template!.pricing_tiers!.map((t) => t.id)).toEqual(WEBDEV_TIERS.map((t) => t.id));
    expect(template!.pricing_tiers!.map((t) => t.price_usd_max)).toEqual(WEBDEV_TIERS.map((t) => t.price_usd_max));
  });

  it("seeds the three pipeline projects, each with the agent that owns that stage", () => {
    const projects = template!.bootstrap!.projects ?? [];
    const named = projects.map((p) => (typeof p === "string" ? { name: p } : p));
    const byName = Object.fromEntries(named.map((p) => [p.name, p]));
    expect(byName["Lead Generation"]!.default_agent_id).toBe("launchpad-leadgen-v1");
    expect(byName["Development"]!.default_agent_id).toBe("launchpad-webdev-v1");
    expect(byName["Client Communication"]!.default_agent_id).toBe("launchpad-support-v1");
    // A reference shelf, deliberately unbound — nothing runs there on its own.
    expect(byName["Pricing & Portfolio"]!.default_agent_id).toBeUndefined();
  });

  it("only installs agents that actually exist", () => {
    const known = new Set(LAUNCHPAD_CORE_AGENTS.map((a) => a.id));
    for (const id of template!.agents) expect(known.has(id)).toBe(true);
  });

  it("asks for a service area — an agent cannot prospect 'somewhere'", () => {
    const prompts = template!.bootstrap!.prompts;
    const area = prompts.find((p) => p.id === "service_area");
    expect(area?.required).toBe(true);
    // And a daily ceiling, chosen up front rather than discovered after a domain is burned.
    expect(prompts.find((p) => p.id === "outreach_cap")?.required).toBe(true);
  });

  it("offers Whop OAuth as the primary connect, with the pasted key only as a fallback", () => {
    const prompts = template!.bootstrap!.prompts;
    const connect = prompts.find((p) => p.id === "whop_connection");
    const key = prompts.find((p) => p.id === "whop_api_key");
    expect(connect?.type).toBe("connection");
    expect(connect?.required).toBe(true);
    expect(key?.required).toBe(false);
    // Ordering is the UX: a non-technical owner must meet the button before the API key.
    expect(prompts.indexOf(connect!)).toBeLessThan(prompts.indexOf(key!));
  });

  it("tells the assistant to build the store from the real connected account, and to admit failure", () => {
    const goal = template!.bootstrap!.first_contact!.goal;
    expect(goal).toMatch(/mcp-connector/);
    expect(goal).toMatch(/rather than reporting success/);
    // Outreach approval is stated in the first contact, not left to the autonomy setting.
    expect(goal).toMatch(/until they approve/);
  });
});

describe("the web studio agents", () => {
  const leadgen = LAUNCHPAD_CORE_AGENTS.find((a) => a.id === "launchpad-leadgen-v1")!;
  const webdev = LAUNCHPAD_CORE_AGENTS.find((a) => a.id === "launchpad-webdev-v1")!;

  it("gates every route by which outreach can reach a stranger", () => {
    for (const action of ["outreach_send", "broadcast_send", "email_send"]) {
      expect(leadgen.requires_approval_for).toContain(action);
    }
  });

  it("tells the lead agent it drafts and never sends, and never messages WhatsApp first", () => {
    expect(leadgen.system_prompt).toMatch(/DRAFTED, NEVER SENT BY YOU/);
    expect(leadgen.system_prompt).toMatch(/never message anyone on WhatsApp\s+first/);
    expect(leadgen.system_prompt).toMatch(/opt-out line/);
    expect(leadgen.system_prompt).toMatch(/STOP/);
  });

  it("forbids inventing content for a real customer's site", () => {
    expect(webdev.system_prompt).toMatch(/Do not invent content/);
    // And forbids silently doing more than was paid for.
    expect(webdev.system_prompt).toMatch(/do not quietly exceed it/);
  });

  it("neither agent can spend money on its own", () => {
    expect(leadgen.max_spend_per_action_usd).toBe(0);
    expect(webdev.max_spend_per_action_usd).toBe(0);
  });
});

describe("the web studio skills", () => {
  it("seeds all five, idempotently", async () => {
    const store = new Set<string>();
    const lib = {
      async exists(name: string) { return store.has(name); },
      async create({ name }: { name: string }) { store.add(name); },
    };
    const first = await seedWebdevSkills(lib as never);
    expect(first.sort()).toEqual(["build-brief", "handoff-to-project", "outreach-draft", "pipeline-status", "quote-job"]);
    // Re-running provisioning must not duplicate or throw.
    expect(await seedWebdevSkills(lib as never)).toEqual([]);
  });

  it("tags them so script.find can actually surface them", () => {
    const quote = LAUNCHPAD_WEBDEV_SKILLS.find((s) => s.name === "quote-job")!;
    expect(quote.tags).toContain("how much");
    const outreach = LAUNCHPAD_WEBDEV_SKILLS.find((s) => s.name === "outreach-draft")!;
    expect(outreach.tags).toContain("find customers");
  });

  it("the outreach draft cannot send — it has no send path at all", () => {
    const outreach = LAUNCHPAD_WEBDEV_SKILLS.find((s) => s.name === "outreach-draft")!;
    expect(outreach.code).not.toMatch(/email\.send|notifications\.send|mcp\.call/);
    expect(outreach.code).toMatch(/opt_out_included/);
    expect(outreach.description).toMatch(/cannot send/);
  });
});

// The quote skill's code runs as a stored script; exercised here directly so its pricing rules
// are actually tested rather than merely present.
describe("quote-job pricing behaviour", () => {
  async function runQuote(brief: string) {
    const src = LAUNCHPAD_WEBDEV_SKILLS.find((s) => s.name === "quote-job")!.code;
    const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);
    return mod.run({ brief }, { async run() { return {}; } });
  }

  it("prices a one-pager as basic", async () => {
    expect((await runQuote("just a single page with my opening hours")).tier).toBe("basic");
  });

  it("prices a restaurant site with a menu and a form as standard", async () => {
    expect((await runQuote("a restaurant site with a menu and a contact form")).tier).toBe("standard");
  });

  it("takes the HIGHEST matching tier, not the first", async () => {
    // A job mentioning both a menu and a payment gateway is an enterprise job that happens to
    // have a menu — under-quoting is not the safe direction to round.
    expect((await runQuote("a menu, plus a payment gateway and a customer portal")).tier).toBe("enterprise");
  });

  it("refuses to guess on a thin brief instead of defaulting to the cheapest tier", async () => {
    const res = await runQuote("hi can you help me");
    expect(res.tier).toBeNull();
    expect(res.confident).toBe(false);
    expect(res.next).toMatch(/do not guess/i);
  });

  it("reports what it still does not know, so the agent asks before committing", async () => {
    const res = await runQuote("a booking system and a gallery");
    expect(res.tier).toBe("premium");
    expect(res.unknowns.length).toBeGreaterThan(0);
  });
});
