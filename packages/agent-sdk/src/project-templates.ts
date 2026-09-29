import type { BlueprintStarterFile, BlueprintTask, TemplateId, TemplateMode } from "./types.js";

export type ProjectTemplateId =
  | "tpl_proj_contract_redliner"
  | "tpl_proj_financial_valuation"
  | "tpl_proj_b2b_lead_scraper"
  | "tpl_proj_ai_receptionist";

export interface ProjectTemplate {
  id: ProjectTemplateId;
  name: string;
  kind: "doc_studio" | "finance_grid" | "growth_engine" | "voice_agent";
  templateMode: TemplateMode;
  viewport: { component: string; copilotPlacement: "docked" | "side_panel"; canvasPrimary: true; tab: "canvases" };
  agent: { name: string; systemPrompt: string; soul: string };
  tasks: readonly BlueprintTask[];
  starterFiles: readonly BlueprintStarterFile[];
}

const task = (id: string, title: string, dependencies: string[] = []): BlueprintTask => ({ id, title, dependencies, status: "pending" });

export const PROJECT_TEMPLATES: Readonly<Record<ProjectTemplateId, ProjectTemplate>> = Object.freeze({
  tpl_proj_contract_redliner: {
    id: "tpl_proj_contract_redliner", name: "Contract Redliner", kind: "doc_studio", templateMode: "cowork_studio",
    viewport: { component: "DocumentRedlineCanvas", copilotPlacement: "side_panel", canvasPrimary: true, tab: "canvases" },
    agent: { name: "Legal Drafter", systemPrompt: "You are a meticulous legal drafting agent. Identify risk, preserve intent, cite clauses, and never represent output as legal advice.", soul: "Precision over haste. Make every proposed edit traceable to a concrete risk or objective." },
    tasks: [task("intake", "Collect parties, jurisdiction, and negotiation goals"), task("review", "Review and classify contractual risks", ["intake"]), task("redline", "Draft tracked redlines and rationale", ["review"]), task("approve", "Prepare final human review packet", ["redline"])],
    starterFiles: [{ path: "contracts/mutual-nda.md", content: "# Mutual Non-Disclosure Agreement\n\n**Effective date:** [DATE]\n\nThis Mutual Non-Disclosure Agreement is entered into by **[PARTY A]** and **[PARTY B]**. Each party may disclose confidential information solely for evaluating **[PURPOSE]**.\n\n## Obligations\nThe receiving party will protect confidential information with reasonable care and use it only for the Purpose.\n\n## Term\nThese obligations continue for **[TERM]** after disclosure.\n" }],
  },
  tpl_proj_financial_valuation: {
    id: "tpl_proj_financial_valuation", name: "Financial Valuation", kind: "finance_grid", templateMode: "autonomous_operator",
    viewport: { component: "SpreadsheetFormulaGrid", copilotPlacement: "side_panel", canvasPrimary: true, tab: "canvases" },
    agent: { name: "Financial Analyst", systemPrompt: "You are a financial analyst. Build auditable valuation models, label assumptions, reconcile statements, and run sensitivities before conclusions.", soul: "Every number has a source, every formula is inspectable, and uncertainty is explicit." },
    tasks: [task("inputs", "Collect historical financials and assumptions"), task("forecast", "Build operating forecast", ["inputs"]), task("dcf", "Calculate unlevered DCF and terminal value", ["forecast"]), task("sensitivity", "Run WACC and growth sensitivity analysis", ["dcf"])],
    starterFiles: [{ path: "models/dcf.csv", content: "Metric,Year 0,Year 1,Year 2,Year 3,Year 4,Year 5\nRevenue,0,0,0,0,0,0\nEBITDA,0,0,0,0,0,0\nUnlevered FCF,0,0,0,0,0,0\nDiscount Factor,1,0,0,0,0,0\nPV of FCF,0,0,0,0,0,0\n" }],
  },
  tpl_proj_b2b_lead_scraper: {
    id: "tpl_proj_b2b_lead_scraper", name: "B2B Lead Scraper", kind: "growth_engine", templateMode: "autonomous_operator",
    viewport: { component: "GrowthFunnelCanvas", copilotPlacement: "side_panel", canvasPrimary: true, tab: "canvases" },
    agent: { name: "Outbound Agent", systemPrompt: "You are an ethical B2B outbound operator. Honor robots, consent, privacy, suppression lists, and source every lead.", soul: "Relevance and permission beat volume. Preserve provenance for every contact." },
    tasks: [task("icp", "Define ideal customer profile and exclusions"), task("sources", "Approve compliant public data sources", ["icp"]), task("scrape", "Collect and normalize prospect records", ["sources"]), task("qualify", "Score, deduplicate, and prepare outreach queue", ["scrape"])],
    starterFiles: [{ path: "growth/lead-schema.json", content: "{\n  \"fields\": [\"company\", \"domain\", \"contact_name\", \"role\", \"source_url\", \"consent_basis\", \"score\"],\n  \"required\": [\"company\", \"source_url\"]\n}\n" }],
  },
  tpl_proj_ai_receptionist: {
    id: "tpl_proj_ai_receptionist", name: "AI Receptionist", kind: "voice_agent", templateMode: "cowork_studio",
    viewport: { component: "VoiceAgentCanvas", copilotPlacement: "side_panel", canvasPrimary: true, tab: "canvases" },
    agent: { name: "Receptionist", systemPrompt: "You are a courteous business receptionist. Identify caller intent, disclose automation, protect private data, book only verified availability, and escalate uncertainty.", soul: "Make every caller feel heard while never inventing business facts or calendar availability." },
    tasks: [task("profile", "Configure business profile, greeting, and timezone"), task("knowledge", "Load approved FAQs and escalation policy", ["profile"]), task("calendar", "Connect and verify appointment calendar", ["profile"]), task("test", "Run test calls and approve launch", ["knowledge", "calendar"])],
    starterFiles: [{ path: "voice/receptionist-config.json", content: "{\n  \"greeting\": \"Thank you for calling. How may I help?\",\n  \"timezone\": \"UTC\",\n  \"businessHours\": {},\n  \"escalationPolicy\": \"Transfer when requested or when confidence is low.\"\n}\n" }],
  },
});

export function getProjectTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES[id as ProjectTemplateId];
}

export function isProjectTemplateId(id: TemplateId): id is ProjectTemplateId {
  return id.startsWith("tpl_proj_") && id in PROJECT_TEMPLATES;
}
