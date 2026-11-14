import { FOUNDRY_TEMPLATE_STUDIO_CANVAS } from "./foundry-template-studio-canvas.js";
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

const spaceFacet = (id: string, name: string, schema: string, permissions: string[], migrations: NonNullable<ExtensionManifest["gadgets"][number]["migrations"]> = [], settingsSchema?: ExtensionManifest["settingsSchema"]): ExtensionManifest => ({
  id: id as `ext_${string}`,
  type: "extension",
  declaredPermissions: permissions,
  capabilityRequirements: permissions,
  ...(settingsSchema ? { settingsSchema } : {}),
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
  entry(spaceFacet("ext_assistant_voice_dashboard", "Assistant Voice Settings", "", ["extension.settings.read", "extension.settings.configure", "assistant.voice.read", "assistant.voice.configure"], [], {
    schemaVersion: 1,
    fields: [
      { id: "enabled", type: "boolean", label: "Enable Space Assistant voice", defaultValue: false },
      { id: "model_class", type: "select", label: "Model class", options: [
        { value: "economy", label: "Economy" }, { value: "balanced", label: "Balanced" }, { value: "advanced", label: "Advanced" },
      ], defaultValue: "balanced" },
      { id: "voice_profile_id", type: "text", label: "Approved voice profile ID", maxLength: 80 },
      { id: "language", type: "text", label: "Language (or auto)", defaultValue: "auto", maxLength: 24 },
      { id: "speed", type: "number", label: "Speaking speed", minimum: 0.5, maximum: 2, defaultValue: 1 },
      { id: "delivery_instructions", type: "text", label: "Speaking style", maxLength: 1000 },
      { id: "max_call_minutes", type: "number", label: "Maximum call length (minutes)", minimum: 1, maximum: 240, integer: true, defaultValue: 15 },
      { id: "max_call_cost_usd", type: "number", label: "Maximum call spend (USD)", minimum: 0.01, maximum: 100, defaultValue: 2 },
      { id: "allow_project_overrides", type: "boolean", label: "Allow tighter Project voice settings", defaultValue: false },
      { id: "allow_prebuilt_fallback", type: "boolean", label: "Allow configured prebuilt fallback", defaultValue: false },
    ],
  }), "reference"),
  entry(spaceFacet("ext_space_blackboard", "Space Blackboard", "CREATE TABLE IF NOT EXISTS blackboard_view_settings(id TEXT PRIMARY KEY, value TEXT NOT NULL);", ["blackboard.read", "blackboard.policy", "blackboard.sharing"]), "reference"),
  entry({ ...spaceFacet("ext_foundry_catalog", "Foundry Template Catalog", `
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
    );`, ["facet.sqlite.read", "facet.sqlite.write", "blueprint.dependencies", "blueprint.export", "blueprint.status", "marketplace.graduate"], [
      { version: 1, description: "Add product summary text", up: "ALTER TABLE foundry_products ADD COLUMN description TEXT NOT NULL DEFAULT ''" },
      { version: 2, description: "Persist bounded Foundry authoring drafts", up: "ALTER TABLE foundry_products ADD COLUMN draft_json TEXT NOT NULL DEFAULT '{}'" },
    ]), releaseVersion: "1.2.0" }, "reference"),
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
  ext_assistant_voice_dashboard: `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Assistant Voice Settings</title>
<style>body{font:14px system-ui;margin:24px;color:#202124}button,input,select,textarea{font:inherit;padding:8px;margin:4px 0;box-sizing:border-box;width:100%}button{width:auto;cursor:pointer}label{display:block;margin:12px 0}fieldset{border:1px solid #ddd;border-radius:8px;padding:12px;margin:14px 0}#notice{min-height:1.5em;color:#444}</style></head>
<body><h1>Assistant Voice Settings</h1><p>Configure Space Assistant voice preferences and call limits. The host validates saved values and exposes only its approved voice catalog.</p>
<p>This extension stores a validated draft per installation. Applying it changes Space Assistant defaults only; it does not create a customer voice agent or start a call.</p>
<div id="notice" role="status">Loading installation settings…</div>
<form id="settings"><fieldset><legend>Voice</legend><label><input id="enabled" type="checkbox" style="width:auto"> Enable Space Assistant voice</label>
<label>Model class<select id="model"><option value="economy">Economy</option><option value="balanced">Balanced</option><option value="advanced">Advanced</option></select></label>
<label>Approved voice<select id="voice"><option value="">Default for model class</option></select></label>
<label>Language (or auto)<input id="language" maxlength="24"></label><label>Speaking speed<input id="speed" type="number" min="0.5" max="2" step="0.1"></label>
<label>Speaking style<textarea id="instructions" maxlength="1000" rows="3"></textarea></label></fieldset>
<fieldset><legend>Limits and Project behavior</legend><label>Maximum call length (minutes)<input id="minutes" type="number" min="1" max="240" step="1"></label>
<label>Maximum call spend (USD)<input id="cost" type="number" min="0.01" max="100" step="0.01"></label>
<label><input id="projects" type="checkbox" style="width:auto"> Allow tighter Project voice settings</label>
<label><input id="fallback" type="checkbox" style="width:auto"> Allow the configured prebuilt fallback</label></fieldset>
<button id="save" type="submit">Save installation draft</button><button id="apply" type="button">Apply draft to Space Assistant</button><button id="reload" type="button">Reload</button></form>
<section id="rateCard" aria-live="polite" style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:14px 0"></section>
<p>Custom voice cloning, preview calls and provider streaming are not available in this dashboard. Existing phone and in-app paths keep their own admission and budget checks.</p>
<script>(()=>{
  let serial=0,revision=0,voiceRevision=0,catalog=[],catalogResearch=null;
  const pending=new Map(),$=id=>document.getElementById(id),notice=$('notice');
  function call(method,body,path){return new Promise((resolve,reject)=>{const id='voice_'+(++serial),timer=setTimeout(()=>{pending.delete(id);reject(Error('Host did not respond'))},12000);pending.set(id,{resolve,reject,timer});parent.postMessage({type:'naelao.extension.rpc',id,method,path:path||'/api/assistant-voice',...(body?{body}:{})},'*')})}
  addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;if(m?.type!=='naelao.extension.rpc.result'||typeof m.id!=='string')return;const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.ok?p.resolve(m.result):p.reject(Error(m.error||'Voice settings request failed'))});
  function selectedProfile(){return catalog.find(item=>item.id===$('voice').value&&item.modelClass===$('model').value)||catalog.find(item=>item.modelClass===$('model').value)}
  function renderEstimate(){const root=$('rateCard');root.replaceChildren();const profile=selectedProfile();if(!profile){root.textContent='Host-approved catalog rates are unavailable.';return}const speech=375*profile.speechRateUsdPerMillionCharacters/1000000,transcription=30*profile.transcriptionRateUsdPerSecond;const title=document.createElement('strong');title.textContent='Selected profile · published list-rate estimate';const details=document.createElement('p');details.textContent=profile.speechProvider+' speech '+profile.speechModel+' ('+profile.speechVoice+') at '+profile.sampleRate+' Hz: $'+profile.speechRateUsdPerMillionCharacters+' '+profile.speechRateUnit+'. '+profile.transcriptionProvider+' transcription '+profile.transcriptionModel+': $'+profile.transcriptionRateUsdPerSecond+' '+profile.transcriptionRateUnit+'. Languages: '+(profile.languages||[]).join(', ')+'.';const subtotal=document.createElement('p');subtotal.textContent='Illustrative subtotal: $'+(speech+transcription).toFixed(6)+' per minute equivalent, assuming 375 generated characters and 30 seconds of transcription. Not a quote, invoice, or measured cost.';const exclusions=document.createElement('p');exclusions.textContent='Excludes telephony and number rental, planner/LLM and tools, retrieval, runtime/compute/networking, retries, taxes, and provider routing or fallback charges. Provider availability, actual billed rates, and regional eligibility are unverified.';root.append(title,details,subtotal,exclusions);if(catalogResearch){const sourceLine=document.createElement('p');sourceLine.textContent='Rate research snapshot: '+catalogResearch.date+' ('+catalogResearch.basis.replaceAll('_',' ')+'). Sources: ';for(const [index,source] of catalogResearch.sources.entries()){if(index)sourceLine.append(document.createTextNode('; '));try{const url=new URL(source.url);if(url.protocol!=='https:'||url.hostname!=='openrouter.ai')continue;const link=document.createElement('a');link.href=url.href;link.target='_blank';link.rel='noreferrer';link.textContent=source.label;sourceLine.append(link)}catch{}}root.append(sourceLine)}}
  function renderVoices(model,selected){const root=$('voice');root.replaceChildren(new Option('Default for model class',''));for(const voice of catalog.filter(item=>item.modelClass===model))root.add(new Option(voice.name,voice.id));root.value=selected||'';renderEstimate()}
  function fromPreferences(p){return{enabled:p.enabled,model_class:p.modelClass,voice_profile_id:p.voiceProfileId||'',language:p.language,speed:p.speed,delivery_instructions:p.deliveryInstructions,max_call_minutes:p.maxCallMinutes,max_call_cost_usd:p.maxCallCostUsd,allow_project_overrides:p.allowProjectOverrides,allow_prebuilt_fallback:p.allowPrebuiltFallback}}
  function values(){return{enabled:$('enabled').checked,model_class:$('model').value,voice_profile_id:$('voice').value,language:$('language').value,speed:Number($('speed').value),delivery_instructions:$('instructions').value,max_call_minutes:Number($('minutes').value),max_call_cost_usd:Number($('cost').value),allow_project_overrides:$('projects').checked,allow_prebuilt_fallback:$('fallback').checked}}
  function fill(v){$('enabled').checked=!!v.enabled;$('model').value=v.model_class||'balanced';$('language').value=v.language||'auto';$('speed').value=v.speed??1;$('instructions').value=v.delivery_instructions||'';$('minutes').value=v.max_call_minutes??15;$('cost').value=v.max_call_cost_usd??2;$('projects').checked=!!v.allow_project_overrides;$('fallback').checked=!!v.allow_prebuilt_fallback;renderVoices($('model').value,v.voice_profile_id||'')}
  async function refresh(){notice.textContent='Loading installation settings…';try{const result=await Promise.all([call('GET',undefined,'/api/assistant-voice'),call('GET',undefined,'/api/settings')]),voice=result[0],settings=result[1];voiceRevision=voice.revision;revision=settings.revision;catalog=voice.voiceCatalog||[];catalogResearch=voice.voiceCatalogResearch||null;fill(revision>0?settings.settings:fromPreferences(voice.preferences));notice.textContent='Installation draft revision '+revision+' · Space Assistant preference revision '+voiceRevision+'.'}catch(error){notice.textContent=error.message}}
  async function saveDraft(){return call('PATCH',{revision,settings:values()},'/api/settings')}
  $('model').addEventListener('change',()=>renderVoices($('model').value,''));$('voice').addEventListener('change',renderEstimate);
  $('settings').addEventListener('submit',async e=>{e.preventDefault();$('save').disabled=true;notice.textContent='Saving installation draft…';try{const data=await saveDraft();revision=data.revision;notice.textContent='Saved this installation draft at revision '+revision+'. Apply it separately to change Space Assistant defaults.'}catch(error){notice.textContent=error.message}finally{$('save').disabled=false}});
  $('apply').addEventListener('click',async()=>{$('apply').disabled=true;notice.textContent='Applying to Space Assistant…';try{if(!confirm('Apply this installation draft to the Space Assistant voice preferences for this Space?'))return;const saved=await saveDraft();revision=saved.revision;const v=values(),result=await call('PATCH',{revision:voiceRevision,preferences:{enabled:v.enabled,modelClass:v.model_class,voiceProfileId:v.voice_profile_id||null,language:v.language,deliveryInstructions:v.delivery_instructions,speed:v.speed,maxCallMinutes:v.max_call_minutes,maxCallCostUsd:v.max_call_cost_usd,allowProjectOverrides:v.allow_project_overrides,allowPrebuiltFallback:v.allow_prebuilt_fallback}},'/api/assistant-voice');voiceRevision=result.revision;notice.textContent='Applied to Space Assistant. Draft revision '+revision+' · preference revision '+voiceRevision+'.'}catch(error){notice.textContent=error.message}finally{$('apply').disabled=false}});
  $('reload').addEventListener('click',refresh);void refresh()
})();</script></body></html>`,
  ext_space_blackboard: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Space Blackboard</title><style>body{font:14px system-ui;margin:24px;color:#202124}button,input{font:inherit;padding:8px;margin:4px}article{border:1px solid #ddd;border-radius:8px;padding:12px;margin:10px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>Space Blackboard</h1><p>Shared project summaries and coordination requests available to you.</p><button id="refresh">Refresh shared projects</button><div id="notice" role="status"></div><section id="cards"></section><label>Project ID <input id="project" maxlength="160"></label><button id="requests">View requests</button><button id="events">View updates</button><button id="policy">View wake policy</button><button id="enable">Enable wake-ups</button><button id="disable">Disable wake-ups</button><div><label>Allowed project IDs (comma separated) <input id="peers"></label><label>Daily action limit <input id="limit" type="number" min="0" max="50" value="0"></label><button id="sharing-view">View sharing policy</button><button id="sharing-save">Save sharing policy</button><p>Automatic requests can share only the published project summary. Other content requires approval.</p></div><pre id="details"></pre><script>(()=>{let serial=0;const pending=new Map();function read(input){return new Promise((resolve,reject)=>{const id='b'+(++serial);pending.set(id,{resolve,reject});parent.postMessage({type:'naelao.extension.operation',id,capability:'blackboard.read',input},'*');setTimeout(()=>{const p=pending.get(id);if(p){pending.delete(id);p.reject(Error('Host did not respond'))}},12000)})}addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;if(m?.type!=='naelao.extension.rpc.result'||typeof m.id!=='string')return;const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.ok?p.resolve(m.result):p.reject(Error(m.error||'Request failed'))});async function refresh(){const root=document.querySelector('#cards'),notice=document.querySelector('#notice');root.replaceChildren();try{let after, count=0;do{const data=await read({view:'cards',...(after?{after}:{})});for(const card of data.cards||[]){const el=document.createElement('article'),title=document.createElement('strong'),summary=document.createElement('p'),caps=document.createElement('p');title.textContent=card.projectId;summary.textContent=card.summary;caps.textContent=(card.capabilities||[]).join(', ');el.append(title,summary,caps);root.append(el);count++}after=data.next_cursor}while(after&&count<200);notice.textContent='Loaded '+count+' shared projects'+(after?' (more available)':'')}catch(e){notice.textContent=e.message}}async function detail(view){try{const projectId=document.querySelector('#project').value.trim();document.querySelector('#details').textContent=JSON.stringify(await read({view,projectId}),null,2)}catch(e){document.querySelector('#details').textContent=e.message}}document.querySelector('#refresh').onclick=refresh;document.querySelector('#requests').onclick=()=>detail('requests');document.querySelector('#events').onclick=()=>detail('events');document.querySelector('#policy').onclick=()=>detail('policy');async function setWake(wakeEnabled){try{const projectId=document.querySelector('#project').value.trim();const id='b'+(++serial);const result=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});parent.postMessage({type:'naelao.extension.operation',id,capability:'blackboard.policy',input:{projectId,wakeEnabled}},'*');setTimeout(()=>{const p=pending.get(id);if(p){pending.delete(id);p.reject(Error('Host did not respond'))}},12000)});document.querySelector('#details').textContent=JSON.stringify(result,null,2)}catch(e){document.querySelector('#details').textContent=e.message}}document.querySelector('#enable').onclick=()=>setWake(true);document.querySelector('#disable').onclick=()=>setWake(false);document.querySelector('#sharing-view').onclick=()=>detail('sharing');document.querySelector('#sharing-save').onclick=async()=>{try{const projectId=document.querySelector('#project').value.trim(),peers=document.querySelector('#peers').value.split(',').map(x=>x.trim()).filter(Boolean),dailyLimit=Number(document.querySelector('#limit').value),id='b'+(++serial);const result=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});parent.postMessage({type:'naelao.extension.operation',id,capability:'blackboard.sharing',input:{projectId,peers,dailyLimit}},'*');setTimeout(()=>{const p=pending.get(id);if(p){pending.delete(id);p.reject(Error('Host did not respond'))}},12000)});document.querySelector('#details').textContent=JSON.stringify(result,null,2)}catch(e){document.querySelector('#details').textContent=e.message}};refresh()})();</script></body></html>`,
  ext_foundry_catalog: FOUNDRY_TEMPLATE_STUDIO_CANVAS,
});

export const ANCHOR_DOGFOOD_EXTENSIONS = Object.freeze(DOGFOOD_EXTENSION_CATALOG.filter((item) => item.maturity === "anchor").map((item) => item.manifest));

export const DOGFOOD_EXTENSION_BY_ID = Object.freeze(Object.fromEntries(DOGFOOD_EXTENSIONS.map(manifest => [manifest.id, manifest])) as Readonly<Record<string, ExtensionManifest>>);
