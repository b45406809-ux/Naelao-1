/**
 * Project templates — no-code presets a builder (or the Space Assistant) can stamp onto a
 * project in one call. "The builder/assistant configures a project ... a template is the
 * starting point so the builder only edits form fields, never writes code."
 *
 * Distinct from Launchpad SpaceType templates (launchpad/spacetype.ts): a SpaceType template
 * configures an entire SPACE at provisioning time; a project template configures ONE PROJECT
 * within an already-existing space (e.g. a Whop-seller space adding a "Support WhatsApp Bot"
 * project alongside its existing Members/Support/Content projects, or a community space adding
 * a "Member Monitoring" project).
 *
 * Originally scoped to customer-facing bot projects only (kind: customer_bot). Generalized to
 * cover any project kind — a template is just a named bundle of the same knobs a builder could
 * set by hand (kind, execution ceiling, spend cap, thread cap, agent binding/allowlist, seeded
 * no-code rules, seeded scheduled jobs). "Imagine a whole community business template — you get
 * a preconfigured 'user monitoring' project" is exactly the kind: 'workspace' + scheduled_jobs
 * case below (`community-member-monitoring`), sitting alongside the original customer_bot
 * presets — same catalog, same application path (POST /projects/from-template), no new kind of
 * enforcement code needed.
 */

import type { ChannelType } from "./channels.js";
import type { ProjectLifecycle } from "@naelao/types";

export interface ProjectRuleSeed {
  trigger_pattern: string;
  action: "reply" | "run_script" | "human_takeover";
  reply_text?: string;
  script_name?: string;
  priority: number;
}

/** A cron-scheduled op the template seeds into scheduled_jobs (spec §05 cron-jobs.json), scoped
 *  to the project it's applied to. Deterministic, no-LLM dispatch — see A1.16.7/A1.16.13. */
export interface ScheduledJobSeed {
  name: string;
  cron_expression: string;
  script_name: string;
  params?: Record<string, unknown>;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  /** Which project kind this template configures (e.g. 'customer_bot', 'workspace', 'product_dev', 'contract_redline', etc.) */
  kind: string;
  /** Project lifecycle: 'finite' for task-oriented projects (which hibernate after all tasks complete) vs 'continuous' for 24/7 standing desks & scheduled monitors */
  lifecycle?: ProjectLifecycle;
  /** customer_bot templates only — which channel this project is meant to connect to. */
  suggested_channel?: ChannelType;
  /** Execution ladder ceiling. Customer-facing bots use restricted lower tiers (Tier 1-3) to avoid security threats from untrusted external user input. */
  execution_ceiling: 1 | 2 | 3 | 4 | 5;
  daily_spend_cap_credits: number;
  /** 0/omitted = unlimited real conversations in this project */
  max_threads?: number;
  /** Which agent this project's runs default to. */
  default_agent_id?: string;
  /** The thread-level "switch agent" allowlist. Omitted/empty = unrestricted. */
  allowed_agent_ids?: string[];
  /** Prebuilt plugins/scripts enabled for this project template */
  plugins?: string[];
  /** No-code "after the customer says X, this happens" rules — reactive triggers. */
  rules?: ProjectRuleSeed[];
  /** Cron-scheduled ops seeded into this project on template application. */
  scheduled_jobs?: ScheduledJobSeed[];
}

