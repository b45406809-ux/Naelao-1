/**
 * Skills for the ultra-cheap web studio template (whop-webdev-agency).
 *
 * Ordinary stored scripts, same "SCRIPT.md + code.ts" shape as scaling-skills.ts and
 * growth-skills.ts — not engine opcodes. They exist so `script.find` surfaces the right thing when
 * an agent reasons about a lead, a quote or a build, instead of every agent re-deriving the
 * studio's pricing and process from its prompt each time.
 *
 * The pipeline these support: a lead is found and qualified -> a quote is produced from the
 * published tiers -> on acceptance a build brief is written to the Development project -> the site
 * is built and delivered -> the client is told.
 *
 * Outreach is deliberately HITL and email-first (the owner's own choice at build time): the draft
 * skill DRAFTS, it never sends. Sending is the `business-email`/`notifications` prebuilt, behind
 * whatever approval mode the space is in. A skill that could quietly email strangers is exactly
 * the thing that gets a young business's domain burned.
 */

import type { ScalingSkill, SeedableLibrary } from "./scaling-skills.js";

/**
 * The studio's published price list, in one place.
 *
 * Deliberately a plain constant rather than a lookup: it is the same list the Whop store is
 * provisioned from and the same one the quote skill prices against, so the two can never quote a
 * customer something the store cannot actually sell.
 */
export const WEBDEV_TIERS = [
  {
    id: "basic",
    name: "Basic",
    price_usd_min: 10,
    price_usd_max: 10,
    summary: "One page: who you are, what you do, how to reach you, opening hours.",
    includes: ["Single page", "Contact details", "Opening hours", "Mobile-friendly", "One round of changes"],
  },
  {
    id: "standard",
    name: "Standard",
    price_usd_min: 20,
    price_usd_max: 100,
    summary: "A full small-business site — sections, a menu or product list, and a working enquiry form.",
    includes: ["Multiple sections", "Menu / product list", "Enquiry or reservation form", "Mobile-friendly", "Two rounds of changes"],
  },
  {
    id: "premium",
    name: "Premium",
    price_usd_min: 120,
    price_usd_max: 150,
    summary: "Several pages with a gallery, a booking system and a map.",
    includes: ["Multiple pages", "Photo gallery", "Booking system", "Google Maps", "Three rounds of changes"],
  },
  {
    id: "enterprise",
    name: "Enterprise B2B",
    price_usd_min: 250,
    price_usd_max: 550,
    summary: "Custom build: booking APIs, payment gateways, a customer portal. Priced on complexity.",
    includes: ["API integrations", "Payment gateway", "Customer portal", "Custom scope", "Priced after a scoping call"],
  },
] as const;

const TIERS_JSON = JSON.stringify(WEBDEV_TIERS);

/**
 * Pick the tier a described job actually falls into, and say what is still unknown.
 *
 * Keyword-scored rather than model-judged on purpose: quoting is the one place a confident wrong
 * answer costs real money, and a deterministic rule the owner can read and correct beats a
 * plausible guess. When the signals are thin it says so instead of defaulting to the cheapest
 * tier — under-quoting is not the safe direction.
 */
