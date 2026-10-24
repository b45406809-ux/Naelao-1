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

const spaceFacet = (id: string, name: string, schema: string, permissions: string[], migrations: NonNullable<ExtensionManifest["gadgets"][number]["migrations"]> = []): ExtensionManifest => ({
  id: id as `ext_${string}`,
  type: "extension",
  declaredPermissions: permissions,
  capabilityRequirements: permissions,
  gadgets: [{ id: `${id.slice(4)}_facet`, name, viewportComponent: `./${id}/viewport.ts`, scope: "SPACE_SHARED", gadgetTier: 3, defaultSchemaSql: schema, migrations }],
  daemons: [],
  commands: [{ name: `ext:${id.slice(4)}`, scriptPath: `./${id}/command.ts` }],
});

const entry = (manifest: ExtensionManifest, maturity: FirstPartyExtensionMaturity): FirstPartyExtensionCatalogEntry => Object.freeze({
  manifest: Object.freeze({ ...manifest, releaseVersion: manifest.releaseVersion ?? "1.0.0" }),
  maturity,
  productClaim: maturity === "anchor" ? "commercial_anchor" : "reference_implementation",
});

export const DOGFOOD_EXTENSION_CATALOG = Object.freeze([
  entry({ id: "ext_lsp_indexer", type: "extension", declaredPermissions: ["repo.read", "facet.sqlite.read", "facet.sqlite.write"],
    capabilityRequirements: ["repo.read", "facet.sqlite.read", "facet.sqlite.write"], gadgets: [], daemons: [],
    commands: [{ name: "lsp", scriptPath: "./ext_lsp_indexer/command.ts" }] }, "reference"),
  entry(spaceFacet("ext_foundry_catalog", "Foundry Template Catalog", `
    CREATE TABLE IF NOT EXISTS foundry_products (
      product_id TEXT PRIMARY KEY,
      studio_project_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','building','in_review','published','suspended','retired')),
      marketplace_listing_id TEXT,
      current_version TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS foundry_product_releases (
      product_id TEXT NOT NULL REFERENCES foundry_products(product_id),
      version TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      conformance_certificate_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('draft','certified','published','withdrawn')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(product_id, version)
    );`, ["facet.sqlite.read", "facet.sqlite.write", "blueprint.export", "blueprint.status", "marketplace.graduate"], [{ version: 1, description: "Add product summary text", up: "ALTER TABLE foundry_products ADD COLUMN description TEXT NOT NULL DEFAULT ''" }]), "reference"),
  entry(facet("ext_ledger_core", "Double-entry ledger", `CREATE TABLE IF NOT EXISTS ledger_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ledger_entries(id TEXT PRIMARY KEY,debit_account TEXT NOT NULL,credit_account TEXT NOT NULL,amount_minor INTEGER NOT NULL CHECK(amount_minor>0),currency TEXT NOT NULL,created_at TEXT NOT NULL);`, ["facet.sqlite.read", "facet.sqlite.write", "mcp.expose"]), "reference"),
  entry(facet("ext_crm_core", "CRM pipeline", `CREATE TABLE IF NOT EXISTS crm_leads(id TEXT PRIMARY KEY,name TEXT NOT NULL,stage TEXT NOT NULL,jev_score REAL NOT NULL DEFAULT 0,scored_at TEXT);`, ["facet.sqlite.read", "facet.sqlite.write", "workflow.execute"], { script: "score-leads", schedule: "*/5 * * * *" }), "anchor"),
  entry(facet("ext_esign_core", "Electronic signatures", `CREATE TABLE IF NOT EXISTS esign_documents(id TEXT PRIMARY KEY,pdf_sha256 TEXT NOT NULL UNIQUE,artifact_commit TEXT NOT NULL,signed_at TEXT);`, ["facet.sqlite.read", "facet.sqlite.write", "artifact.git.write", "crypto.sha256"]), "anchor"),
  entry(facet("ext_omnichannel_inbox", "Omnichannel inbox", `CREATE TABLE IF NOT EXISTS inbox_events(id TEXT PRIMARY KEY,channel TEXT NOT NULL CHECK(channel IN ('whatsapp','telegram','email')),external_id TEXT NOT NULL,payload_json TEXT NOT NULL,occurred_at TEXT NOT NULL);`, ["facet.sqlite.read", "facet.sqlite.write", "channel.receive", "channel.send"]), "reference"),
  entry(facet("ext_commerce_hub", "Commerce hub", `CREATE TABLE IF NOT EXISTS inventory(sku TEXT PRIMARY KEY,quantity INTEGER NOT NULL CHECK(quantity>=0)); CREATE TABLE IF NOT EXISTS fulfillments(id TEXT PRIMARY KEY,sku TEXT NOT NULL,label_artifact TEXT,status TEXT NOT NULL);`, ["facet.sqlite.read", "facet.sqlite.write", "commerce.orders.read", "fulfillment.labels.write"], { script: "fulfill-orders" }), "reference"),
  entry(facet("ext_payroll_core", "Partner payroll", `CREATE TABLE IF NOT EXISTS royalty_disbursements(id TEXT PRIMARY KEY,partner_id TEXT NOT NULL,period TEXT NOT NULL,amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),approval_id TEXT,status TEXT NOT NULL);`, ["facet.sqlite.read", "facet.sqlite.write", "workflow.class1.execute", "payments.disburse"], { script: "monthly-royalties", schedule: "0 0 1 * *" }), "reference"),
] satisfies readonly FirstPartyExtensionCatalogEntry[]);