// Baseline compliance rules every customer-bot template includes (highest priority — checked
// first). STOP/unsubscribe is a WhatsApp Business Platform requirement, not just good practice.
const BASELINE_RULES: ProjectRuleSeed[] = [
  { trigger_pattern: "STOP", action: "reply", reply_text: "You've been unsubscribed and won't receive further messages. Reply START to resubscribe.", priority: 1000 },
  { trigger_pattern: "UNSUBSCRIBE", action: "reply", reply_text: "You've been unsubscribed and won't receive further messages. Reply START to resubscribe.", priority: 1000 },
  { trigger_pattern: "talk to a human", action: "human_takeover", priority: 900 },
  { trigger_pattern: "speak to a person", action: "human_takeover", priority: 900 },
];

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  // ── Customer Service & Inbound Bot Projects (Continuous 24/7 Standing Desks: Tier 1-3) ──
  {
    id: "whatsapp-support-bot",
    name: "WhatsApp Support Desk",
    description: "Answers customer inquiries 24/7 on your WhatsApp Business number. Read-only in-memory RAG by default — talks and looks up FAQs/orders, never touches arbitrary external code.",
    kind: "customer_bot",
    lifecycle: "continuous",
    suggested_channel: "whatsapp",
    execution_ceiling: 2,
    daily_spend_cap_credits: 2000,
    plugins: ["knowledge-base", "notifications"],
    rules: [
      ...BASELINE_RULES,
      { trigger_pattern: "hours", action: "reply", reply_text: "We're open Monday-Friday, 9am-5pm. We'll reply to your message as soon as we're back.", priority: 10 },
      { trigger_pattern: "hi", action: "reply", reply_text: "Hi! Thanks for reaching out — how can we help you today?", priority: 1 },
    ],
  },
  {
    id: "telegram-receptionist-bot",
    name: "Telegram Sales & Inquiries Receptionist",
    description: "Inbound Telegram bot that qualifies leads, answers service FAQs, and books discovery calls.",
    kind: "customer_bot",
    lifecycle: "continuous",
    suggested_channel: "telegram",
    execution_ceiling: 2,
    daily_spend_cap_credits: 2000,
    plugins: ["knowledge-base", "notifications"],
    rules: [
      ...BASELINE_RULES,
      { trigger_pattern: "pricing", action: "reply", reply_text: "You can view our published service packages and transparent pricing on our storefront.", priority: 10 },
      { trigger_pattern: "start", action: "reply", reply_text: "Welcome! Tell us what you're looking for, or ask any question about our services.", priority: 1 },
    ],
  },
  {
    id: "discord-community-bot",
    name: "Discord Community Moderator & FAQ Bot",
    description: "Answers member questions in your Discord server, routes support requests, and flags rule violations.",
    kind: "customer_bot",
    lifecycle: "continuous",
    suggested_channel: "discord",
    execution_ceiling: 2,
    daily_spend_cap_credits: 2000,
    plugins: ["knowledge-base", "notifications"],
    rules: [
      { trigger_pattern: "talk to a human", action: "human_takeover", priority: 900 },
      { trigger_pattern: "speak to a person", action: "human_takeover", priority: 900 },
      { trigger_pattern: "rules", action: "reply", reply_text: "Check the #rules channel for our community guidelines.", priority: 10 },
    ],
  },
  {
    id: "email-support-bot",
    name: "Email Support Triaging Desk",
    description: "Drafts grounded replies to inbound support emails and categorizes tickets with SLA tags.",
    kind: "customer_bot",
    lifecycle: "continuous",
    suggested_channel: "email",
    execution_ceiling: 3,
    daily_spend_cap_credits: 3000,
    plugins: ["business-email", "knowledge-base"],
    rules: BASELINE_RULES,
  },

  // ── Product Development & Edge IDE Projects (Finite Goal Cycles: Tier 5 Full Sandbox Execution) ──
  {
    id: "edge-web-ide",
    name: "Astro + Tailwind Edge Web IDE",
    description: "Full-stack web application development studio with live visual canvas preview and surgical search-and-replace patching.",
    kind: "product_dev",
    lifecycle: "finite",
    execution_ceiling: 5,
    daily_spend_cap_credits: 5000,
    plugins: ["r2-workspace", "file-manager", "code-exec", "workspace", "browser-use"],
  },
  {
    id: "api-microservice-dev",
    name: "TypeScript Worker & Microservice Suite",
    description: "Cloudflare Worker & REST API microservice studio with TypeScript typechecking and automated integration tests.",
    kind: "product_dev",
    lifecycle: "finite",
    execution_ceiling: 5,
    daily_spend_cap_credits: 5000,
    plugins: ["r2-workspace", "file-manager", "code-exec", "workspace"],
  },

  // ── Vertical Cowork & Legal/Finance/Health Studios (Finite Goal Cycles: Tier 2-3 Precision Work) ──
  {
    id: "inbound-nda-scanner",
    name: "Inbound NDA & Contract Redline Studio",
    description: "Instant contract redlining, indemnity clause risk detection, and clause-by-clause diffing with statutory citations.",
    kind: "contract_redline",
    lifecycle: "finite",
    execution_ceiling: 2,
    daily_spend_cap_credits: 3000,
    plugins: ["knowledge-base", "file-manager", "artifacts"],
  },
  {
    id: "deposition-cross-examiner",
    name: "Litigation Discovery & Deposition Cross-Examiner",
    description: "Cross-references deposition transcripts and court filings with exact transcript line number semantic grounding.",
    kind: "litigation_discovery",
    lifecycle: "finite",
    execution_ceiling: 2,
    daily_spend_cap_credits: 3000,
    plugins: ["knowledge-base", "file-manager", "web-search"],
  },
  {
    id: "edgar-10k-reconciler",
    name: "SEC 10-K & Financial RAG Studio",
    description: "EDGAR filing deep-RAG, footnote extraction, EBITDA reconciliation, and valuation comps formula grids.",
    kind: "sec_rag",
    lifecycle: "finite",
    execution_ceiling: 3,
    daily_spend_cap_credits: 4000,
    plugins: ["web-search", "knowledge-base", "artifacts", "file-manager"],
  },
  {
    id: "pe-investment-memo",
    name: "Private Equity Investment Memo & Comps",
    description: "Automated investment committee memos, valuation multiples, and deal thesis modeling with dynamic calculations.",
    kind: "memo_studio",
    lifecycle: "finite",
    execution_ceiling: 3,
    daily_spend_cap_credits: 4000,
    plugins: ["knowledge-base", "artifacts", "file-manager"],
  },
  {
    id: "clinical-soap-generator",
    name: "Clinical SOAP Notes & EHR Studio",
    description: "Voice and encounter transcripts converted into structured SOAP clinical documentation with HIPAA PII sanitization.",
    kind: "soap_notes",
    lifecycle: "finite",
    execution_ceiling: 2,
    daily_spend_cap_credits: 3000,
    plugins: ["knowledge-base", "file-manager", "artifacts"],
  },
  {
    id: "chart-to-icd10-preauth",
    name: "Medical Billing ICD-10 & Pre-Auth Appeals",
    description: "Chart-to-code ICD-10/CPT suggestion engine and insurer pre-authorization appeal letter generator.",
    kind: "billing_icd10",
    lifecycle: "finite",
    execution_ceiling: 2,
    daily_spend_cap_credits: 3000,
    plugins: ["knowledge-base", "artifacts"],
  },
  {
    id: "ibc-ada-code-auditor",
    name: "Building Code & Plan Compliance Inspector",
    description: "IBC, ADA, and local municipal zoning code verification for architectural drawings and specifications.",
    kind: "building_code_rag",
    lifecycle: "finite",
    execution_ceiling: 2,
    daily_spend_cap_credits: 3000,
    plugins: ["knowledge-base", "file-manager", "artifacts"],
  },
  {
    id: "bid-leveling-matrix",
    name: "Subcontractor RFP & Bid Leveling Matrix",
    description: "Bid leveling comparison matrices, subcontractor scope tracking, and change order variance audits.",
    kind: "subcontractor_rfp",
    lifecycle: "finite",
    execution_ceiling: 2,
    daily_spend_cap_credits: 3000,
    plugins: ["file-manager", "artifacts", "knowledge-base"],
  },

  // ── Business Operations & Growth Kinds (Continuous 24/7 Standing Desks) ──
  {
    id: "b2b-pipeline-tracker",
    name: "B2B Sales CRM & Pipeline Tracker",
    description: "High-touch deals pipeline, lead enrichment, contact stages, and follow-up reminders.",
    kind: "crm",
    lifecycle: "continuous",
    execution_ceiling: 2,
    daily_spend_cap_credits: 2000,
    plugins: ["knowledge-base", "notifications"],
  },
  {
    id: "sla-ticket-desk",
    name: "Support Tickets & SLA Queue",
    description: "Centralized support ticketing queue with automated SLA timers and agent assignment.",
    kind: "support_inbox",
    lifecycle: "continuous",
    execution_ceiling: 2,
    daily_spend_cap_credits: 2000,
    plugins: ["knowledge-base", "notifications"],
  },
  {
    id: "ai-triaged-inbox",
    name: "AI-Triaged Mailbox",
    description: "A provisioned business mailbox with autonomous inbound email triaging, draft generation, and spam defense.",
    kind: "business_email",
    lifecycle: "continuous",
    execution_ceiling: 2,
    daily_spend_cap_credits: 2000,
    plugins: ["business-email"],
  },
  {
    id: "digital-product-catalog",
    name: "Storefront & Digital Product Catalog",
    description: "Sell digital downloads, licenses, and services directly with instant fulfillment and checkout integration.",
    kind: "storefront",
    lifecycle: "continuous",
    execution_ceiling: 2,
    daily_spend_cap_credits: 2000,
  },

  // ── Enterprise Fine-Tuning & Auto-Researcher Studios (Finite Goal Cycles: model_studio) ──
  {
    id: "support-lora-distiller",
    name: "Support Desk Knowledge Distiller & Fine-Tuner",
    description: "Converts customer service tickets and FAQ documentation into synthetic JSONL pairs and fine-tunes a dedicated edge LoRA support model.",
    kind: "model_studio",
    lifecycle: "finite",
    execution_ceiling: 5,
    daily_spend_cap_credits: 5000,
    plugins: ["file-manager", "artifacts", "knowledge-base", "code-exec"],
  },
  {
    id: "legal-lora-specialist",
    name: "Legal & Contract Clause Specialist",
    description: "Trains an 8B edge model to recognize non-standard liability terms, indemnity clauses, and risk exceptions from past negotiated redlines.",
    kind: "model_studio",
    lifecycle: "finite",
    execution_ceiling: 5,
    daily_spend_cap_credits: 5000,
    plugins: ["file-manager", "artifacts", "knowledge-base", "code-exec"],
  },
  {
    id: "api-codebase-lora",
    name: "Internal API & SDK Codebase Assistant",
    description: "Ingests internal engineering documentation and TypeScript SDKs to fine-tune an internal developer autocomplete copilot.",
    kind: "model_studio",
    lifecycle: "finite",
    execution_ceiling: 5,
    daily_spend_cap_credits: 5000,
    plugins: ["file-manager", "artifacts", "knowledge-base", "code-exec", "workspace"],
  },

  // ── Workspace-kind templates — schedule/observation-driven (Continuous) ──
  {
    id: "community-member-monitoring",
    name: "Community Member Monitoring",
    description:
      "A weekly check-in on your community: the support agent reviews activity and pings you " +
      "with anything worth knowing. Runs on a schedule, not in reaction to inbound messages.",
    kind: "workspace",
    lifecycle: "continuous",
    execution_ceiling: 2,
    daily_spend_cap_credits: 1000,
    default_agent_id: "launchpad-support-v1",
    allowed_agent_ids: ["launchpad-support-v1", "naelao-agent"],
    scheduled_jobs: [
      {
        name: "Weekly community digest",
        cron_expression: "0 9 * * 1",
        script_name: "notifications.notify",
        params: { message: "Weekly community check-in: review activity and flag anything that needs attention." },
      },
    ],
  },
  {
    id: "daily-seo-content-engine",
    name: "Daily Programmatic SEO Content Engine",
    description: "Daily automated search keyword research, competitor gap analysis, and draft article generation.",
    kind: "workspace",
    lifecycle: "continuous",
    execution_ceiling: 3,
    daily_spend_cap_credits: 3000,
    plugins: ["web-search", "artifacts", "file-manager"],
    scheduled_jobs: [
      {
        name: "Daily keyword scrape & article draft",
        cron_expression: "0 6 * * *",
        script_name: "web-search.search",
        params: { query: "trending industry keywords and search queries" },
      },
    ],
  },
  {
    id: "scheduled-lead-scraper",
    name: "B2B Lead Finder & Verification Engine",
    description: "Scheduled lead enrichment, finding verified company contacts and syncing them into the deal pipeline.",
    kind: "workspace",
    lifecycle: "continuous",
    execution_ceiling: 3,
    daily_spend_cap_credits: 3000,
    plugins: ["web-search", "knowledge-base"],
    scheduled_jobs: [
      {
        name: "Bi-weekly lead sourcing pass",
        cron_expression: "0 8 * * 2,4",
        script_name: "web-search.search",
        params: { query: "new prospect companies and decision makers" },
      },
    ],
  },
];

