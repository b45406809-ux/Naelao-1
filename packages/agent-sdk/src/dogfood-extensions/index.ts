import type { ExtensionManifest } from "../extensions.js";

export type FirstPartyExtensionMaturity = "anchor" | "reference";

export interface FirstPartyExtensionCatalogEntry {
  manifest: ExtensionManifest;
  /** Only anchors may be presented as first-party commercial products. */
  maturity: FirstPartyExtensionMaturity;
  productClaim: "commercial_anchor" | "reference_implementation";
  graduation?: ExtensionGraduationDossier;
}

export interface ExtensionGraduationDossier {
  status: "draft" | "approved";
  domainTestPlan: string;
  securityReview: string;
  migrationPolicy: string;
  operationalSlo: string;
}

/** A commercial anchor is not automatically a full SaaS replacement. */
export function isSaasReplacementEligible(entry: FirstPartyExtensionCatalogEntry): boolean {
  const dossier = entry.graduation;
  return dossier?.status === "approved" && [
    dossier.domainTestPlan,
    dossier.securityReview,
    dossier.migrationPolicy,
    dossier.operationalSlo,
  ].every((reference) => reference.trim().length > 0);
}

const facet = (id: string, name: string, schema: string, permissions: string[], daemon?: { script: string; schedule?: string }): ExtensionManifest => ({
  id: id as `ext_${string}`,
  type: "extension",
  declaredPermissions: permissions,
  capabilityRequirements: permissions,
  gadgets: [{ id: `${id.slice(4)}_facet`, name, viewportComponent: `./${id}/viewport.ts`, scope: "PROJECT_BOUND", gadgetTier: 2, defaultSchemaSql: schema }],
  daemons: daemon ? [{ id: `${id.slice(4)}_daemon`, name: `${name} automation`, workflowScript: `./${id}/${daemon.script}.ts`, ...(daemon.schedule ? { schedule: daemon.schedule } : {}), memoryScope: "PROJECT_BOUND" }] : [],
  commands: [{ name: `ext:${id.slice(4)}`, scriptPath: `./${id}/command.ts` }],
});

const entry = (manifest: ExtensionManifest, maturity: FirstPartyExtensionMaturity): FirstPartyExtensionCatalogEntry => Object.freeze({
  manifest,
  maturity,
  productClaim: maturity === "anchor" ? "commercial_anchor" : "reference_implementation",
});

export const DOGFOOD_EXTENSION_CATALOG = Object.freeze([
  entry({ id: "ext_lsp_indexer", type: "extension", declaredPermissions: ["repo.read", "facet.sqlite.read", "facet.sqlite.write"],
    capabilityRequirements: ["repo.read", "facet.sqlite.read", "facet.sqlite.write"], gadgets: [], daemons: [],
    commands: [{ name: "lsp", scriptPath: "./ext_lsp_indexer/command.ts" }] }, "reference"),
  entry(facet("ext_ledger_core", "Double-entry ledger", `CREATE TABLE IF NOT EXISTS ledger_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ledger_entries(id TEXT PRIMARY KEY,debit_account TEXT NOT NULL,credit_account TEXT NOT NULL,amount_minor INTEGER NOT NULL CHECK(amount_minor>0),currency TEXT NOT NULL,created_at TEXT NOT NULL);`, ["facet.sqlite.read", "facet.sqlite.write", "mcp.expose"]), "reference"),
  entry(facet("ext_crm_core", "CRM pipeline", `CREATE TABLE IF NOT EXISTS crm_leads(id TEXT PRIMARY KEY,name TEXT NOT NULL,stage TEXT NOT NULL,jev_score REAL NOT NULL DEFAULT 0,scored_at TEXT);`, ["facet.sqlite.read", "facet.sqlite.write", "workflow.execute"], { script: "score-leads", schedule: "*/5 * * * *" }), "anchor"),
  entry(facet("ext_esign_core", "Electronic signatures", `CREATE TABLE IF NOT EXISTS esign_documents(id TEXT PRIMARY KEY,pdf_sha256 TEXT NOT NULL UNIQUE,artifact_commit TEXT NOT NULL,signed_at TEXT);`, ["facet.sqlite.read", "facet.sqlite.write", "artifact.git.write", "crypto.sha256"]), "anchor"),
  entry(facet("ext_omnichannel_inbox", "Omnichannel inbox", `CREATE TABLE IF NOT EXISTS inbox_events(id TEXT PRIMARY KEY,channel TEXT NOT NULL CHECK(channel IN ('whatsapp','telegram','email')),external_id TEXT NOT NULL,payload_json TEXT NOT NULL,occurred_at TEXT NOT NULL);`, ["facet.sqlite.read", "facet.sqlite.write", "channel.receive", "channel.send"]), "reference"),
  entry(facet("ext_commerce_hub", "Commerce hub", `CREATE TABLE IF NOT EXISTS inventory(sku TEXT PRIMARY KEY,quantity INTEGER NOT NULL CHECK(quantity>=0)); CREATE TABLE IF NOT EXISTS fulfillments(id TEXT PRIMARY KEY,sku TEXT NOT NULL,label_artifact TEXT,status TEXT NOT NULL);`, ["facet.sqlite.read", "facet.sqlite.write", "commerce.orders.read", "fulfillment.labels.write"], { script: "fulfill-orders" }), "reference"),
  entry(facet("ext_payroll_core", "Partner payroll", `CREATE TABLE IF NOT EXISTS royalty_disbursements(id TEXT PRIMARY KEY,partner_id TEXT NOT NULL,period TEXT NOT NULL,amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),approval_id TEXT,status TEXT NOT NULL);`, ["facet.sqlite.read", "facet.sqlite.write", "workflow.class1.execute", "payments.disburse"], { script: "monthly-royalties", schedule: "0 0 1 * *" }), "reference"),
] satisfies readonly FirstPartyExtensionCatalogEntry[]);

export const DOGFOOD_EXTENSIONS = Object.freeze(DOGFOOD_EXTENSION_CATALOG.map((item) => item.manifest));

export const ANCHOR_DOGFOOD_EXTENSIONS = Object.freeze(DOGFOOD_EXTENSION_CATALOG.filter((item) => item.maturity === "anchor").map((item) => item.manifest));

export const DOGFOOD_EXTENSION_BY_ID = Object.freeze(Object.fromEntries(DOGFOOD_EXTENSIONS.map(manifest => [manifest.id, manifest])) as Readonly<Record<string, ExtensionManifest>>);