const QUOTE = `
const TIERS = ${TIERS_JSON};
const SIGNALS = {
  enterprise: ["api", "integration", "payment gateway", "portal", "login", "dashboard", "crm", "erp", "b2b", "multi-tenant", "subscription"],
  premium: ["booking", "reservation system", "gallery", "map", "multiple pages", "several pages", "calendar", "appointment"],
  standard: ["menu", "products", "form", "contact form", "sections", "about page", "restaurant", "shop", "catalogue", "catalog"],
  basic: ["one page", "single page", "simple", "just my details", "landing page", "opening hours"],
};

export async function run(args, ctx) {
  const brief = String(args.brief || args.description || "").toLowerCase();
  if (!brief.trim()) return { error: "quote-job requires { brief } — what the customer asked for, in their words." };

  const hits = {};
  for (const [tier, words] of Object.entries(SIGNALS)) {
    hits[tier] = words.filter((w) => brief.includes(w));
  }
  // Highest tier with any signal wins: a job mentioning both a menu and a payment gateway is an
  // enterprise job that happens to have a menu, not a standard one.
  const order = ["enterprise", "premium", "standard", "basic"];
  const matched = order.find((t) => hits[t].length > 0) || null;
  const tier = TIERS.find((t) => t.id === matched) || null;

  const unknowns = [];
  if (!/\\b(page|pages)\\b/.test(brief)) unknowns.push("how many pages");
  if (!/(logo|brand|colour|color|photo|image)/.test(brief)) unknowns.push("whether they have logo/photos ready");
  if (!/(domain|hosting|url|website address)/.test(brief)) unknowns.push("whether they already own a domain");

  if (!tier) {
    return {
      confident: false,
      tier: null,
      unknowns,
      next: "Not enough in the brief to price this. Ask what the site needs to DO before quoting — do not guess a tier.",
      tiers: TIERS,
    };
  }
  return {
    confident: hits[matched].length >= 2 && unknowns.length <= 1,
    tier: tier.id,
    tier_name: tier.name,
    price_usd_min: tier.price_usd_min,
    price_usd_max: tier.price_usd_max,
    matched_on: hits[matched],
    unknowns,
    next: unknowns.length
      ? "Quote the range, and ask the open questions before committing to a single number."
      : "Safe to quote a single price at the bottom of this tier's range.",
  };
}`;

/**
 * Turn an accepted job into a build brief the development agent can actually start from.
 *
 * Refuses to produce one when the essentials are missing. A brief that silently invents a business
 * name or a page list produces a site the customer never asked for, and the rework costs more than
 * asking one question up front.
 */
const BUILD_BRIEF = `
export async function run(args, ctx) {
  const required = ["business_name", "tier", "what_they_do"];
  const missing = required.filter((k) => !String(args[k] || "").trim());
  if (missing.length) {
    return {
      ready: false,
      missing,
      next: "Ask the customer for these before starting the build. Do not invent them.",
    };
  }
  const brief = {
    business_name: args.business_name,
    what_they_do: args.what_they_do,
    tier: args.tier,
    pages: args.pages || null,
    sections: args.sections || null,
    contact: args.contact || null,
    hours: args.hours || null,
    assets_supplied: args.assets_supplied || null,
    domain: args.domain || null,
    deadline: args.deadline || null,
    notes: args.notes || null,
  };
  const path = "briefs/" + String(args.business_name).toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".json";
  try {
    await ctx.run("write_file", { path, content: JSON.stringify(brief, null, 2) });
  } catch (e) {
    return { ready: true, brief, saved: false, error: String((e && e.message) || e) };
  }
  return {
    ready: true,
    brief,
    saved: true,
    path,
    next: "Hand this to the Development project. The build agent works from this file, not from the chat.",
  };
}`;

/**
 * Draft an outreach message. DRAFTS ONLY — nothing here can send.
 *
 * Email-first by the owner's explicit choice. Where a phone number is known it produces a
 * click-to-WhatsApp link rather than a message to send: the prospect opening that link is what
 * makes the WhatsApp conversation opted-in under Meta's rules. An agent that cold-messages
 * WhatsApp first is how a number gets banned.
 */
const OUTREACH_DRAFT = `
export async function run(args, ctx) {
  const name = String(args.business_name || "").trim();
  if (!name) return { error: "outreach-draft requires { business_name }. Optionally: what_they_do, gap, contact_email, phone." };
  const gap = String(args.gap || "").trim();
  const what = String(args.what_they_do || "their business").trim();

  const subject = gap
    ? name + " — quick note about your website"
    : "A simple website for " + name;

  const body = [
    "Hi " + (args.contact_name || "there") + ",",
    "",
    "I came across " + name + (gap ? " and noticed " + gap + "." : "."),
    "I build small, fast websites for " + what + " — usually live within a few days.",
    "",
    "Prices start at $10 for a single page with your details and hours, and $20-$100 for a full site with sections, a menu or product list, and an enquiry form.",
    "",
    "If that's useful, just reply and I'll send a couple of examples. If not, no problem at all — reply STOP and I won't contact you again.",
    "",
    (args.sender_name || "—"),
  ].join("\\n");

  const phone = String(args.phone || "").replace(/[^0-9]/g, "");
  // The prospect opens this; we never message them on WhatsApp first. That is what makes the
  // conversation opted-in rather than unsolicited.
  const whatsapp_link = phone
    ? "https://wa.me/" + phone + "?text=" + encodeURIComponent("Hi, I saw your note about a website for " + name)
    : null;

  return {
    drafted: true,
    channel: "email",
    to: args.contact_email || null,
    subject,
    body,
    whatsapp_link,
    opt_out_included: true,
    next: "This is a DRAFT. Add it to the batch for the owner to approve. Do not send from this skill.",
  };
}`;