export function getProjectTemplate(id: string): ProjectTemplate | null {
  return PROJECT_TEMPLATES.find((t) => t.id === id) ?? null;
}

/**
 * Determine default lifecycle for a given template ID or project kind.
 * Customer bots and workspace monitors run continuously; build/redline/audit studios run finite cycles.
 */
export function getProjectLifecycle(templateIdOrKind?: string): ProjectLifecycle {
  if (!templateIdOrKind) return "finite";
  const template = getProjectTemplate(templateIdOrKind);
  if (template?.lifecycle) return template.lifecycle;
  const continuousKinds = new Set(["customer_bot", "crm", "support_inbox", "business_email", "storefront"]);
  if (continuousKinds.has(templateIdOrKind)) return "continuous";
  return "finite";
}

/**
 * Validate the catalogue: every template is a complete, safe, internally-consistent starting
 * point (spec framing: "no required follow-up edits before it's usable"). Throws on a
 * structural error (called at module load to fail fast) — same pattern as
 * launchpad/spacetype.ts's validateLaunchpadSpaceType.
 */
export function validateProjectTemplates(templates: ProjectTemplate[] = PROJECT_TEMPLATES): void {
  const seen = new Set<string>();
  for (const t of templates) {
    if (seen.has(t.id)) throw new Error(`Project template: duplicate id '${t.id}'`);
    seen.add(t.id);

    if (t.execution_ceiling < 1 || t.execution_ceiling > 5) {
      throw new Error(`Project template '${t.id}': execution_ceiling must be 1-5`);
    }
    if (t.daily_spend_cap_credits <= 0) {
      throw new Error(`Project template '${t.id}': daily_spend_cap_credits must be > 0 (no runaway-bill template)`);
    }
    if (t.kind === "customer_bot" && !t.suggested_channel) {
      throw new Error(`Project template '${t.id}': kind 'customer_bot' requires suggested_channel`);
    }
    if (t.default_agent_id && t.allowed_agent_ids && t.allowed_agent_ids.length > 0 && !t.allowed_agent_ids.includes(t.default_agent_id)) {
      throw new Error(`Project template '${t.id}': default_agent_id '${t.default_agent_id}' must be included in allowed_agent_ids`);
    }
    for (const r of t.rules ?? []) {
      if (r.action === "reply" && !r.reply_text) {
        throw new Error(`Project template '${t.id}': a 'reply' rule requires reply_text`);
      }
      if (r.action === "run_script" && !r.script_name) {
        throw new Error(`Project template '${t.id}': a 'run_script' rule requires script_name`);
      }
    }
  }
}

// Fail fast at import if the catalogue is malformed.
validateProjectTemplates();