export const DOGFOOD_EXTENSIONS = Object.freeze(DOGFOOD_EXTENSION_CATALOG.map((item) => item.manifest));

/** First-party UI artifacts are shipped with their extension contract and mounted by the generic
 * Space-shared extension runtime. The frame can only reach host-whitelisted scoped RPC methods. */
export const DOGFOOD_EXTENSION_CANVASES: Readonly<Record<string, string>> = Object.freeze({
  ext_foundry_catalog: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Template Catalog</title><style>body{font:14px system-ui;color:#202124;margin:0;padding:24px;background:#f7f8fa}h1{font-size:22px;margin:0 0 6px}.muted{color:#68707d}.row{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}input,textarea{font:inherit;padding:9px;border:1px solid #ccd1da;border-radius:6px}input{min-width:220px}textarea{width:100%;min-height:64px}button{font:inherit;padding:9px 13px;border:0;border-radius:6px;background:#4257d6;color:white;cursor:pointer}.card{background:white;border:1px solid #e0e3e8;border-radius:8px;padding:14px;margin:10px 0}.status{font-size:12px;color:#68707d}#notice{min-height:20px}details{background:white;border:1px solid #e0e3e8;border-radius:8px;padding:14px;margin-top:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>Template products</h1><div class="muted">Create a product record linked to its Studio project. Publishing runs a tenant-owned Space export, the real state-delta conformance suite, and Naelao's certificate and marketplace graduation checks.</div><form id="new"><div class="row"><input name="name" maxlength="120" placeholder="Template product name" required><input name="project" maxlength="128" placeholder="Studio project ID" required></div><textarea name="description" maxlength="1000" placeholder="Customer problem and outcome"></textarea><div class="row"><button>Save draft</button><button type="button" id="reload">Refresh</button></div></form><p id="notice" class="status" role="status"></p><section id="items"></section><details><summary>Export, test, and publish this Space Template</summary><p class="muted">Choose one Studio project to export. Only that project and explicitly selected installed extensions enter its customer blueprint. Add a JavaScript/TypeScript conformance entry and at least 50 independent fixtures. The host rejects incomplete or failing suites; publishing also requires the tenant-owned export certificate.</p><div class="row"><input id="project-id" placeholder="Selected Studio project ID" required><input id="listing-name" placeholder="Customer listing name" maxlength="160" required></div><textarea id="listing-description" maxlength="2000" placeholder="Customer listing description"></textarea><label>Required installed extension IDs as JSON<textarea id="required-extensions" placeholder="[]"></textarea></label><label>Project ID to conformance entry paths<textarea id="entries" placeholder='{"project-id":"eval/conformance.ts"}'></textarea></label><label>State-delta suite JSON<textarea id="suite" placeholder='{"fixtures":[...at least 50 fixtures...]}'></textarea></label><div class="row"><button type="button" id="export">Export and run conformance</button><input id="job" placeholder="Conformance job ID"></div><div class="row"><button type="button" id="check">Check conformance status</button><button type="button" id="graduate">Publish certified listing</button></div><pre id="certification" class="status"></pre></details><script>(()=>{const table='foundry_products',prefix='app_foundry_catalog_facet_';let serial=0;const pending=new Map();function request(message){return new Promise((resolve,reject)=>{const id='r'+(++serial);pending.set(id,{resolve,reject});parent.postMessage({...message,id},'*');setTimeout(()=>{const p=pending.get(id);if(p){pending.delete(id);reject(Error('Extension host did not respond'))}},12000)})}function rpc(method,path,query,body){return request({type:'naelao.extension.rpc',method,path,query,body})}function operation(capability,input){return request({type:'naelao.extension.operation',capability,input})}async function call(op,args){const response=await rpc('POST','/mcp',undefined,{jsonrpc:'2.0',id:++serial,method:'tools/call',params:{name:prefix+op,arguments:{table,...args}}});if(response?.error)throw Error(response.error.message||'Extension call failed');return response?.result?.structuredContent}addEventListener('message',e=>{const m=e.data;if(m?.type!=='naelao.extension.rpc.result'||typeof m.id!=='string')return;const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.ok?p.resolve(m.result):p.reject(Error(m.error||'Extension request failed'))});async function refresh(){try{const rows=await call('list',{limit:200});render(Array.isArray(rows)?rows:[]);document.querySelector('#notice').textContent='Loaded '+(rows?.length||0)+' product records.'}catch(e){document.querySelector('#notice').textContent=e.message}}function render(rows){const root=document.querySelector('#items');root.replaceChildren();for(const item of rows){const card=document.createElement('article');card.className='card';const title=document.createElement('strong');title.textContent=item.name;const desc=document.createElement('p');desc.textContent=item.description||'No description yet';const status=document.createElement('div');status.className='status';status.textContent=item.status+' · Studio project '+item.studio_project_id;const choose=document.createElement('button');choose.type='button';choose.textContent='Prepare certification';choose.addEventListener('click',()=>{document.querySelector('#project-id').value=item.studio_project_id;document.querySelector('#listing-name').value=item.name;document.querySelector('#listing-description').value=item.description||''});card.append(title,desc,status,choose);root.append(card)}}document.querySelector('#reload').addEventListener('click',refresh);document.querySelector('#new').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,data=new FormData(form);try{await call('insert',{record:{product_id:crypto.randomUUID(),studio_project_id:String(data.get('project')).trim(),name:String(data.get('name')).trim(),description:String(data.get('description')||'').trim(),status:'draft'}});document.querySelector('#notice').textContent='Draft saved in schema-validated Space extension storage.';form.reset();await refresh()}catch(err){document.querySelector('#notice').textContent=err.message}});document.querySelector('#export').addEventListener('click',async()=>{try{const stateDeltaSuite=JSON.parse(document.querySelector('#suite').value);const entries=JSON.parse(document.querySelector('#entries').value);const projectId=document.querySelector('#project-id').value.trim();const requiredExtensions=JSON.parse(document.querySelector('#required-extensions').value||'[]');const result=await operation('blueprint.export',{projectId,requiredExtensions,name:document.querySelector('#listing-name').value.trim(),description:document.querySelector('#listing-description').value.trim(),templateCategory:'developer-tools',stateDeltaSuite,entries});document.querySelector('#job').value=result.jobId||'';document.querySelector('#certification').textContent=JSON.stringify(result,null,2)}catch(err){document.querySelector('#certification').textContent=err.message}});document.querySelector('#check').addEventListener('click',async()=>{try{const jobId=document.querySelector('#job').value.trim();const result=await operation('blueprint.status',{jobId});document.querySelector('#certification').textContent=JSON.stringify(result,null,2)}catch(err){document.querySelector('#certification').textContent=err.message}});document.querySelector('#graduate').addEventListener('click',async()=>{try{const conformance_job_id=document.querySelector('#job').value.trim();const result=await operation('marketplace.graduate',{conformance_job_id,name:document.querySelector('#listing-name').value.trim(),description:document.querySelector('#listing-description').value.trim()});document.querySelector('#certification').textContent=JSON.stringify(result,null,2)}catch(err){document.querySelector('#certification').textContent=err.message}});refresh()})();</script></body></html>`,
});

export const ANCHOR_DOGFOOD_EXTENSIONS = Object.freeze(DOGFOOD_EXTENSION_CATALOG.filter((item) => item.maturity === "anchor").map((item) => item.manifest));

export const DOGFOOD_EXTENSION_BY_ID = Object.freeze(Object.fromEntries(DOGFOOD_EXTENSIONS.map(manifest => [manifest.id, manifest])) as Readonly<Record<string, ExtensionManifest>>);
