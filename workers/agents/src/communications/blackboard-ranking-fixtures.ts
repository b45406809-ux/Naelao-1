import type { SharedProjectCard } from "./blackboard-domain.js";
import type { BlackboardRankingCase } from "./blackboard-ranking-evaluation.js";

export const blackboardRankingCards: SharedProjectCard[] = [
  {
    projectId: "customs",
    summary: "Customs tariff classification and freight clearance",
    capabilities: ["shipment documents", "cross border logistics"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "contracts",
    summary: "Contract review, clause redlines and due diligence",
    capabilities: ["termination", "indemnity", "legal documents"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "clinic-admin",
    summary: "Clinic visit packets, referrals and appointment workflows",
    capabilities: ["approved records", "care coordination"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "coding",
    summary: "Repository code changes, test runs and pull requests",
    capabilities: ["build", "CI", "source control"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "invoices",
    summary: "Invoice extraction and accounts payable reconciliation",
    capabilities: ["vendor bills", "coding suggestions", "close checklist"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "recruiting",
    summary: "Candidate interview scheduling and onboarding checklists",
    capabilities: ["resume intake", "hiring workflow"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "support",
    summary: "Customer support tickets, refunds and escalation follow-up",
    capabilities: ["order issue", "policy response"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "sales",
    summary: "CRM pipeline hygiene, renewals and lead follow-up",
    capabilities: ["sales operations", "account research"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "property",
    summary: "Property leasing, tenant requests and maintenance coordination",
    capabilities: ["lease records", "work orders"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "marketing",
    summary: "Campaign briefs, brand content and publishing review",
    capabilities: ["advertising", "performance reporting"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "procurement",
    summary: "Supplier quotes, purchase requisitions and spend policy",
    capabilities: ["vendor comparison", "approval routing"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "security",
    summary: "Security alerts, incident timelines and vulnerability response",
    capabilities: ["SIEM", "runbooks", "access review"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "research",
    summary: "Research papers, literature reviews and experiment notes",
    capabilities: ["citations", "reproducibility"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "education",
    summary: "Education curriculum, lesson preparation and student assessment",
    capabilities: ["approved learning materials", "tutor workflow"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "logistics",
    summary: "Freight logistics, carrier tracking and shipment exceptions",
    capabilities: ["container status", "route coordination"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    projectId: "finance-research",
    summary:
      "Financial filings and investment research with source-linked memos",
    capabilities: ["company comparison", "market data"],
    evidence: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
];

/** Hand-labeled synthetic intents for harness validation; not customer data or independent labels. */
export const blackboardRankingQueries: Array<
  Pick<BlackboardRankingCase, "id" | "relevantProjectIds"> & { query: string }
> = [
  {
    id: "customs-classification",
    query: "classify tariff documents for a cross-border shipment",
    relevantProjectIds: ["customs"],
  },
  {
    id: "contract-termination",
    query: "find the termination clause and draft contract redlines",
    relevantProjectIds: ["contracts"],
  },
  {
    id: "clinic-referral",
    query: "prepare a clinic visit packet and route a referral",
    relevantProjectIds: ["clinic-admin"],
  },
  {
    id: "repository-tests",
    query: "fix the repository build and run its tests",
    relevantProjectIds: ["coding"],
  },
  {
    id: "invoice-close",
    query: "extract vendor invoices and reconcile accounts payable",
    relevantProjectIds: ["invoices"],
  },
  {
    id: "interview-plan",
    query: "schedule candidate interviews and prepare onboarding",
    relevantProjectIds: ["recruiting"],
  },
  {
    id: "refund-escalation",
    query: "summarize a customer order complaint and draft a refund response",
    relevantProjectIds: ["support"],
  },
  {
    id: "renewal-pipeline",
    query: "research an account and update CRM renewal pipeline notes",
    relevantProjectIds: ["sales"],
  },
  {
    id: "tenant-maintenance",
    query: "triage tenant maintenance requests against the lease",
    relevantProjectIds: ["property"],
  },
  {
    id: "campaign-review",
    query: "write campaign content and prepare a brand publishing review",
    relevantProjectIds: ["marketing"],
  },
  {
    id: "supplier-quotes",
    query: "compare supplier quotes with purchasing approval policy",
    relevantProjectIds: ["procurement"],
  },
  {
    id: "security-incident",
    query: "build an incident timeline from security alerts and runbooks",
    relevantProjectIds: ["security"],
  },
  {
    id: "paper-review",
    query: "summarize research papers with citations and experiment notes",
    relevantProjectIds: ["research"],
  },
  {
    id: "lesson-prep",
    query: "prepare a lesson from the approved curriculum and assess learning",
    relevantProjectIds: ["education"],
  },
  {
    id: "container-delay",
    query: "track a delayed freight container and carrier shipment exception",
    relevantProjectIds: ["logistics"],
  },
  {
    id: "filing-analysis",
    query: "compare company filings and create an investment research memo",
    relevantProjectIds: ["finance-research"],
  },
  {
    id: "legal-vs-finance",
    query: "compare an acquisition agreement with company financial filings",
    relevantProjectIds: ["contracts", "finance-research"],
  },
  {
    id: "support-vs-sales",
    query:
      "draft a response for a customer order issue and check renewal context",
    relevantProjectIds: ["support", "sales"],
  },
  {
    id: "customs-vs-logistics",
    query: "resolve a customs hold using tariff data and carrier status",
    relevantProjectIds: ["customs", "logistics"],
  },
  {
    id: "invoice-vs-procurement",
    query: "match a supplier bill to its purchase quote and requisition",
    relevantProjectIds: ["invoices", "procurement"],
  },
  {
    id: "paraphrase-refund",
    query: "help me get my money back for the damaged item",
    relevantProjectIds: ["support"],
  },
  {
    id: "paraphrase-contract-exit",
    query: "can the signed deal be ended early under its terms",
    relevantProjectIds: ["contracts"],
  },
  {
    id: "paraphrase-hiring",
    query: "screen a new hire before the first day",
    relevantProjectIds: ["recruiting"],
  },
  {
    id: "paraphrase-maintenance",
    query: "the building manager needs to fix a resident's broken tap",
    relevantProjectIds: ["property"],
  },
  {
    id: "paraphrase-import-duty",
    query: "find the public authority's import duty code",
    relevantProjectIds: ["customs"],
  },
  {
    id: "paraphrase-clinical-prep",
    query: "get the specialist ready for a patient's upcoming consultation",
    relevantProjectIds: ["clinic-admin"],
  },
  {
    id: "paraphrase-learning",
    query: "help a learner prepare tomorrow's school topic",
    relevantProjectIds: ["education"],
  },
  {
    id: "paraphrase-cyber",
    query:
      "possible intrusion: account compromised; assemble sequence of events",
    relevantProjectIds: ["security"],
  },
];
