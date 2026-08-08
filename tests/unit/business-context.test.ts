/**
 * The Space Assistant has to know WHICH business it is running.
 *
 * Written after driving a real business end-to-end on production and finding the assistant could
 * not name the business, did not know it sold websites, and never mentioned that setup was
 * unfinished — because the reasoner payload carried its static profile and nothing about the
 * business. These pin the resolution rules so that cannot silently regress.
 */

import { describe, it, expect } from "vitest";
import {
  resolveBusinessContext,
  parseSpaceConfigForContext,
  loadBusinessContext,
} from "../../workers/agents/src/launchpad/business-context.js";

describe("resolveBusinessContext", () => {
  it("names the business and describes what it actually sells, from its template", () => {
    const ctx = resolveBusinessContext({
      spaceName: "Pixel Forge Studio",
      config: { template_id: "whop-webdev-agency", onboarding: { status: "complete" } },
    });

    expect(ctx.name).toBe("Pixel Forge Studio");
    expect(ctx.kind).toBe("whop-webdev-agency");
    // Not a hand-written second copy of the pitch — the template's own published description, so
    // a pricing or positioning change can never leave the assistant selling something else.
    expect(ctx.offering).toContain("websites");
    expect(ctx.setup_status).toBe("complete");
  });

  it("says nothing about setup once the owner has finished it", () => {
    const ctx = resolveBusinessContext({
      spaceName: "Done Co",
      config: { template_id: "whop-webdev-agency", onboarding: { status: "complete" } },
    });
    // A permanent "finish your setup" nag on a business that IS set up is worse than silence:
    // it trains the owner to ignore the one message that matters when it is real.
    expect(ctx.setup_note).toBeUndefined();
  });

  it("flags unfinished setup as the owner's genuine first step", () => {
    const ctx = resolveBusinessContext({
      spaceName: "Pixel Forge Studio",
      config: { template_id: "whop-webdev-agency", onboarding: { status: "awaiting_setup" } },
    });
    expect(ctx.setup_status).toBe("awaiting_setup");
    expect(ctx.setup_note).toBeTruthy();
    // Phrased for the owner, not as a status enum quoted back at them.
    expect(ctx.setup_note).toMatch(/not finished/i);
  });

  it("treats a missing onboarding record as unfinished, never as done", () => {
    // A brand-new business is created before provisioning writes its onboarding record. Guessing
    // "complete" there would tell an owner with nothing configured that they are ready to trade.
    const ctx = resolveBusinessContext({ spaceName: "Fresh Co", config: {} });
    expect(ctx.setup_status).toBe("pending");
    expect(ctx.setup_note).toBeTruthy();
  });

  it("falls back to the onboarding record's own template list", () => {
    const ctx = resolveBusinessContext({
      spaceName: "Multi Co",
      config: { onboarding: { status: "complete", template_ids: ["whop-webdev-agency"] } },
    });
    expect(ctx.kind).toBe("whop-webdev-agency");
    expect(ctx.offering).toBeTruthy();
  });

  it("still resolves for an untemplated space, with no invented offering", () => {
    const ctx = resolveBusinessContext({ spaceName: "Blank Co", config: { onboarding: { status: "complete" } } });
    expect(ctx.name).toBe("Blank Co");
    expect(ctx.kind).toBeUndefined();
    // Describing an offering nobody configured would be a fabrication the model would then repeat
    // to the owner as fact.
    expect(ctx.offering).toBeUndefined();
  });

  it("does not claim an offering for a template id that no longer exists", () => {
    const ctx = resolveBusinessContext({
      spaceName: "Legacy Co",
      config: { template_id: "template-that-was-removed", onboarding: { status: "complete" } },
    });
    expect(ctx.kind).toBe("template-that-was-removed");
    expect(ctx.offering).toBeUndefined();
  });

  it("degrades to a usable placeholder rather than an empty name", () => {
    const ctx = resolveBusinessContext({ spaceName: "   ", config: null });
    expect(ctx.name).toBe("this business");
  });
});

describe("parseSpaceConfigForContext", () => {
  it("returns an empty config for malformed JSON instead of throwing", () => {
    expect(parseSpaceConfigForContext("{not json")).toEqual({});
    expect(parseSpaceConfigForContext(null)).toEqual({});
    expect(parseSpaceConfigForContext("")).toEqual({});
  });

  it("reads a real config_json string", () => {
    const cfg = parseSpaceConfigForContext(JSON.stringify({ template_id: "whop-seller", onboarding: { status: "complete" } }));
    expect(cfg.template_id).toBe("whop-seller");
    expect(cfg.onboarding?.status).toBe("complete");
  });
});

describe("loadBusinessContext", () => {
  const db = (row: unknown) => ({
    prepare: () => ({ bind: () => ({ first: async () => row as never }) }),
  });

  it("loads a space the caller has not already fetched", async () => {
    const ctx = await loadBusinessContext(
      db({ name: "Heartbeat Co", config_json: JSON.stringify({ template_id: "whop-webdev-agency", onboarding: { status: "complete" } }) }),
      "space1",
      "tenant1"
    );
    expect(ctx?.name).toBe("Heartbeat Co");
    expect(ctx?.offering).toBeTruthy();
  });

  it("returns undefined for an unknown space rather than inventing one", async () => {
    expect(await loadBusinessContext(db(null), "nope", "tenant1")).toBeUndefined();
  });

  it("never lets a lookup failure break the run that needed it", async () => {
    const exploding = {
      prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1 down"); } }) }),
    };
    // The whole point of the context is to make a run better; it must never be why one fails.
    await expect(loadBusinessContext(exploding, "space1", "tenant1")).resolves.toBeUndefined();
    await expect(loadBusinessContext(undefined, "space1", "tenant1")).resolves.toBeUndefined();
  });
});

