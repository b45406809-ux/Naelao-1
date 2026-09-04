import type { BusinessBlueprint } from "@naelao/types";

const author = { userId: "naelao", name: "AVOS", royaltyRate: 0.20 };
const goal = (id: string, title: string) => ({ id, title });

/** Canonical Launchpad vertical desks. These are intentionally assistive/HITL templates. */
export const VERTICAL_COWORK_BLUEPRINTS: BusinessBlueprint[] = [
  {
    id: "tpl_lexpulse_legal_v1", title: "Harvey for Law", category: "LEGAL", template_mode: "vertical_cowork", version: "1.0.0", author,
    description: "Corporate M&A and litigation desk for boutique firms and general counsel.",
    cowork_config: { defaultViewport: "DocumentRedlineCanvas", enforceCitationFootnotes: true, auditLogRetentionDays: 365, airGappedModeAvailable: false },
    projects: [
      { name: "Document Studio", slug: "doc_studio", kind: "doc_studio", viewportComponent: "DocumentRedlineCanvas", allowedLadderTiers: [1, 2], plugins: ["knowledge-base", "artifacts"], linterRules: ["delaware-statutory"], initialJournalGoals: [goal("ingest", "Parse commercial leases, deeds, and indemnification matrices")] },
      { name: "Knowledge Vault", slug: "knowledge_vault", kind: "doc_studio", viewportComponent: "DocumentRedlineCanvas", allowedLadderTiers: [1, 2], plugins: ["knowledge-base"], linterRules: ["citation-footnotes"], initialJournalGoals: [goal("index", "Index litigation discovery transcripts in AI Search")] },
      { name: "Regulatory Radar", slug: "regulatory_radar", kind: "growth_engine", viewportComponent: "DocumentRedlineCanvas", allowedLadderTiers: [1, 4], plugins: ["kitesurf", "knowledge-base"], linterRules: ["citation-footnotes"], initialJournalGoals: [goal("monitor", "Monitor state and federal statutory updates")] },
    ], knowledge_seeds: [{ title: "Delaware corporate law", content: "Use primary Delaware statutory sources and cite the controlling section.", category: "legal" }],
  },
  {
    id: "tpl_capforge_pe_v1", title: "Harvey for Finance", category: "FINANCE", template_mode: "vertical_cowork", version: "1.0.0", author,
    description: "Private-equity deal desk for bankers, associates, and fractional CFOs.",
    cowork_config: { defaultViewport: "SpreadsheetFormulaGrid", enforceCitationFootnotes: true, auditLogRetentionDays: 365, airGappedModeAvailable: false },
    projects: [
      { name: "Finance Grid", slug: "finance_grid", kind: "model_studio", viewportComponent: "SpreadsheetFormulaGrid", allowedLadderTiers: [1, 2, 3], plugins: ["formula-engine"], linterRules: ["formula-reference"], initialJournalGoals: [goal("model", "Normalize trailing twelve-month statements and rent rolls")] },
      { name: "SEC RAG", slug: "sec_rag", kind: "doc_studio", viewportComponent: "SpreadsheetFormulaGrid", allowedLadderTiers: [1, 2, 3], plugins: ["knowledge-base", "edgar"], linterRules: ["ebitda-reconciliation"], initialJournalGoals: [goal("edgar", "Ingest 10-K and 10-Q filings")] },
      { name: "Memos", slug: "memos", kind: "doc_studio", viewportComponent: "SpreadsheetFormulaGrid", allowedLadderTiers: [1, 2], plugins: ["artifacts"], linterRules: ["citation-footnotes"], initialJournalGoals: [goal("memo", "Compile the investment memo")] },
    ], knowledge_seeds: [{ title: "Adjusted EBITDA", content: "Reconcile each adjustment to an identifiable source filing or data-room document.", category: "finance" }],
  },
  {
    id: "tpl_clinica_ehr_v1", title: "Harvey for Healthcare", category: "HEALTHCARE", template_mode: "vertical_cowork", version: "1.0.0", author,
    description: "Air-gapped clinical chart and EHR desk for medical practices and care networks.",
    cowork_config: { defaultViewport: "ClinicalSoapEditor", enforceCitationFootnotes: true, auditLogRetentionDays: 365, airGappedModeAvailable: true },
    projects: [
      { name: "Clinical SOAP", slug: "clinical_soap", kind: "doc_studio", viewportComponent: "ClinicalSoapEditor", allowedLadderTiers: [1, 2], plugins: ["pii-scrubber"], linterRules: ["hipaa-pii"], initialJournalGoals: [goal("soap", "Convert faxed clinical material into a SOAP draft")] },
      { name: "Billing Codes", slug: "billing_codes", kind: "model_studio", viewportComponent: "ClinicalSoapEditor", allowedLadderTiers: [1, 2], plugins: ["icd10-cpt"], linterRules: ["clinical-code-match"], initialJournalGoals: [goal("codes", "Match ICD-10 and CPT candidates")] },
      { name: "Pre-Authorization", slug: "pre_auth", kind: "doc_studio", viewportComponent: "ClinicalSoapEditor", allowedLadderTiers: [1, 2], plugins: ["artifacts"], linterRules: ["hipaa-pii"], initialJournalGoals: [goal("appeal", "Draft a prior-authorization appeal")] },
    ], knowledge_seeds: [{ title: "Clinical safety", content: "Drafts require clinician review; never treat generated text as a diagnosis or final chart entry.", category: "healthcare" }],
  },
  {
    id: "tpl_acubuild_const_v1", title: "Harvey for Construction", category: "CONSTRUCTION", template_mode: "vertical_cowork", version: "1.0.0", author,
    description: "Plan specification and permitting desk for contractors, engineers, and commercial builders.",
    cowork_config: { defaultViewport: "PlanSpecCanvas", enforceCitationFootnotes: true, auditLogRetentionDays: 365, airGappedModeAvailable: false },
    projects: [
      { name: "Plan Spec", slug: "plan_spec", kind: "doc_studio", viewportComponent: "PlanSpecCanvas", allowedLadderTiers: [1, 2], plugins: ["plan-inspector"], linterRules: ["drawing-reference"], initialJournalGoals: [goal("spec", "Inspect architectural specifications and amendments")] },
      { name: "Code Compliance", slug: "code_compliance", kind: "doc_studio", viewportComponent: "PlanSpecCanvas", allowedLadderTiers: [1, 2], plugins: ["knowledge-base"], linterRules: ["municipal-citation"], initialJournalGoals: [goal("code", "Index municipal zoning code")] },
      { name: "Bid Matrix", slug: "bid_matrix", kind: "model_studio", viewportComponent: "PlanSpecCanvas", allowedLadderTiers: [1, 2], plugins: ["price-normalizer"], linterRules: ["scope-normalization"], initialJournalGoals: [goal("bids", "Normalize subcontractor RFP prices")] },
    ], knowledge_seeds: [{ title: "Code source policy", content: "Cite the controlling municipal amendment and identify assumptions for every compliance finding.", category: "construction" }],
  },
];

export function getVerticalCoworkBlueprint(id: string): BusinessBlueprint | null {
  return VERTICAL_COWORK_BLUEPRINTS.find((blueprint) => blueprint.id === id) ?? null;
}
