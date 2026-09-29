import type { BlueprintProject, BlueprintStarterFile, BlueprintTask, TemplateMode, ViewportConfiguration } from "./types.js";

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
  viewport: ViewportConfiguration;
  agentName: string;
  systemPrompt: string;
  tasks: readonly BlueprintTask[];
  starterFiles: readonly BlueprintStarterFile[];
}

const template = (value: ProjectTemplate): ProjectTemplate => Object.freeze(value);

export const PROJECT_TEMPLATES: Readonly<Record<ProjectTemplateId, ProjectTemplate>> = Object.freeze({
  tpl_proj_contract_redliner: template({
    id: "tpl_proj_contract_redliner", name: "Contract Redliner", kind: "doc_studio", templateMode: "autonomous_operator",
    viewport: { component: "DocumentRedlineCanvas", copilotPlacement: "side_panel", canvasPrimary: true, mount: "right_sidebar", tab: "Canvases" },
    agentName: "Legal Drafter", systemPrompt: "You are a meticulous legal drafting agent. Identify material risk, preserve defined terms, explain every proposed change, and never represent that output is legal advice.",
    tasks: [
      { id: "ingest", title: "Ingest and structure the agreement" },
      { id: "risk-review", title: "Review clauses and identify material risks", dependencies: ["ingest"] },
      { id: "redline", title: "Prepare a tracked redline", dependencies: ["risk-review"] },
      { id: "approval", title: "Request human approval of final language", dependencies: ["redline"] },
    ],
    starterFiles: [{ path: "deliverables/starter-nda.md", content: "# Mutual Non-Disclosure Agreement\n\n**Parties:** [Party A] and [Party B]\n\n## Confidential Information\nEach party will protect non-public information disclosed for the Purpose.\n\n## Term\nThese obligations continue for three years after disclosure.\n" }],
  }),
  tpl_proj_financial_valuation: template({
    id: "tpl_proj_financial_valuation", name: "Financial Valuation", kind: "finance_grid", templateMode: "autonomous_operator",
    viewport: { component: "SpreadsheetFormulaGrid", copilotPlacement: "side_panel", canvasPrimary: true, mount: "right_sidebar", tab: "Canvases" },
    agentName: "Financial Analyst", systemPrompt: "You are a rigorous financial analyst. Show assumptions, preserve formula lineage, run sensitivity analysis, and distinguish facts from estimates.",
    tasks: [
      { id: "historicals", title: "Import and normalize historical financials" },
      { id: "forecast", title: "Build operating forecast", dependencies: ["historicals"] },
      { id: "dcf", title: "Calculate discounted cash flow valuation", dependencies: ["forecast"] },
      { id: "sensitivity", title: "Run WACC and terminal-growth sensitivity", dependencies: ["dcf"] },
    ],
    starterFiles: [{ path: "models/dcf-model.csv", content: "Metric,Year 0,Year 1,Year 2,Year 3,Year 4,Year 5\nRevenue,0,0,0,0,0,0\nEBITDA,0,0,0,0,0,0\nFree Cash Flow,0,0,0,0,0,0\nDiscount Factor,1,0,0,0,0,0\nPresent Value,0,0,0,0,0,0\n" }],
  }),
  tpl_proj_b2b_lead_scraper: template({
    id: "tpl_proj_b2b_lead_scraper", name: "B2B Lead Scraper", kind: "growth_engine", templateMode: "autonomous_operator",
    viewport: { component: "GrowthFunnelCanvas", copilotPlacement: "side_panel", canvasPrimary: true, mount: "right_sidebar", tab: "Canvases" },
    agentName: "Outbound Agent", systemPrompt: "You are a compliant B2B outbound agent. Respect robots directives and privacy law, deduplicate prospects, cite sources, and require approval before outreach.",
    tasks: [
      { id: "icp", title: "Define the ideal customer profile" },
      { id: "sources", title: "Configure compliant lead sources", dependencies: ["icp"] },
      { id: "scrape", title: "Collect and normalize lead records", dependencies: ["sources"] },
      { id: "qualify", title: "Score, deduplicate, and review leads", dependencies: ["scrape"] },
    ], starterFiles: [],
  }),
  tpl_proj_ai_receptionist: template({
    id: "tpl_proj_ai_receptionist", name: "AI Receptionist", kind: "voice_agent", templateMode: "autonomous_operator",
    viewport: { component: "VoiceAgentCanvas", copilotPlacement: "side_panel", canvasPrimary: true, mount: "right_sidebar", tab: "Canvases" },
    agentName: "Receptionist", systemPrompt: "You are a courteous business receptionist. Identify caller intent, protect private information, confirm details aloud, and escalate emergencies or uncertainty to a human.",
    tasks: [
      { id: "business-profile", title: "Configure business profile and greeting" },
      { id: "hours", title: "Set business hours and escalation contacts", dependencies: ["business-profile"] },
      { id: "calendar", title: "Connect and test appointment calendar", dependencies: ["hours"] },
      { id: "test-call", title: "Complete an end-to-end test call", dependencies: ["calendar"] },
    ], starterFiles: [],
  }),
});

export function getProjectTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES[id as ProjectTemplateId];
}

export function projectTemplateAsBlueprintProject(definition: ProjectTemplate, name = definition.name): BlueprintProject {
  return { name, kind: definition.kind, templateMode: definition.templateMode, viewports: { ...definition.viewport },
    systemPrompt: definition.systemPrompt, initialTasks: definition.tasks.map(task => ({ ...task, dependencies: [...(task.dependencies ?? [])] })),
    starterFiles: definition.starterFiles.map(file => ({ ...file })) };
}