describe("composeSystemPrompt carries the business", () => {
  // The payload-only version of this feature was deployed, and the same live question came back
  // as generic as before. The fix was to put the business where the model actually looks. These
  // pin that placement, since a regression is invisible until someone reads a bad answer.
  const business = {
    name: "Pixel Forge Studio",
    kind: "whop-webdev-agency",
    offering: "Web Studio (ultra-cheap sites) — build and sell small business websites from $10.",
    setup_status: "awaiting_setup",
    setup_note: "Setup is NOT finished yet, so this business cannot trade.",
  };

  it("states the business name and offering in the system message", async () => {
    const { composeSystemPrompt } = await import("../../workers/agents/src/script-engine/reasoner.js");
    const prompt = composeSystemPrompt("You are the Naelao Agent — a business-builder.", business);
    expect(prompt).toContain("Pixel Forge Studio");
    expect(prompt).toContain("small business websites");
    expect(prompt).toContain("Setup is NOT finished");
  });

  it("never repeats the internal template slug back at the owner", async () => {
    const { composeSystemPrompt } = await import("../../workers/agents/src/script-engine/reasoner.js");
    const prompt = composeSystemPrompt("You are the Naelao Agent.", business);
    // A live run with `kind` in the closing anchor answered "Pixel Forge Studio, a
    // Whop-webdev-agency" — jargon to a business owner. `offering` says it in real words.
    expect(prompt).not.toContain("whop-webdev-agency");
  });

  it("still carries the business when the agent has no profile of its own", async () => {
    const { composeSystemPrompt } = await import("../../workers/agents/src/script-engine/reasoner.js");
    const prompt = composeSystemPrompt(undefined, business);
    expect(prompt).toContain("Pixel Forge Studio");
  });

  it("is unchanged for a run with no resolvable business", async () => {
    const { composeSystemPrompt } = await import("../../workers/agents/src/script-engine/reasoner.js");
    const without = composeSystemPrompt("You are the Naelao Agent.");
    expect(without).not.toContain("THE BUSINESS YOU RUN");
  });
});

describe("the business knows its own prices", () => {
  // Asked "what should I charge?", the assistant gave generic advice about costs and competition
  // — while running a template that ships an explicit four-tier price list. An owner asking what
  // to charge is asking about THIS business's prices, which is a fact we hold.
  it("carries the template's published price list", () => {
    const ctx = resolveBusinessContext({
      spaceName: "Pixel Forge Studio",
      config: { template_id: "whop-webdev-agency", onboarding: { status: "complete" } },
    });
    expect(ctx.pricing).toBeTruthy();
    expect(ctx.pricing).toMatch(/\$\d/);
  });

  it("keeps a per-job tier as a range rather than collapsing it to one number", () => {
    const ctx = resolveBusinessContext({
      spaceName: "Pixel Forge Studio",
      config: { template_id: "whop-webdev-agency", onboarding: { status: "complete" } },
    });
    // The template's own rule: a range means quote WITHIN it and say what you're unsure of.
    // Flattening to a midpoint here would silently delete that.
    expect(ctx.pricing).toMatch(/\$\d+-\d+/);
  });

  it("claims no prices for a template that publishes none", () => {
    const ctx = resolveBusinessContext({
      spaceName: "Blank Co",
      config: { onboarding: { status: "complete" } },
    });
    // Inventing a price list is the one thing worse than having none.
    expect(ctx.pricing).toBeUndefined();
  });

  it("puts the price list in the system message where the model will read it", async () => {
    const { composeSystemPrompt } = await import("../../workers/agents/src/script-engine/reasoner.js");
    const prompt = composeSystemPrompt("You are the Naelao Agent.", {
      name: "Pixel Forge Studio",
      offering: "Web Studio",
      pricing: "Basic $10; Standard $20-100",
      setup_status: "complete",
    });
    expect(prompt).toContain("Basic $10");
    expect(prompt).toContain("rather than giving generic pricing advice");
  });
});

describe("unfinished setup is a fact, not an excuse", () => {
  it("tells the assistant to answer the question first, then mention setup", () => {
    // A live run with the first wording replied to "what should I charge?" with nothing but
    // "finish your setup" — a deflection to a question that has a real answer today. Being
    // blocked on setup must never become a reason to stop answering.
    const ctx = resolveBusinessContext({
      spaceName: "Pixel Forge Studio",
      config: { template_id: "whop-webdev-agency", onboarding: { status: "awaiting_setup" } },
    });
    expect(ctx.setup_note).toMatch(/answer what the owner actually asked first/i);
    expect(ctx.setup_note).toMatch(/never use unfinished setup as a reason to avoid answering/i);
    // And still honest that it cannot trade.
    expect(ctx.setup_note).toMatch(/cannot take payment/i);
  });
});

describe("the internal template slug never reaches the model", () => {
  it("is stripped from the payload projection, not only the system prompt", async () => {
    // Removing `kind` from the system prompt was not enough: the very next live answer read
    // "Pixel Forge Studio, a Whop-webdev-agency" because the model was reading it out of the
    // payload instead. It has to be absent from BOTH, and it stays on the type because code
    // genuinely uses it to resolve the offering and price list.
    const mod = await import("../../workers/agents/src/script-engine/reasoner.js");
    const prompt = mod.composeSystemPrompt("You are the Naelao Agent.", {
      name: "Pixel Forge Studio",
      kind: "whop-webdev-agency",
      offering: "Web Studio — small business websites",
      setup_status: "complete",
    });
    expect(prompt).not.toContain("whop-webdev-agency");
    expect(prompt).toContain("Pixel Forge Studio");
  });
});