/**
 * Where every open job stands, read from the Development project's own brief files.
 *
 * Reads real files rather than asking the model to remember — a status report assembled from
 * recollection is the kind that quietly loses a customer.
 */
const PIPELINE_STATUS = `
export async function run(args, ctx) {
  let files = [];
  try {
    const res = await ctx.run("list_files", { prefix: "briefs/" });
    files = (res && (res.files || res.objects)) || [];
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), next: "Could not read the briefs folder — say so rather than reporting an empty pipeline." };
  }
  if (!files.length) {
    return { ok: true, jobs: [], next: "No briefs on file. Either nothing has been sold yet, or briefs are not being written — check before reporting 'no work'." };
  }
  const jobs = [];
  for (const f of files.slice(0, 50)) {
    const path = typeof f === "string" ? f : (f.path || f.key || "");
    if (!path) continue;
    try {
      const read = await ctx.run("read_file", { path });
      const brief = JSON.parse(read.content || read.output || "{}");
      jobs.push({
        business_name: brief.business_name || path,
        tier: brief.tier || null,
        deadline: brief.deadline || null,
        status: brief.status || "in progress",
      });
    } catch {
      jobs.push({ business_name: path, unreadable: true });
    }
  }
  return { ok: true, jobs, count: jobs.length };
}`;

export const LAUNCHPAD_WEBDEV_SKILLS: readonly ScalingSkill[] = [
  {
    name: "quote-job",
    domain: "sales",
    code: QUOTE,
    description:
      "Work out which price tier a described website job falls into ($10 basic / $20-100 standard / " +
      "$120-150 premium / $250-550 enterprise), what it is matching on, and what is still unknown. " +
      "Says it cannot price a thin brief rather than guessing.",
    tags: ["quote", "price", "pricing", "estimate", "tier", "website", "web design", "cost", "how much"],
  },
  {
    name: "build-brief",
    domain: "delivery",
    code: BUILD_BRIEF,
    description:
      "Turn an accepted job into a build brief the development agent works from, saved to the " +
      "project workspace. Refuses when the essentials are missing rather than inventing them.",
    tags: ["brief", "spec", "build", "handoff", "requirements", "website", "start job", "kick off"],
  },
  {
    name: "outreach-draft",
    domain: "sales",
    code: OUTREACH_DRAFT,
    description:
      "Draft a cold-outreach email to a prospective customer, with opt-out wording included and a " +
      "click-to-WhatsApp link the PROSPECT opens. Drafts only — it cannot send.",
    tags: ["outreach", "cold email", "prospect", "lead", "sales", "pitch", "whatsapp", "find customers"],
  },
  {
    name: "pipeline-status",
    domain: "delivery",
    code: PIPELINE_STATUS,
    description:
      "Where every open website job stands, read from the briefs on file rather than from memory.",
    tags: ["pipeline", "status", "jobs", "orders", "progress", "what is in flight", "workload"],
  },
];

/** Seeds the web-studio skills. Same idempotent, best-effort contract as seedScalingSkills. */
export async function seedWebdevSkills(library: SeedableLibrary): Promise<string[]> {
  const created: string[] = [];
  for (const skill of LAUNCHPAD_WEBDEV_SKILLS) {
    try {
      if (await library.exists(skill.name)) continue;
      await library.create({
        name: skill.name,
        code: skill.code.trim(),
        metadata: { description: skill.description, domain: skill.domain, requires_tier: 2, tags: skill.tags },
      });
      created.push(skill.name);
    } catch {
      /* best-effort — one skill failing must not abort provisioning */
    }
  }
  return created;
}
