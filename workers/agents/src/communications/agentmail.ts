import { mintInternalToken, readBoundedRequestText, readBoundedResponseJson } from "@naelao/http";
import { AgentPortServiceClient } from "@agentport/sdk";
import { verifyAgentPortEventWebhook } from "@agentport/sdk";
import type { AgentsEnv } from "../index.js";
import { ensureAgentPortAssistantIdentity, type CommunicationIdentity, type CommunicationScope, sealCommunication, openCommunication, validateAutonomy } from "./core.js";
import { markManagedServiceCreditsUncertain,releaseManagedServiceCredits,reserveManagedServiceCredits,settleManagedServiceCredits } from "./managed-service-billing.js";
import { requireManagedServiceCapability } from "./managed-service-capabilities.js";
import { ensureManagedServiceOwnerLink, ensureOrganizationPayerMandate, revokeOrganizationPayerMandate } from "./managed-service-ownership.js";
import { loadAgentConfig } from "../script-engine/agent-config.js";

type AgentMailAccount={id:string;tenant_id:string;space_id:string;project_id:string|null;assistant_identity_id:string;agentport_agent_id:string;agentport_account_id:string|null;agentport_principal_id?:string|null;owner_link_id?:string|null;owner_user_id:string;mode:"naelao_managed"|"user_connected";pod_id:string|null;inbox_id:string;email_address:string;credential_ciphertext:string|null;credential_iv:string|null;provider_region?:"us"|"eu"|null;status:string;activated_at:string|null};
type ManagedServiceAccountState="provisioning"|"active"|"billing_hold"|"suspended"|"retirement_review_required"|"revoking"|"revoked"|"retired"|"failed"|"unknown";
const API="https://api.agentmail.to/v0";
const EU_API="https://api.agentmail.eu/v0";
function id(prefix:string){return `${prefix}_${crypto.randomUUID().replaceAll("-","")}`;}
async function stableClientId(value:string){const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));return `naelao_${[...bytes].map(x=>x.toString(16).padStart(2,"0")).join("")}`;}
async function recordManagedServiceAccount(env:AgentsEnv,account:AgentMailAccount,state?:ManagedServiceAccountState,capabilityVersion:number|null=null,region:string|null=null){
  const managed=account.mode==="naelao_managed";
  const lifecycle=state??(account.status==="active"?"active":account.status==="billing_hold"?"billing_hold":account.status==="suspended"?"suspended":account.status==="retirement_review_required"?"retirement_review_required":account.status==="retired"?"retired":account.status==="failed"?"failed":account.status==="provisioning"?"provisioning":"unknown");
  const at=new Date().toISOString();
  await env.PLATFORM_DB.prepare(`INSERT INTO managed_service_accounts(
    id,tenant_id,space_id,project_id,provider,service_id,capability_version,connection_mode,
    provider_resource_ref,provider_account_ref,agentport_principal_id,agentport_agent_id,agentport_account_id,credential_ref,
    owner_type,owner_id,provider_payer_type,provider_payer_id,credit_payer_type,credit_payer_id,owner_link_id,region,
    lifecycle_state,metadata_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET space_id=excluded.space_id,project_id=excluded.project_id,
      capability_version=COALESCE(excluded.capability_version,managed_service_accounts.capability_version),
      connection_mode=excluded.connection_mode,provider_resource_ref=excluded.provider_resource_ref,
      provider_account_ref=excluded.provider_account_ref,agentport_principal_id=COALESCE(excluded.agentport_principal_id,managed_service_accounts.agentport_principal_id),
      agentport_agent_id=excluded.agentport_agent_id,
      agentport_account_id=excluded.agentport_account_id,credential_ref=excluded.credential_ref,
      owner_type=excluded.owner_type,owner_id=excluded.owner_id,provider_payer_type=excluded.provider_payer_type,
      provider_payer_id=excluded.provider_payer_id,credit_payer_type=excluded.credit_payer_type,
      credit_payer_id=excluded.credit_payer_id,owner_link_id=COALESCE(excluded.owner_link_id,managed_service_accounts.owner_link_id),
      region=COALESCE(excluded.region,managed_service_accounts.region),lifecycle_state=excluded.lifecycle_state,
      metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
    .bind(account.id,account.tenant_id,account.space_id,account.project_id,"agentmail","agentmail",capabilityVersion,account.mode,account.inbox_id,account.pod_id,
      account.agentport_principal_id??null,account.agentport_agent_id||null,account.agentport_account_id,account.id,
      managed?"organization":"user",managed?account.tenant_id:account.owner_user_id,
      managed?"platform":"user",managed?"naelao":account.owner_user_id,
      managed?"organization":null,managed?account.tenant_id:null,account.owner_link_id??null,region,lifecycle,JSON.stringify({mode:account.mode}),at,at).run();
}
function providerRegion(region?:string|null){
  const value=region??"us";
  if(value!=="us"&&value!=="eu")throw new Error("agentmail_provider_region_unsupported");
  return value;
}
async function provider(env:AgentsEnv,key:string,path:string,init:RequestInit={},region?:string|null){
  const selected=providerRegion(region);
  const base=selected==="eu"?(env.AGENTMAIL_API_BASE_URL_EU??EU_API):(env.AGENTMAIL_API_BASE_URL??API);
  const response=await fetch(`${base}${path}`,{...init,headers:{authorization:`Bearer ${key}`,accept:"application/json",...(init.body?{"content-type":"application/json"}:{}),...init.headers}});
  const payload=await readBoundedResponseJson<Record<string,unknown>>(response,2*1024*1024);
  if(!response.ok)throw new Error(`agentmail_provider_${response.status}`);
  return payload;
}
async function agentPort(env:AgentsEnv,tenantId:string,path:string,method="GET",body?:unknown){
  const client=new AgentPortServiceClient({baseUrl:"https://agentport.internal/internal/agentport",headers:{"content-type":"application/json","x-agentport-tenant-id":tenantId,"x-agentport-actor-role":"client_system","x-agentport-actor-id":tenantId,"x-agentport-internal-token":await mintInternalToken(env.PLATFORM_SECRET,tenantId)},fetch:(input,init)=>env.AGENTPORT_WORKER.fetch(new Request(input,init))});
  const response=await client.request(path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await readBoundedResponseJson<Record<string,unknown>>(response,64*1024);
  if(!response.ok&&response.status!==409)throw new Error(`agentport_${String(result.error_code??"request_failed")}`);
  return {response,result};
}
async function platformIdentity(env:AgentsEnv,scope:CommunicationScope,identity:CommunicationIdentity){
  const agentId=await ensureAgentPortAssistantIdentity(env,scope);
  const serviceId=`agentmail:${scope.tenantId}`;
  const manifest={id:serviceId,name:"AgentMail",type:"managed",accountModels:["agent_native","user_parent"],capabilities:["email.read","email.send","email.search","email.threads","email.attachments","channels"],events:["message.received"],connectionPurpose:"agent_resource",auth:{type:"api_key"},provisioning:{mode:"approval_required"}};
  await agentPort(env,scope.tenantId,"/services","POST",manifest).catch(error=>{if(!(error instanceof Error&&error.message.includes("service_registration_conflict")))throw error;});
  const response=await agentPort(env,scope.tenantId,`/agents/${encodeURIComponent(agentId)}/identity`);
  const registered=response.result.identity as {principal?:{id?:unknown}}|undefined;
  if(typeof registered?.principal?.id!=="string")throw new Error("agentport_principal_link_unavailable");
  return {agentId,serviceId,principalId:registered.principal.id};
}
export async function getAssistantAgentMailStatus(env:AgentsEnv,scope:CommunicationScope){
  const rows=await env.PLATFORM_DB.prepare(`SELECT a.id,a.mode,a.email_address,a.status,a.activated_at,a.next_billing_at,
      (SELECT COUNT(*) FROM assistant_agentmail_event_receipts e WHERE e.account_id=a.id AND e.status='queued') AS received_count,
      (SELECT COUNT(*) FROM assistant_agentmail_sends s WHERE s.connection_id=a.id AND s.status='sent') AS sent_count,
      (SELECT MAX(value) FROM (SELECT MAX(e.created_at) AS value FROM assistant_agentmail_event_receipts e WHERE e.account_id=a.id AND e.status='queued' UNION ALL SELECT MAX(s.updated_at) AS value FROM assistant_agentmail_sends s WHERE s.connection_id=a.id AND s.status='sent')) AS last_activity_at
    FROM assistant_agentmail_accounts a WHERE tenant_id=? AND space_id=? AND project_id IS ?
      AND (a.mode='naelao_managed' OR a.owner_user_id=?) ORDER BY created_at DESC LIMIT 20`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId??null,scope.userId)
    .all<{id:string;mode:string;email_address:string;status:string;activated_at:string|null;next_billing_at:string|null;received_count:number;sent_count:number;last_activity_at:string|null}>();
  const routes=await env.PLATFORM_DB.prepare(`SELECT account_id,naelao_agent_id FROM assistant_agentport_event_routes
    WHERE tenant_id=? AND space_id=? AND project_id IS ? AND status='active'`).bind(scope.tenantId,scope.spaceId,scope.projectId??null)
    .all<{account_id:string;naelao_agent_id:string}>();
  const assistantByAccount=new Map(routes.results.map(route=>[route.account_id,route.naelao_agent_id]));
  const latestOperation=await env.PLATFORM_DB.prepare(`SELECT o.status,o.error_code,o.updated_at FROM assistant_agentmail_operations o
    JOIN assistant_communication_identities i ON i.id=o.assistant_identity_id
    WHERE i.tenant_id=? AND i.space_id=? AND i.project_id IS ? AND o.operation='provision' ORDER BY o.updated_at DESC LIMIT 1`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId??null).first<{status:string;error_code:string|null;updated_at:string}>();
  const managedOperation=await env.PLATFORM_DB.prepare(`SELECT o.status,o.error_code,o.updated_at FROM managed_service_operations o
    WHERE o.tenant_id=? AND o.space_id=? AND o.project_id IS ? AND o.provider='agentmail' AND o.operation_name='provision'
    ORDER BY o.updated_at DESC LIMIT 1`).bind(scope.tenantId,scope.spaceId,scope.projectId??null)
    .first<{status:string;error_code:string|null;updated_at:string}>();
  return {provider:"agentmail",connections:rows.results.map(row=>({id:row.id,mode:row.mode,address:row.email_address,status:row.status,activatedAt:row.activated_at,nextBillingAt:row.next_billing_at,
    assistantId:assistantByAccount.get(row.id)??null,
    receivedMessages:row.received_count,sentMessages:row.sent_count,lastActivityAt:row.last_activity_at,activity30d:!!row.last_activity_at&&Date.parse(row.last_activity_at)>=Date.now()-30*86400_000?"active":"idle"})),
    ...(managedOperation?{lastManagedOperation:{status:managedOperation.status,errorCode:managedOperation.error_code,updatedAt:managedOperation.updated_at,reconciliationRequired:managedOperation.status==="uncertain"}}:{}),
    ...(latestOperation?.status==="held"?{lastProvisioningFailure:{errorCode:latestOperation.error_code,occurredAt:latestOperation.updated_at}}:{})};
}

/** Set an explicit owner-authorized subscription → provisioned Naelao assistant route. */
export async function setAgentPortEventAssistant(
  env:AgentsEnv,
  scope:CommunicationScope,
  connectionId:string,
  assistantId:string,
  wakeEnabled = true,
) {
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(connectionId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(assistantId) || typeof wakeEnabled !== "boolean")throw new Error("agentport_assistant_route_invalid");
  const account=await env.PLATFORM_DB.prepare(`SELECT id,tenant_id,space_id,project_id,owner_user_id,agentport_agent_id,agentport_account_id,
      agentport_subscription_id,status FROM assistant_agentmail_accounts
    WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=? LIMIT 1`)
    .bind(connectionId,scope.tenantId,scope.spaceId,scope.projectId??null,scope.userId)
    .first<{id:string;tenant_id:string;space_id:string;project_id:string|null;owner_user_id:string;agentport_agent_id:string;agentport_account_id:string|null;agentport_subscription_id:string|null;status:string}>();
  if(!account||account.status!=="active"||!account.agentport_account_id||!account.agentport_subscription_id)throw new Error("agentport_assistant_route_account_unavailable");
  if(assistantId!=="naelao-agent"&&(!env.SCRIPTS_R2||!(await loadAgentConfig(env.SCRIPTS_R2,scope.spaceId,assistantId))))throw new Error("naelao_assistant_not_provisioned");
  const current=await agentPort(env,scope.tenantId,`/events/subscriptions/${encodeURIComponent(account.agentport_subscription_id)}`);
  const subscription=current.result.subscription as {id?:unknown;agentId?:unknown;accountId?:unknown;serviceId?:unknown;status?:unknown}|undefined;
  const serviceId=`agentmail:${scope.tenantId}`;
  if(!subscription||subscription.id!==account.agentport_subscription_id||subscription.agentId!==account.agentport_agent_id
    ||subscription.accountId!==account.agentport_account_id||subscription.serviceId!==serviceId||subscription.status!=="active")
    throw new Error("agentport_assistant_route_subscription_unavailable");
  const at=new Date().toISOString();
  await env.PLATFORM_DB.prepare(`INSERT INTO assistant_agentport_event_routes(account_id,tenant_id,space_id,project_id,subscription_id,
      agentport_agent_id,agentport_account_id,service_id,naelao_agent_id,wake_enabled,route_revision,status,selected_by_user_id,created_at,updated_at,revoked_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,1,'active',?,?,?,NULL)
    ON CONFLICT(account_id) DO UPDATE SET subscription_id=excluded.subscription_id,agentport_agent_id=excluded.agentport_agent_id,
      agentport_account_id=excluded.agentport_account_id,service_id=excluded.service_id,naelao_agent_id=excluded.naelao_agent_id,
      route_revision=assistant_agentport_event_routes.route_revision + CASE WHEN assistant_agentport_event_routes.subscription_id IS NOT excluded.subscription_id
        OR assistant_agentport_event_routes.agentport_agent_id IS NOT excluded.agentport_agent_id
        OR assistant_agentport_event_routes.agentport_account_id IS NOT excluded.agentport_account_id
        OR assistant_agentport_event_routes.service_id IS NOT excluded.service_id
        OR assistant_agentport_event_routes.naelao_agent_id IS NOT excluded.naelao_agent_id
        OR assistant_agentport_event_routes.wake_enabled IS NOT excluded.wake_enabled THEN 1 ELSE 0 END,
      wake_enabled=excluded.wake_enabled,status='active',selected_by_user_id=excluded.selected_by_user_id,updated_at=excluded.updated_at,revoked_at=NULL
    WHERE assistant_agentport_event_routes.tenant_id=excluded.tenant_id AND assistant_agentport_event_routes.space_id=excluded.space_id
      AND assistant_agentport_event_routes.project_id IS excluded.project_id`)
    .bind(account.id,account.tenant_id,account.space_id,account.project_id,account.agentport_subscription_id,account.agentport_agent_id,
      account.agentport_account_id,serviceId,assistantId,wakeEnabled?1:0,scope.userId,at,at).run();
  const saved=await env.PLATFORM_DB.prepare(`SELECT naelao_agent_id,wake_enabled,route_revision FROM assistant_agentport_event_routes
    WHERE account_id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND status='active'`)
    .bind(account.id,scope.tenantId,scope.spaceId,scope.projectId??null).first<{naelao_agent_id:string;wake_enabled:number;route_revision:number}>();
  if(saved?.naelao_agent_id!==assistantId||saved.wake_enabled!==(wakeEnabled?1:0))throw new Error("agentport_assistant_route_conflict");
  return {connectionId:account.id,assistantId,wakeEnabled:saved.wake_enabled===1,subscriptionVerified:true};
}
async function linkAgentPort(env:AgentsEnv,scope:CommunicationScope,identity:CommunicationIdentity,account:AgentMailAccount,providerOwner:{type:"individual"|"organization";id:string},activateLocal=true){
  const {agentId,serviceId,principalId:agentPrincipalId}=await platformIdentity(env,scope,identity);
  let ownerPrincipalId=agentPrincipalId;
  if(providerOwner.type==="individual"){
    const principalRecordId=`prn_user_${(await stableClientId(`${scope.tenantId}:${providerOwner.id}`)).slice(7)}`;
    const principalResponse=await agentPort(env,scope.tenantId,"/principals","POST",{id:principalRecordId,externalId:providerOwner.id,organizationName:"Naelao"});
    const principal=principalResponse.result.principal as {id?:unknown}|undefined;
    if(typeof principal?.id!=="string")throw new Error("agentport_owner_principal_unavailable");
    ownerPrincipalId=principal.id;
  }
  const ownerType=providerOwner.type==="organization"?"organization":"user";
  const ownerLinkId=await ensureManagedServiceOwnerLink(env,scope,{ownerType,ownerId:providerOwner.id,principalId:ownerPrincipalId,consentSource:account.mode==="naelao_managed"?"agentmail_managed_provision":"agentmail_user_connect"});
  const {result}=await agentPort(env,scope.tenantId,"/accounts","POST",{serviceId,accountModel:"agent_native",ownerType:providerOwner.type,ownerId:providerOwner.id,externalAccountId:account.inbox_id,credentialRef:account.id,metadata:{provider:"agentmail",connectionMode:account.mode}});
  const created=result.account as {id?:string;status?:string}|undefined;
  if(!created?.id)throw new Error("agentport_account_link_unavailable");
  if(created.status==="pending")await agentPort(env,scope.tenantId,`/accounts/${encodeURIComponent(created.id)}/activate`,"POST",{});
  else if(created.status==="revoked")await agentPort(env,scope.tenantId,`/accounts/${encodeURIComponent(created.id)}/reactivate`,"POST",{});
  const grants=["email.read","email.send","email.search","email.threads","email.attachments","channels.manage","messages.read","messages.send"];
  await agentPort(env,scope.tenantId,`/accounts/${encodeURIComponent(created.id)}/grants`,"POST",{agentId,grantedBy:providerOwner.id,permissions:grants});
  account.agentport_agent_id=agentId;account.agentport_account_id=created.id;
  account.agentport_principal_id=ownerPrincipalId;account.owner_link_id=ownerLinkId;
  await env.PLATFORM_DB.prepare(`UPDATE assistant_agentmail_accounts SET agentport_agent_id=?,agentport_account_id=?,status=CASE WHEN ? THEN 'active' ELSE status END,updated_at=? WHERE id=?`)
    .bind(agentId,created.id,activateLocal?1:0,new Date().toISOString(),account.id).run();
  await recordManagedServiceAccount(env,account,activateLocal?"active":"provisioning",null,account.provider_region??env.AGENTMAIL_REGION??null);
  const rows=await agentPort(env,scope.tenantId,`/channels?agentId=${encodeURIComponent(agentId)}`);
  let channel=(rows.result.channels as Array<Record<string,unknown>>|undefined)?.find(x=>x.account_id===created.id);
  if(!channel){const response=await agentPort(env,scope.tenantId,"/channels","POST",{serviceId,accountId:created.id,agentId,providerChannelId:account.inbox_id,displayName:account.email_address});channel=response.result.channel as Record<string,unknown>|undefined;}
  if(!channel?.id)throw new Error("agentport_channel_link_unavailable");
  const providerKey=await providerKeyFor(env,identity,account);
  if(!env.AGENTMAIL_WEBHOOK_URL||!env.AGENTPORT_EVENT_RECEIVER_URL)throw new Error("agentmail_event_delivery_not_configured");
  let webhookId="",webhookSecret="";
  const webhookStored=await env.PLATFORM_DB.prepare("SELECT agentmail_webhook_id,agentmail_webhook_secret_ciphertext,agentmail_webhook_secret_iv FROM assistant_agentmail_accounts WHERE id=?")
    .bind(account.id).first<{agentmail_webhook_id:string|null;agentmail_webhook_secret_ciphertext:string|null;agentmail_webhook_secret_iv:string|null}>();
  if(webhookStored?.agentmail_webhook_id&&webhookStored.agentmail_webhook_secret_ciphertext&&webhookStored.agentmail_webhook_secret_iv){
    webhookId=webhookStored.agentmail_webhook_id;
  }else{
    const hookUrl=`${env.AGENTMAIL_WEBHOOK_URL.replace(/\/$/,"")}/${encodeURIComponent(account.id)}`;
    const client=await stableClientId(`naelao:agentmail-webhook:${account.id}`);let created:Record<string,unknown>;
    try{created=await provider(env,providerKey,`/inboxes/${encodeURIComponent(account.inbox_id)}/webhooks`,{method:"POST",body:JSON.stringify({url:hookUrl,event_types:["message.received"],client_id:client})},account.provider_region);}
    catch(error){
      if(!(error instanceof Error&&error.message.endsWith("_409")))throw error;
      const list=await provider(env,providerKey,`/inboxes/${encodeURIComponent(account.inbox_id)}/webhooks`,{},account.provider_region);
      const existing=(list.webhooks as Array<Record<string,unknown>>|undefined)?.find(item=>item.client_id===client);
      if(!existing||typeof existing.webhook_id!=="string")throw new Error("agentmail_webhook_reconciliation_required");
      created=await provider(env,providerKey,`/inboxes/${encodeURIComponent(account.inbox_id)}/webhooks/${encodeURIComponent(existing.webhook_id)}`,{},account.provider_region);
    }
    webhookId=typeof created.webhook_id==="string"?created.webhook_id:"";webhookSecret=typeof created.secret==="string"?created.secret:"";
    if(!webhookId||!webhookSecret)throw new Error("agentmail_webhook_response_invalid");
    const encrypted=await sealCommunication(env,identity,account.id,{secret:webhookSecret});
    await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET agentmail_webhook_id=?,agentmail_webhook_secret_ciphertext=?,agentmail_webhook_secret_iv=?,updated_at=? WHERE id=?")
      .bind(webhookId,encrypted.ciphertext,encrypted.iv,new Date().toISOString(),account.id).run();
  }
  const apWebhookUrl=`${env.AGENTPORT_EVENT_RECEIVER_URL.replace(/\/$/,"")}/${encodeURIComponent(account.id)}`;
  const subscription=await agentPort(env,scope.tenantId,"/events/subscriptions","POST",{agentId,serviceId,accountId:created.id,eventType:"message.received",deliveryMode:"webhook",consumerGroup:`naelao:${account.id}`,routing:{webhookUrl:apWebhookUrl}});
  const apSub=subscription.result.subscription as {id?:string}|undefined;const apSecret=typeof subscription.result.webhookSecret==="string"?subscription.result.webhookSecret:"";
  if(!apSub?.id||!apSecret)throw new Error("agentport_event_subscription_unavailable");
  const encryptedAP=await sealCommunication(env,identity,account.id,{secret:apSecret});
  await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET agentport_subscription_id=?,agentport_webhook_secret_ciphertext=?,agentport_webhook_secret_iv=?,updated_at=? WHERE id=?")
    .bind(apSub.id,encryptedAP.ciphertext,encryptedAP.iv,new Date().toISOString(),account.id).run();
  return {agentId,serviceId,accountId:created.id,channelId:String(channel.id)};
}
/** Repair the owner-authorized AgentPort representation for an already active inbox.
 * All provider-side identities use stable resource IDs, grants are upserts, and subscription
 * creation uses the stable per-connection consumer group, so an uncertain retry is safe. */
export async function syncAgentPortAgentMail(
  env:AgentsEnv,
  scope:CommunicationScope,
  connectionId:string,
  requestId:string,
) {
  if(!/^[A-Za-z0-9._:-]{1,160}$/.test(connectionId)||!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId))
    throw new Error("agentport_sync_invalid_request");
  const account=await env.PLATFORM_DB.prepare(`SELECT * FROM assistant_agentmail_accounts
    WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=? AND status='active' LIMIT 1`)
    .bind(connectionId,scope.tenantId,scope.spaceId,scope.projectId??null,scope.userId).first<AgentMailAccount>();
  if(!account)throw new Error("agentport_sync_account_not_found");
  const identity=await env.PLATFORM_DB.prepare(`SELECT * FROM assistant_communication_identities
    WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=? AND status='active'`)
    .bind(account.assistant_identity_id,scope.tenantId,scope.spaceId,scope.projectId??null,scope.userId).first<CommunicationIdentity>();
  if(!identity)throw new Error("agentport_sync_identity_unavailable");
  const request={connectionId,requestId,ownerUserId:scope.userId,projectId:scope.projectId??null};
  const requestHash=await hashString(JSON.stringify(request));
  const idempotencyKey=`agentport-sync:${await stableClientId(`${scope.spaceId}:${scope.projectId??"space"}:${connectionId}:${requestId}`)}`;
  const operationId=await stableClientId(`naelao:${scope.tenantId}:${idempotencyKey}`);
  const at=new Date().toISOString();
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_operations(
    operation_id,tenant_id,space_id,project_id,account_id,provider,service_id,operation_name,idempotency_key,request_sha256,
    status,request_json,created_at,updated_at)
    VALUES(?,?,?,?,?,'agentmail','agentmail','agentport_sync',?,?,'pending',?,?,?)`)
    .bind(operationId,scope.tenantId,scope.spaceId,scope.projectId??null,connectionId,idempotencyKey,requestHash,JSON.stringify(request),at,at).run();
  let operation=await env.PLATFORM_DB.prepare(`SELECT request_sha256,status,lease_until FROM managed_service_operations
    WHERE operation_id=? AND tenant_id=?`).bind(operationId,scope.tenantId)
    .first<{request_sha256:string;status:string;lease_until:string|null}>();
  if(!operation||operation.request_sha256!==requestHash)throw new Error("agentport_sync_operation_conflict");
  if(operation.status==="complete")return {synced:true,connectionId,agentportAccountId:account.agentport_account_id,deduplicated:true};
  const leaseUntil=new Date(Date.now()+120_000).toISOString();
  const claimed=await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,error_code=NULL,updated_at=?
    WHERE operation_id=? AND tenant_id=? AND status IN ('pending','held','uncertain')`)
    .bind(leaseUntil,at,operationId,scope.tenantId).run();
  if(!claimed.meta.changes){
    if(operation.status==="running"&&operation.lease_until&&Date.parse(operation.lease_until)>Date.now())
      return {synced:false,pending:true,connectionId};
    const recovered=await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,error_code=NULL,updated_at=?
      WHERE operation_id=? AND tenant_id=? AND status='running' AND (lease_until IS NULL OR lease_until<=?)`)
      .bind(leaseUntil,at,operationId,scope.tenantId,at).run();
    if(!recovered.meta.changes)return {synced:false,pending:true,connectionId};
  }
  try{
    const linked=await linkAgentPort(env,scope,identity,account,
      account.mode==="naelao_managed"?{type:"organization",id:scope.tenantId}:{type:"individual",id:scope.userId},true);
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='complete',lease_until=NULL,error_code=NULL,
      provider_operation_ref=?,result_ref=?,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='running'`)
      .bind(linked.accountId,linked.channelId,new Date().toISOString(),operationId,scope.tenantId).run();
    return {synced:true,connectionId,agentportAccountId:linked.accountId,agentportChannelId:linked.channelId,deduplicated:false};
  }catch(error){
    const code=error instanceof Error&&/^[a-z][a-z0-9_:-]{1,100}$/.test(error.message)?error.message:"agentport_sync_failed";
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='uncertain',lease_until=NULL,error_code=?,
      next_reconcile_at=?,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='running'`)
      .bind(code,new Date(Date.now()+5*60_000).toISOString(),new Date().toISOString(),operationId,scope.tenantId).run();
    throw error;
  }
}
/** Return an existing connection's owner identity without provisioning any AgentPort resources.
 * The sync route uses this to reject foreign connection IDs before ensureIdentity can create
 * the caller's default AgentPort assistant as a side effect. */
export async function getAgentPortSyncIdentity(
  env:AgentsEnv,
  scope:CommunicationScope,
  connectionId:string,
):Promise<CommunicationIdentity|null>{
  return env.PLATFORM_DB.prepare(`SELECT i.* FROM assistant_agentmail_accounts a
    JOIN assistant_communication_identities i ON i.id=a.assistant_identity_id
    WHERE a.id=? AND a.tenant_id=? AND a.space_id=? AND a.project_id IS ? AND a.owner_user_id=? AND a.status='active'
      AND i.tenant_id=? AND i.space_id=? AND i.project_id IS ? AND i.owner_user_id=? AND i.status='active' LIMIT 1`)
    .bind(connectionId,scope.tenantId,scope.spaceId,scope.projectId??null,scope.userId,
      scope.tenantId,scope.spaceId,scope.projectId??null,scope.userId).first<CommunicationIdentity>();
}
async function providerKeyFor(env:AgentsEnv,identity:CommunicationIdentity,account:AgentMailAccount){
  if(account.mode==="naelao_managed")return env.AGENTMAIL_API_KEY??"";
  if(!account.credential_ciphertext||!account.credential_iv)throw new Error("agentmail_credential_unavailable");
  return String((await openCommunication(env,identity,account.id,{ciphertext:account.credential_ciphertext,iv:account.credential_iv,algorithm:"aes-256-gcm"})).apiKey??"");
}
type AgentMailUsagePoint={timestamp:string;value:number};
function latestAgentMailUsagePoint(payload:Record<string,unknown>,name:string):AgentMailUsagePoint{
  const source=payload[name];
  if(!Array.isArray(source)||source.length===0)throw new Error("agentmail_usage_metric_unavailable");
  const points=source.map((entry)=>{
    if(!entry||typeof entry!=="object"||Array.isArray(entry))throw new Error("agentmail_usage_response_invalid");
    const point=entry as Record<string,unknown>;
    if(typeof point.timestamp!=="string"||!Number.isFinite(Date.parse(point.timestamp))
      ||!Number.isSafeInteger(point.value)||Number(point.value)<0)throw new Error("agentmail_usage_response_invalid");
    return {timestamp:new Date(point.timestamp).toISOString(),value:Number(point.value)};
  }).sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp));
  return points[0]!;
}

/** Read and retain only the documented inbox quantity totals. AgentMail exposes no monetary cost here. */
export async function readAgentMailUsage(env:AgentsEnv,scope:CommunicationScope,connectionId:string){
  if(!/^[A-Za-z0-9._:-]{1,160}$/.test(connectionId))throw new Error("agentmail_usage_invalid_connection");
  const account=await env.PLATFORM_DB.prepare(`SELECT * FROM assistant_agentmail_accounts
    WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=? AND status='active' LIMIT 1`)
    .bind(connectionId,scope.tenantId,scope.spaceId,scope.projectId??null,scope.userId).first<AgentMailAccount>();
  if(!account)throw new Error("agentmail_usage_account_not_found");
  const identity=await env.PLATFORM_DB.prepare(`SELECT * FROM assistant_communication_identities
    WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=? AND status='active' LIMIT 1`)
    .bind(account.assistant_identity_id,scope.tenantId,scope.spaceId,scope.projectId??null,scope.userId).first<CommunicationIdentity>();
  if(!identity)throw new Error("agentmail_usage_identity_unavailable");
  const key=await providerKeyFor(env,identity,account);
  if(!key)throw new Error("agentmail_usage_credentials_unavailable");
  const query=new URLSearchParams({period:"86400",limit:"1",descending:"true"});
  const response=await provider(env,key,`/inboxes/${encodeURIComponent(account.inbox_id)}/metrics/usage?${query}`,{signal:AbortSignal.timeout(10_000)},account.provider_region);
  const storage=latestAgentMailUsagePoint(response,"storage_bytes");
  const messages=latestAgentMailUsagePoint(response,"message_count");
  const threads=latestAgentMailUsagePoint(response,"thread_count");
  const pointAt=[storage.timestamp,messages.timestamp,threads.timestamp].sort().at(-1)!;
  const usage={storageBytes:storage.value,messageCount:messages.value,threadCount:threads.value};
  const current=await env.PLATFORM_DB.prepare(`SELECT status,credential_ciphertext,credential_iv FROM assistant_agentmail_accounts
    WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND owner_user_id=? LIMIT 1`)
    .bind(connectionId,scope.tenantId,scope.spaceId,scope.projectId??null,scope.userId)
    .first<{status:string;credential_ciphertext:string|null;credential_iv:string|null}>();
  if(!current||current.status!=="active")throw new Error("agentmail_usage_connection_revoked");
  if(current.credential_ciphertext!==account.credential_ciphertext||current.credential_iv!==account.credential_iv)
    throw new Error("agentmail_usage_connection_changed");
  const connectionHash=await hashString(connectionId);
  const evidenceHash=await hashString(JSON.stringify([pointAt,usage]));
  const id=`amu_${await hashString(`${scope.tenantId}\0${connectionHash}\0${pointAt}\0${evidenceHash}`)}`;
  const observedAt=new Date().toISOString();
  const saved=await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_agentmail_usage_snapshots(
      id,tenant_id,space_id,project_id,owner_user_id,connection_ref_sha256,point_at,storage_bytes,message_count,thread_count,
      evidence_sha256,source_api,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?,? ,?,'agentmail.inbox.metrics.usage',?)`)
    .bind(id,scope.tenantId,scope.spaceId,scope.projectId??null,scope.userId,connectionHash,pointAt,usage.storageBytes,
      usage.messageCount,usage.threadCount,evidenceHash,observedAt).run();
  return {connectionId,scope:"agentmail_inbox",region:providerRegion(account.provider_region),usage,pointAt,observedAt,sourceApi:"agentmail.inbox.metrics.usage",
    provenance:"provider_api_observed",inserted:saved.meta.changes===1,replayed:saved.meta.changes!==1,
    notice:"These are cumulative provider usage quantities, not monetary costs or Naelao credit charges."};
}
async function ensurePod(env:AgentsEnv,tenantId:string,region:string){
  const existing=await env.PLATFORM_DB.prepare("SELECT pod_id FROM assistant_agentmail_pods WHERE tenant_id=? AND status='active'").bind(tenantId).first<{pod_id:string}>();
  if(existing)return existing.pod_id;
  if(!env.AGENTMAIL_API_KEY)throw new Error("agentmail_managed_provisioning_not_configured");
  const client=await stableClientId(`naelao:customer-pod:${tenantId}`);
  let pod:Record<string,unknown>;
  try{pod=await provider(env,env.AGENTMAIL_API_KEY,"/pods",{method:"POST",body:JSON.stringify({name:`Naelao customer ${tenantId.slice(0,12)}`,client_id:client})},region);}
  catch(error){
    // A timeout after provider creation is reconciled by the same provider idempotency key.
    if(!(error instanceof Error&&error.message.startsWith("agentmail_provider_409")))throw error;
    const list=await provider(env,env.AGENTMAIL_API_KEY,`/pods?client_id=${encodeURIComponent(client)}`,{},region);
    const items=(list.pods as Array<Record<string,unknown>>|undefined)??[];pod=items.find(item=>item.client_id===client)??{};
  }
  const podId=typeof pod.pod_id==="string"?pod.pod_id:"";
  if(!podId)throw new Error("agentmail_pod_reconciliation_required");
  const now=new Date().toISOString();
  await env.PLATFORM_DB.prepare("INSERT INTO assistant_agentmail_pods(tenant_id,pod_id,status,created_at,updated_at) VALUES(?,?,'active',?,?) ON CONFLICT(tenant_id) DO UPDATE SET pod_id=excluded.pod_id,status='active',updated_at=excluded.updated_at")
    .bind(tenantId,podId,now,now).run();
  return podId;
}
async function findManagedPod(env:AgentsEnv,tenantId:string,region:string){
  const existing=await env.PLATFORM_DB.prepare("SELECT pod_id FROM assistant_agentmail_pods WHERE tenant_id=? AND status='active'").bind(tenantId).first<{pod_id:string}>();
  if(existing)return existing.pod_id;
  if(!env.AGENTMAIL_API_KEY)return null;
  const client=await stableClientId(`naelao:customer-pod:${tenantId}`);
  const list=await provider(env,env.AGENTMAIL_API_KEY,`/pods?client_id=${encodeURIComponent(client)}`,{},region);
  const pods=(list.pods as Array<Record<string,unknown>>|undefined)??[];
  const found=pods.find(item=>item.client_id===client);
  const podId=typeof found?.pod_id==="string"?found.pod_id:"";
  if(!podId)return null;
  const at=new Date().toISOString();
  await env.PLATFORM_DB.prepare("INSERT INTO assistant_agentmail_pods(tenant_id,pod_id,status,created_at,updated_at) VALUES(?,?,'active',?,?) ON CONFLICT(tenant_id) DO UPDATE SET pod_id=excluded.pod_id,status='active',updated_at=excluded.updated_at")
    .bind(tenantId,podId,at,at).run();
  return podId;
}
async function findManagedInbox(env:AgentsEnv,key:string,podId:string,clientId:string,region:string){
  let pageToken:string|undefined;
  for(let page=0;page<20;page++){
    const query=new URLSearchParams({limit:"100"});if(pageToken)query.set("page_token",pageToken);
    const response=await provider(env,key,`/pods/${encodeURIComponent(podId)}/inboxes?${query}`,{},region);
    const entries=(response.inboxes as Array<Record<string,unknown>>|undefined)??[];
    const found=entries.find(item=>item.client_id===clientId);
    if(found){
      if(typeof found.inbox_id!=="string"||typeof found.email!=="string"||found.pod_id!==podId)throw new Error("agentmail_inbox_reconciliation_invalid");
      return {inbox_id:found.inbox_id,email:found.email,pod_id:podId};
    }
    pageToken=typeof response.next_page_token==="string"&&response.next_page_token?response.next_page_token:undefined;
    if(!pageToken)return null;
  }
  throw new Error("agentmail_inbox_reconciliation_incomplete");
}
async function deferManagedOperationReconciliation(env:AgentsEnv,operationId:string,tenantId:string,errorCode:string){
  const prior=await env.PLATFORM_DB.prepare("SELECT reconcile_attempts FROM managed_service_operations WHERE operation_id=? AND tenant_id=? AND status IN ('running','uncertain')")
    .bind(operationId,tenantId).first<{reconcile_attempts:number}>();
  if(!prior)return;
  const at=new Date(),attempts=(prior.reconcile_attempts??0)+1;
  const delayMs=Math.min(24*60*60_000,5*60_000*2**Math.min(attempts-1,8));
  await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='uncertain',lease_until=NULL,error_code=?,
    reconcile_attempts=?,last_reconciled_at=?,next_reconcile_at=?,updated_at=?
    WHERE operation_id=? AND tenant_id=? AND status IN ('running','uncertain')`)
    .bind(errorCode,attempts,at.toISOString(),new Date(at.getTime()+delayMs).toISOString(),at.toISOString(),operationId,tenantId).run();
}
type ManagedAgentMailPrice={planTier:string;capabilityVersion:number;priceVersion:string;credits:number;maxCredits:number;maxOperationsPerPeriod:number|null};
async function resolveManagedAgentMailPrice(env:AgentsEnv,scope:CommunicationScope,operation:"provision"|"renew",region:string,now=new Date()):Promise<ManagedAgentMailPrice>{
  const org=await env.PLATFORM_DB.prepare("SELECT plan_tier FROM orgs WHERE id=? AND status='active'").bind(scope.tenantId).first<{plan_tier:string}>();
  if(!org)throw new Error("managed_service_tenant_unavailable");
  const entitlement=await env.PLATFORM_DB.prepare(`SELECT e.capability_version,e.price_version,e.credits_per_operation,e.max_credits_per_operation,e.max_operations_per_period
    FROM managed_service_plan_entitlements e JOIN managed_service_capability_versions c
      ON c.provider=e.provider AND c.service_id=e.service_id AND c.version=e.capability_version
    WHERE e.plan_tier=? AND e.provider='agentmail' AND e.service_id='agentmail' AND e.operation_name=? AND e.region=?
      AND e.status='active' AND e.verified_by IS NOT NULL AND e.verified_at IS NOT NULL AND e.valid_until>?
      AND e.credits_per_operation IS NOT NULL AND e.credits_per_operation>0 AND e.credits_per_operation<=e.max_credits_per_operation
      AND c.status='verified' AND c.valid_until>? AND c.version=(SELECT MAX(latest.version) FROM managed_service_capability_versions latest
        WHERE latest.provider=c.provider AND latest.service_id=c.service_id)
      AND EXISTS(SELECT 1 FROM json_each(c.operations_json) WHERE value=e.operation_name)
      AND EXISTS(SELECT 1 FROM json_each(c.regions_json) WHERE value=e.region)
      AND EXISTS(SELECT 1 FROM json_each(c.account_modes_json) WHERE value='naelao_managed') LIMIT 1`)
    .bind(org.plan_tier,operation,region,now.toISOString(),now.toISOString())
    .first<{capability_version:number;price_version:string;credits_per_operation:number|null;max_credits_per_operation:number;max_operations_per_period:number|null}>();
  if(!entitlement)throw new Error("managed_service_price_unconfigured");
  return {planTier:org.plan_tier,capabilityVersion:entitlement.capability_version,priceVersion:entitlement.price_version,
    credits:entitlement.credits_per_operation!,maxCredits:entitlement.max_credits_per_operation,maxOperationsPerPeriod:entitlement.max_operations_per_period};
}
async function resolveOptionalAgentMailRenewalPrice(env:AgentsEnv,scope:CommunicationScope,region:string,now=new Date()){
  try{return await resolveManagedAgentMailPrice(env,scope,"renew",region,now);}
  catch(error){if(error instanceof Error&&error.message==="managed_service_price_unconfigured")return null;throw error;}
}
export async function createManagedAgentMailQuote(env:AgentsEnv,scope:CommunicationScope,identity:CommunicationIdentity,input:{displayName?:string},now=new Date()){
  const {agentId}=await platformIdentity(env,scope,identity);
  const capability=await requireManagedServiceCapability(env.PLATFORM_DB,{provider:"agentmail",serviceId:"agentmail",operation:"provision",connectionMode:"naelao_managed",...(env.AGENTMAIL_REGION?{region:env.AGENTMAIL_REGION}:{})});
  const region=env.AGENTMAIL_REGION;if(!region)throw new Error("managed_service_region_not_verified");providerRegion(region);
  const display=input.displayName??"Naelao Assistant";
  if(display.length<1||display.length>120||/[\u0000-\u001f\u007f]/.test(display))throw new Error("agentmail_display_name_invalid");
  const price=await resolveManagedAgentMailPrice(env,scope,"provision",region,now);
  if(price.capabilityVersion!==capability.version)throw new Error("managed_service_capability_changed");
  const inboxClient=await stableClientId(`naelao:managed-inbox:${scope.tenantId}:${agentId}`);
  const requestSpec={tenantId:scope.tenantId,spaceId:scope.spaceId,projectId:scope.projectId??null,agentId,domain:env.AGENTMAIL_DEFAULT_DOMAIN??"",display,capabilityVersion:capability.version,region};
  const requestSha256=await hashString(JSON.stringify(requestSpec));
  const quoteId=`msq_${crypto.randomUUID().replaceAll("-","")}`;
  const expiresAt=new Date(now.getTime()+180_000).toISOString();
  const renewal=await resolveOptionalAgentMailRenewalPrice(env,scope,region,now);
  await env.PLATFORM_DB.prepare(`INSERT INTO managed_service_operation_quotes(
    quote_id,tenant_id,space_id,project_id,requester_user_id,plan_tier,provider,service_id,operation_name,region,
    capability_version,price_version,credits,request_sha256,renewal_credits,renewal_price_version,renewal_capability_version,
    renewal_max_credits_per_operation,status,expires_at,created_at)
    VALUES(?,?,?,?,?,?,'agentmail','agentmail','provision',?,?,?,?,?,?,?,?,?,'quoted',?,?)`)
    .bind(quoteId,scope.tenantId,scope.spaceId,scope.projectId??null,scope.userId,price.planTier,region,price.capabilityVersion,
      price.priceVersion,price.credits,requestSha256,renewal?.credits??null,renewal?.priceVersion??null,renewal?.capabilityVersion??null,
      renewal?.maxCredits??null,expiresAt,now.toISOString()).run();
  return {quoteId,provider:"agentmail",serviceId:"agentmail",operationName:"provision",region,credits:price.credits,creditUnit:"naelao_credit",
    priceVersion:price.priceVersion,maxCreditsPerOperation:price.maxCredits,renewalCredits:renewal?.credits??null,
    renewalPriceVersion:renewal?.priceVersion??null,renewalMaxCreditsPerOperation:renewal?.maxCredits??null,
    maxCreditsPerPeriod:Math.min(10_000_000,Math.max(price.maxCredits,renewal?.maxCredits??price.maxCredits)*2),
    autoRenewAvailable:!!renewal,status:"quoted",expiresAt};
}
export async function provisionManagedAgentMail(env:AgentsEnv,scope:CommunicationScope,identity:CommunicationIdentity,displayName?:string,quoteId?:string){
  if(!env.AGENTMAIL_API_KEY||!env.AGENTMAIL_DEFAULT_DOMAIN)throw new Error("agentmail_managed_provisioning_not_configured");
  if(!env.AGENTMAIL_WEBHOOK_URL||!env.AGENTPORT_EVENT_RECEIVER_URL)throw new Error("agentmail_event_delivery_not_configured");
  const {agentId}=await platformIdentity(env,scope,identity);
  const found=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE tenant_id=? AND agentport_agent_id=? AND mode='naelao_managed' AND status IN ('active','provisioning','billing_hold') ORDER BY created_at LIMIT 1").bind(scope.tenantId,agentId).first<AgentMailAccount>();
  if(found?.status==="active"){
    if((found as AgentMailAccount&{retire_after?:string|null}).retire_after)await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET retire_after=NULL,status='active',updated_at=? WHERE id=? AND status='active'").bind(new Date().toISOString(),found.id).run();
    await recordManagedServiceAccount(env,found,"active");
    return {connectionId:found.id,address:found.email_address,status:found.status,agentportAgentId:agentId};
  }
  if(found&&["provisioning","billing_hold"].includes(found.status))
    return {connectionId:found.id,address:found.email_address,status:found.status,pending:true,agentportAgentId:agentId};
  const capability=await requireManagedServiceCapability(env.PLATFORM_DB,{provider:"agentmail",serviceId:"agentmail",operation:"provision",connectionMode:"naelao_managed",...(env.AGENTMAIL_REGION?{region:env.AGENTMAIL_REGION}:{})});
  const region=env.AGENTMAIL_REGION;if(!region)throw new Error("managed_service_region_not_verified");
  providerRegion(region);
  if(!quoteId||!/^msq_[A-Fa-f0-9]{32}$/.test(quoteId))throw new Error("managed_service_quote_required");
  const opId=await stableClientId(`naelao:email-provision:${scope.tenantId}:${agentId}`);const now=Date.now();const timestamp=new Date(now).toISOString();
  const inboxClient=await stableClientId(`naelao:managed-inbox:${scope.tenantId}:${agentId}`);
  const display=displayName??"Naelao Assistant";
  if(display.length<1||display.length>120||/[\u0000-\u001f\u007f]/.test(display))throw new Error("agentmail_display_name_invalid");
  const quote=await env.PLATFORM_DB.prepare(`SELECT tenant_id,space_id,project_id,requester_user_id,plan_tier,provider,service_id,operation_name,
      region,capability_version,price_version,credits,request_sha256,renewal_credits,renewal_price_version,renewal_capability_version,
      renewal_max_credits_per_operation,status,operation_id,expires_at
    FROM managed_service_operation_quotes WHERE quote_id=?`).bind(quoteId)
    .first<{tenant_id:string;space_id:string;project_id:string|null;requester_user_id:string;plan_tier:string;provider:string;service_id:string;operation_name:string;
      region:string;capability_version:number;price_version:string;credits:number;request_sha256:string|null;renewal_credits:number|null;renewal_price_version:string|null;
      renewal_capability_version:number|null;renewal_max_credits_per_operation:number|null;status:string;operation_id:string|null;expires_at:string}>();
  const acceptedOperationQuote=quote?.status==="consumed"&&quote.operation_id===opId;
  let price:ManagedAgentMailPrice;
  let renewalPrice:ManagedAgentMailPrice|null;
  if(acceptedOperationQuote){
    if(quote.capability_version!==capability.version)throw new Error("managed_service_capability_changed");
    price={planTier:quote.plan_tier,capabilityVersion:quote.capability_version,priceVersion:quote.price_version,credits:quote.credits,
      maxCredits:Math.max(quote.credits,quote.renewal_max_credits_per_operation??quote.credits),maxOperationsPerPeriod:null};
    renewalPrice=quote.renewal_credits!==null&&quote.renewal_price_version!==null&&quote.renewal_capability_version!==null
      ?{planTier:quote.plan_tier,capabilityVersion:quote.renewal_capability_version,priceVersion:quote.renewal_price_version,
        credits:quote.renewal_credits,maxCredits:quote.renewal_max_credits_per_operation??quote.renewal_credits,maxOperationsPerPeriod:null}
      :null;
  }else{
    price=await resolveManagedAgentMailPrice(env,scope,"provision",region);
    if(price.capabilityVersion!==capability.version)throw new Error("managed_service_capability_changed");
    renewalPrice=await resolveOptionalAgentMailRenewalPrice(env,scope,region);
  }
  const requestSpec={tenantId:scope.tenantId,spaceId:scope.spaceId,projectId:scope.projectId??null,agentId,domain:env.AGENTMAIL_DEFAULT_DOMAIN,display,capabilityVersion:capability.version,region};
  const requestHash=await hashString(JSON.stringify(requestSpec));
  if(!quote||quote.tenant_id!==scope.tenantId||quote.space_id!==scope.spaceId||quote.project_id!==(scope.projectId??null)
    ||quote.requester_user_id!==scope.userId||quote.plan_tier!==price.planTier||quote.provider!=="agentmail"||quote.service_id!=="agentmail"
    ||quote.operation_name!=="provision"||quote.region!==region||quote.capability_version!==capability.version||quote.price_version!==price.priceVersion
    ||quote.credits!==price.credits||quote.request_sha256!==requestHash
    ||quote.renewal_credits!==(renewalPrice?.credits??null)||quote.renewal_price_version!==(renewalPrice?.priceVersion??null)
    ||quote.renewal_capability_version!==(renewalPrice?.capabilityVersion??null)
    ||quote.renewal_max_credits_per_operation!==(renewalPrice?.maxCredits??null))throw new Error("managed_service_quote_terms_conflict");
  const priorOperation=await env.PLATFORM_DB.prepare("SELECT operation_id,quote_id,status FROM managed_service_operations WHERE operation_id=? AND tenant_id=?")
    .bind(opId,scope.tenantId).first<{operation_id:string;quote_id:string|null;status:string}>();
  if(priorOperation&&priorOperation.quote_id!==quoteId)throw new Error("managed_service_operation_conflict");
  if(quote.status==="consumed"&&quote.operation_id!==opId)throw new Error("managed_service_quote_already_used");
  if(quote.status==="quoted"&&Date.parse(quote.expires_at)<=now)throw new Error("managed_service_quote_expired");
  const mandateScope:CommunicationScope={...scope,role:"product_end_user"};
  const mandateId=await ensureOrganizationPayerMandate(env,mandateScope,{mandateKey:`agentmail:${agentId}`,provider:"agentmail",serviceId:"agentmail",
    maxCreditsPerOperation:Math.max(price.maxCredits,renewalPrice?.maxCredits??price.maxCredits),
    maxCreditsPerPeriod:Math.min(10_000_000,Math.max(price.maxCredits,renewalPrice?.maxCredits??price.maxCredits)*2),
    periodDays:30,allowRenewal:!!renewalPrice,agentPortAgentId:agentId});
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_operations(
      operation_id,tenant_id,space_id,project_id,provider,service_id,capability_version,operation_name,region,idempotency_key,
      request_sha256,request_json,status,quote_id,price_version,reserved_credits,created_at,updated_at)
      VALUES(?,?,?,?,'agentmail','agentmail',?,'provision',?,?,?,?, 'pending',?,?,?, ?,?)`)
      .bind(opId,scope.tenantId,scope.spaceId,scope.projectId??null,capability.version,region,opId,requestHash,JSON.stringify(requestSpec),quoteId,price.priceVersion,price.credits,timestamp,timestamp),
    env.PLATFORM_DB.prepare(`UPDATE managed_service_operation_quotes SET status='consumed',operation_id=?,consumed_at=?
      WHERE quote_id=? AND status='quoted' AND expires_at>? AND request_sha256=? AND tenant_id=? AND space_id=? AND project_id IS ?
        AND requester_user_id=? AND plan_tier=? AND provider='agentmail' AND service_id='agentmail' AND operation_name='provision'
        AND region=? AND capability_version=? AND price_version=? AND credits=? AND EXISTS(
          SELECT 1 FROM managed_service_operations WHERE operation_id=? AND tenant_id=? AND quote_id=? AND request_sha256=?)`)
      .bind(opId,timestamp,quoteId,timestamp,requestHash,scope.tenantId,scope.spaceId,scope.projectId??null,scope.userId,price.planTier,
        region,capability.version,price.priceVersion,price.credits,opId,scope.tenantId,quoteId,requestHash),
  ]);
  const consumedQuote=await env.PLATFORM_DB.prepare("SELECT status,operation_id FROM managed_service_operation_quotes WHERE quote_id=? AND tenant_id=?")
    .bind(quoteId,scope.tenantId).first<{status:string;operation_id:string|null}>();
  if(consumedQuote?.status!=="consumed"||consumedQuote.operation_id!==opId)throw new Error("managed_service_quote_already_used");
  let registryOperation=await env.PLATFORM_DB.prepare("SELECT request_sha256,quote_id,status,lease_until,reconcile_attempts FROM managed_service_operations WHERE operation_id=? AND tenant_id=?")
    .bind(opId,scope.tenantId).first<{request_sha256:string;quote_id:string|null;status:string;lease_until:string|null;reconcile_attempts:number}>();
  if(!registryOperation||registryOperation.request_sha256!==requestHash||registryOperation.quote_id!==quoteId)throw new Error("managed_service_operation_conflict");
  if(registryOperation.status==="running"){
    if(registryOperation.lease_until&&Date.parse(registryOperation.lease_until)>now)return {status:"provisioning",pending:true,agentportAgentId:agentId};
      await env.PLATFORM_DB.prepare("UPDATE managed_service_operations SET status='uncertain',lease_until=NULL,error_code='operation_lease_expired',next_reconcile_at=?,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='running'")
      .bind(new Date(now+5*60_000).toISOString(),timestamp,opId,scope.tenantId).run();
    registryOperation={...registryOperation,status:"uncertain",lease_until:null};
  }
  const reconcileExistingEffect=registryOperation.status==="uncertain";
  if(registryOperation.status==="complete")return {status:"unknown",pending:true,reconciliationRequired:true,agentportAgentId:agentId};
  if(["failed","cancelled"].includes(registryOperation.status))throw new Error("managed_service_operation_closed");
  await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_agentmail_operations(operation_id,tenant_id,assistant_identity_id,operation,status,created_at,updated_at) VALUES(?,?,?,'provision','pending',?,?)")
    .bind(opId,scope.tenantId,identity.id,timestamp,timestamp).run();
  const claimed=await env.PLATFORM_DB.prepare(`UPDATE assistant_agentmail_operations SET status='running',attempt=attempt+1,lease_until=?,updated_at=? WHERE operation_id=? AND ((status IN ('pending','held') AND (lease_until IS NULL OR lease_until<=?)) OR (status='running' AND lease_until<=?))`)
    .bind(new Date(now+120_000).toISOString(),timestamp,opId,timestamp,timestamp).run();
  if(!claimed.meta.changes)return {status:"provisioning",pending:true,agentportAgentId:agentId};
  let recoveredInbox:{inbox_id:string;email:string;pod_id:string}|null=null;
  if(reconcileExistingEffect){
    try{
      const podId=await findManagedPod(env,scope.tenantId,region);
      recoveredInbox=podId?await findManagedInbox(env,env.AGENTMAIL_API_KEY, podId,inboxClient,region):null;
    }catch{
      await deferManagedOperationReconciliation(env,opId,scope.tenantId,"agentmail_inbox_reconciliation_unavailable");
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_operations SET status='held',lease_until=NULL,updated_at=? WHERE operation_id=? AND status='running'").bind(new Date().toISOString(),opId).run();
      return {status:"uncertain",pending:true,reconciliationRequired:true,agentportAgentId:agentId};
    }
    if(!recoveredInbox){
      await deferManagedOperationReconciliation(env,opId,scope.tenantId,"agentmail_inbox_not_yet_visible");
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_operations SET status='held',lease_until=NULL,updated_at=? WHERE operation_id=? AND status='running'").bind(new Date().toISOString(),opId).run();
      return {status:"uncertain",pending:true,reconciliationRequired:true,agentportAgentId:agentId};
    }
  }
  const operationStarted=await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,error_code=NULL,
    last_reconciled_at=CASE WHEN status='uncertain' THEN ? ELSE last_reconciled_at END,next_reconcile_at=NULL,updated_at=?
    WHERE operation_id=? AND tenant_id=? AND status ${reconcileExistingEffect?"='uncertain'":"IN ('pending','held')"}`)
    .bind(new Date(now+120_000).toISOString(),timestamp,timestamp,opId,scope.tenantId).run();
  if(!operationStarted.meta.changes){
    await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_operations SET status='held',lease_until=NULL,updated_at=? WHERE operation_id=? AND status='running'").bind(timestamp,opId).run();
    return {status:"provisioning",pending:true,agentportAgentId:agentId};
  }
  const workflowId=`agentmail_rent_${opId}`;const scopeForBilling:CommunicationScope={...scope,role:"product_end_user"};
  let reserved=false,providerDispatched=false;
  try{
    await reserveManagedServiceCredits(env,scopeForBilling,{reservationId:workflowId,operationId:opId,provider:"agentmail",serviceId:"agentmail",operationName:"provision",region,credits:price.credits,priceVersion:price.priceVersion,quoteId,agentPortAgentId:agentId,payerMandateId:mandateId});reserved=true;
    await env.PLATFORM_DB.prepare("UPDATE managed_service_operations SET reservation_id=?,reserved_credits=?,price_version=?,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='running'")
      .bind(workflowId,price.credits,price.priceVersion,new Date().toISOString(),opId,scope.tenantId).run();
    await markManagedServiceCreditsUncertain(env,scopeForBilling,workflowId);
    providerDispatched=true;
    let podId=recoveredInbox?.pod_id??"";
    let inbox:Record<string,unknown>|null=recoveredInbox;
    if(!inbox){
      podId=await ensurePod(env,scope.tenantId,region);
      inbox=await provider(env,env.AGENTMAIL_API_KEY!,`/pods/${encodeURIComponent(podId)}/inboxes`,{method:"POST",body:JSON.stringify({domain:env.AGENTMAIL_DEFAULT_DOMAIN,display_name:display,client_id:inboxClient,metadata:{naelao_agent_id:agentId}})},region);
    }
    const inboxId=typeof inbox.inbox_id==="string"?inbox.inbox_id:"",address=typeof inbox.email==="string"?inbox.email:"";
    if(!inboxId||!address)throw new Error("agentmail_inbox_response_invalid");
    const connectionId=id("amc");
    await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO assistant_agentmail_accounts(id,tenant_id,space_id,project_id,assistant_identity_id,agentport_agent_id,owner_user_id,mode,pod_id,inbox_id,email_address,status,activated_at,next_billing_at,created_at,updated_at,provider_region)
      VALUES(?,?,?,?,?,?,?,'naelao_managed',?,?,?,'provisioning',NULL,NULL,?,?,?)`).bind(connectionId,scope.tenantId,scope.spaceId,scope.projectId??null,identity.id,agentId,scope.userId,podId,inboxId,address,timestamp,timestamp,region).run();
    const account=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE tenant_id=? AND agentport_agent_id=? AND inbox_id=? ORDER BY created_at LIMIT 1").bind(scope.tenantId,agentId,inboxId).first<AgentMailAccount>();
    if(!account)throw new Error("agentmail_connection_store_unavailable");
    const link=await linkAgentPort(env,scope,identity,account,{type:"organization",id:scope.tenantId},false);
    await settleManagedServiceCredits(env,scopeForBilling,workflowId,price.credits);
    const activatedAt=new Date(now).toISOString();const next=addMonthlyAnniversary(activatedAt);
    await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET status='active',activated_at=?,next_billing_at=?,retire_after=?,last_error=NULL,updated_at=? WHERE id=?")
      .bind(activatedAt,next,renewalPrice?null:next,activatedAt,account.id).run();
    await recordManagedServiceAccount(env,{...account,status:"active"},"active",capability.version,region);
    await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_operations SET status='complete',result_ref=?,lease_until=NULL,error_code=NULL,updated_at=? WHERE operation_id=? AND status='running'")
      .bind(account.id,activatedAt,opId).run();
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET account_id=?,status='complete',lease_until=NULL,
      provider_operation_ref=?,result_ref=?,error_code=NULL,reconcile_attempts=reconcile_attempts+CASE WHEN ? THEN 1 ELSE 0 END,
      next_reconcile_at=NULL,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='running'`)
      .bind(account.id,account.inbox_id,account.id,reconcileExistingEffect?1:0,activatedAt,opId,scope.tenantId).run();
    return {connectionId:account.id,address,status:"active",priceCredits:price.credits,priceVersion:price.priceVersion,
      renewalCredits:renewalPrice?.credits??null,renewalPriceVersion:renewalPrice?.priceVersion??null,autoRenew:!!renewalPrice,...link};
  }catch(error){
    if(reserved&&!providerDispatched)await releaseManagedServiceCredits(env,scopeForBilling,workflowId,"no_effect").catch(()=>undefined);
    const code=error instanceof Error&&/^[a-z][a-z0-9_:-]{1,100}$/.test(error.message)?error.message:"agentmail_provisioning_failed";
    await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_operations SET status='held',lease_until=NULL,error_code=?,updated_at=? WHERE operation_id=? AND status='running'").bind(code,new Date().toISOString(),opId).run();
    if(providerDispatched)await deferManagedOperationReconciliation(env,opId,scope.tenantId,code);
    else await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',lease_until=NULL,error_code=?,next_reconcile_at=NULL,updated_at=?
      WHERE operation_id=? AND tenant_id=? AND status='running'`).bind(code,new Date().toISOString(),opId,scope.tenantId).run();
    throw error;
  }
}
export async function sweepManagedAgentMailReconciliations(env:AgentsEnv,now=new Date(),limit=10){
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)throw new Error("managed_service_reconciliation_limit_invalid");
  const due=await env.PLATFORM_DB.prepare(`SELECT o.operation_id,o.tenant_id,o.space_id,o.project_id,o.request_json,o.quote_id,
      i.id AS identity_id,i.tenant_id AS identity_tenant_id,i.space_id AS identity_space_id,i.project_id AS identity_project_id,
      i.scope_key,i.owner_user_id,i.email_address,i.address_hash,i.email_provider,i.email_status,i.status AS identity_status,i.autonomy_json
    FROM managed_service_operations o JOIN assistant_agentmail_operations a ON a.operation_id=o.operation_id
    JOIN assistant_communication_identities i ON i.id=a.assistant_identity_id
    WHERE o.provider='agentmail' AND o.service_id='agentmail' AND o.operation_name='provision' AND o.status='uncertain'
      AND o.next_reconcile_at IS NOT NULL AND o.next_reconcile_at<=?
    ORDER BY o.next_reconcile_at,o.created_at LIMIT ?`)
    .bind(now.toISOString(),limit).all<Record<string,string|null>>();
  let reconciled=0,deferred=0,failed=0;
  for(const row of due.results){
    try{
      const spec=JSON.parse(row.request_json??"{}") as Record<string,unknown>;
      if(typeof row.identity_id!=="string"||row.identity_tenant_id!==row.tenant_id||row.identity_space_id!==row.space_id
        ||(row.identity_project_id??null)!==(row.project_id??null)||typeof row.owner_user_id!=="string"
        ||spec.tenantId!==row.tenant_id||spec.spaceId!==row.space_id||spec.projectId!==(row.project_id??null)
        ||typeof spec.agentId!=="string"||typeof spec.display!=="string"||typeof spec.region!=="string"){
        await deferManagedOperationReconciliation(env,row.operation_id!,row.tenant_id!,"managed_service_reconciliation_scope_invalid");failed++;continue;
      }
      const identity:CommunicationIdentity={id:row.identity_id,tenant_id:row.identity_tenant_id!,space_id:row.identity_space_id!,project_id:row.identity_project_id??null,
        scope_key:row.scope_key!,owner_user_id:row.owner_user_id,email_address:row.email_address??null,address_hash:row.address_hash??null,email_provider:row.email_provider!,
        email_status:row.email_status!,status:row.identity_status!,autonomy_json:row.autonomy_json!};
      const scope:CommunicationScope={tenantId:row.tenant_id!,spaceId:row.space_id!,...(row.project_id?{projectId:row.project_id}:{}),userId:identity.owner_user_id,role:"product_end_user"};
      const result=await provisionManagedAgentMail(env,scope,identity,spec.display,row.quote_id??undefined);
      if(result.status==="active")reconciled++;else deferred++;
    }catch(error){
      const code=error instanceof Error&&/^[a-z][a-z0-9_:-]{1,100}$/.test(error.message)?error.message:"managed_service_reconciliation_failed";
      await deferManagedOperationReconciliation(env,row.operation_id!,row.tenant_id!,code).catch(()=>undefined);
      failed++;
    }
  }
  const syncDue=await env.PLATFORM_DB.prepare(`SELECT o.operation_id,o.tenant_id,o.space_id,o.project_id,o.account_id,o.request_json,
      a.id AS linked_account_id,a.tenant_id AS account_tenant_id,a.space_id AS account_space_id,a.project_id AS account_project_id,
      a.owner_user_id,a.status AS account_status,i.id AS identity_id,i.tenant_id AS identity_tenant_id,i.space_id AS identity_space_id,
      i.project_id AS identity_project_id,i.owner_user_id AS identity_owner_user_id,i.status AS identity_status
    FROM managed_service_operations o LEFT JOIN assistant_agentmail_accounts a ON a.id=o.account_id
    LEFT JOIN assistant_communication_identities i ON i.id=a.assistant_identity_id
    WHERE o.provider='agentmail' AND o.service_id='agentmail' AND o.operation_name='agentport_sync' AND o.status='uncertain'
      AND o.next_reconcile_at IS NOT NULL AND o.next_reconcile_at<=?
    ORDER BY o.next_reconcile_at,o.created_at LIMIT ?`)
    .bind(now.toISOString(),Math.max(0,limit-due.results.length)).all<Record<string,string|null>>();
  for(const row of syncDue.results){
    let spec:Record<string,unknown>={};
    try{spec=JSON.parse(row.request_json??"{}")}catch{}
    const validScope=typeof row.operation_id==="string"&&typeof row.tenant_id==="string"&&typeof row.space_id==="string"
      &&row.linked_account_id===row.account_id&&row.account_tenant_id===row.tenant_id&&row.account_space_id===row.space_id
      &&(row.account_project_id??null)===(row.project_id??null)&&row.account_status==="active"&&typeof row.owner_user_id==="string"
      &&row.identity_id&&row.identity_tenant_id===row.tenant_id&&row.identity_space_id===row.space_id
      &&(row.identity_project_id??null)===(row.project_id??null)&&row.identity_owner_user_id===row.owner_user_id&&row.identity_status==="active"
      &&spec.connectionId===row.account_id&&spec.ownerUserId===row.owner_user_id&&spec.projectId===(row.project_id??null)
      &&typeof spec.requestId==="string"&&/^[A-Za-z0-9._:-]{1,160}$/.test(spec.requestId);
    if(!validScope){
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',lease_until=NULL,next_reconcile_at=NULL,
        error_code='agentport_sync_scope_changed',updated_at=? WHERE operation_id=? AND tenant_id=? AND status='uncertain'`)
        .bind(now.toISOString(),row.operation_id,row.tenant_id).run();
      deferred++;continue;
    }
    try{
      const scope:CommunicationScope={tenantId:row.tenant_id!,spaceId:row.space_id!,...(row.project_id?{projectId:row.project_id}:{}),userId:row.owner_user_id!,role:"owner"};
      const result=await syncAgentPortAgentMail(env,scope,row.account_id!,String(spec.requestId));
      if(result.synced)reconciled++;else deferred++;
    }catch(error){
      const code=error instanceof Error&&/^[a-z][a-z0-9_:-]{1,100}$/.test(error.message)?error.message:"agentport_sync_reconciliation_failed";
      await deferManagedOperationReconciliation(env,row.operation_id!,row.tenant_id!,code).catch(()=>undefined);
      failed++;
    }
  }
  const revokeDue=await env.PLATFORM_DB.prepare(`SELECT o.operation_id,o.tenant_id,o.request_json,o.status,o.next_reconcile_at
    FROM managed_service_operations o
    WHERE o.provider='agentmail' AND o.service_id='agentmail' AND o.operation_name='owner_unlink' AND o.status='uncertain'
      AND o.next_reconcile_at IS NOT NULL AND o.next_reconcile_at<=?
    ORDER BY o.next_reconcile_at,o.created_at LIMIT ?`)
    .bind(now.toISOString(),Math.max(0,limit-due.results.length-syncDue.results.length)).all<Record<string,string|null>>();
  for(const row of revokeDue.results){
    let spec:Record<string,unknown>={};
    try{spec=JSON.parse(row.request_json??"{}")}catch{}
    const linkId=typeof spec.linkId==="string"?spec.linkId:"";
    const expectedResources=Array.isArray(spec.resources)?spec.resources as Array<Record<string,unknown>>:[];
    const validResources=Array.isArray(spec.resources)&&expectedResources.every(resource=>!!resource&&typeof resource==="object"&&!Array.isArray(resource)
      &&typeof resource.id==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/.test(resource.id)
      &&typeof resource.agentPortAccountId==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/.test(resource.agentPortAccountId));
    expectedResources.sort((left,right)=>String(left.id).localeCompare(String(right.id)));
    if(!row.operation_id||!row.tenant_id||!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/.test(linkId)||!validResources){
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',lease_until=NULL,next_reconcile_at=NULL,
        error_code='managed_service_owner_unlink_scope_invalid',updated_at=? WHERE operation_id=? AND tenant_id=? AND status='uncertain'`)
        .bind(now.toISOString(),row.operation_id,row.tenant_id).run();
      deferred++;continue;
    }
    const claim=await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,updated_at=?
      WHERE operation_id=? AND tenant_id=? AND status='uncertain' AND next_reconcile_at<=?`)
      .bind(new Date(now.getTime()+120_000).toISOString(),now.toISOString(),row.operation_id,row.tenant_id,now.toISOString()).run();
    if(!claim.meta.changes){deferred++;continue;}
    try{
      const link=await env.PLATFORM_DB.prepare(`SELECT id,owner_type,status FROM managed_service_owner_links WHERE id=? AND tenant_id=?`)
        .bind(linkId,row.tenant_id).first<{id:string;owner_type:string;status:string}>();
      const resources=await env.PLATFORM_DB.prepare(`SELECT id,agentport_account_id FROM managed_service_accounts
        WHERE owner_link_id=? AND tenant_id=? AND provider='agentmail' AND service_id='agentmail' AND connection_mode='user_connected'
          AND lifecycle_state IN ('revoking','revoked') ORDER BY id`)
        .bind(linkId,row.tenant_id).all<{id:string;agentport_account_id:string|null}>();
      const actualResources=resources.results.map(resource=>({id:resource.id,agentPortAccountId:resource.agentport_account_id}));
      if(!link||link.owner_type!=="user"||link.status!=="revoked"
        ||JSON.stringify(actualResources)!==JSON.stringify(expectedResources)){
        await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='held',lease_until=NULL,next_reconcile_at=NULL,
          error_code='managed_service_owner_unlink_scope_changed',last_reconciled_at=?,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='running'`)
          .bind(now.toISOString(),now.toISOString(),row.operation_id,row.tenant_id).run();
        deferred++;continue;
      }
      const results=await Promise.allSettled(expectedResources.map(resource=>agentPort(env,row.tenant_id!,
        `/accounts/${encodeURIComponent(String(resource.agentPortAccountId))}/revoke`,"POST",{})));
      if(results.some(result=>result.status==="rejected"))throw new Error("agentport_account_revoke_uncertain");
      const at=new Date().toISOString();
      const statements=[] as D1PreparedStatement[];
      if(actualResources.length)statements.push(env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET lifecycle_state='revoked',updated_at=?
          WHERE owner_link_id=? AND tenant_id=? AND id IN (${actualResources.map(()=>"?").join(",")}) AND lifecycle_state='revoking'`)
          .bind(at,linkId,row.tenant_id,...actualResources.map(resource=>resource.id)));
      statements.push(
        env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='complete',lease_until=NULL,error_code=NULL,
          next_reconcile_at=NULL,last_reconciled_at=?,updated_at=? WHERE operation_id=? AND tenant_id=? AND status='running'`)
          .bind(at,at,row.operation_id,row.tenant_id));
      await env.PLATFORM_DB.batch(statements);
      reconciled++;
    }catch(error){
      const code=error instanceof Error&&/^[a-z][a-z0-9_:-]{1,100}$/.test(error.message)?error.message:"managed_service_owner_unlink_reconciliation_failed";
      await deferManagedOperationReconciliation(env,row.operation_id,row.tenant_id,code).catch(()=>undefined);
      failed++;
    }
  }
  return {checked:due.results.length+syncDue.results.length+revokeDue.results.length,reconciled,deferred,failed};
}
export async function stopManagedAgentMailRenewal(env:AgentsEnv,scope:CommunicationScope,connectionId:string){
  const account=await env.PLATFORM_DB.prepare(`SELECT id,agentport_agent_id,next_billing_at,mode,status FROM assistant_agentmail_accounts
    WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ? LIMIT 1`)
    .bind(connectionId,scope.tenantId,scope.spaceId,scope.projectId??null)
    .first<{id:string;agentport_agent_id:string;next_billing_at:string|null;mode:string;status:string}>();
  if(!account||account.mode!=="naelao_managed")throw new Error("agentmail_managed_account_not_found");
  const mandateKey=`agentmail:${account.agentport_agent_id}`;
  const result=await revokeOrganizationPayerMandate(env,scope,mandateKey,"User stopped managed AgentMail renewal.");
  const at=new Date().toISOString();
  await env.PLATFORM_DB.prepare(`UPDATE assistant_agentmail_accounts SET retire_after=COALESCE(retire_after,next_billing_at),delete_at_period_end=1,updated_at=?
    WHERE id=? AND tenant_id=? AND mode='naelao_managed' AND status IN ('active','billing_hold')`)
    .bind(at,account.id,scope.tenantId).run();
  return {connectionId:account.id,renewalStopped:true,retireAfter:account.next_billing_at,...result};
}
export async function revokeAgentPortOwnerLink(env:AgentsEnv,scope:CommunicationScope,linkId:string){
  const link=await env.PLATFORM_DB.prepare(`SELECT id,owner_type,owner_id,status FROM managed_service_owner_links
    WHERE id=? AND tenant_id=? LIMIT 1`).bind(linkId,scope.tenantId)
    .first<{id:string;owner_type:string;owner_id:string;status:string}>();
  if(!link||link.owner_type!=="user"||link.owner_id!==scope.userId)throw new Error("managed_service_owner_link_not_found");
  const accounts=await env.PLATFORM_DB.prepare(`SELECT a.id,a.tenant_id,a.space_id,a.project_id,a.assistant_identity_id,a.agentport_agent_id,
      a.agentport_account_id,a.owner_user_id,a.mode,a.pod_id,a.inbox_id,a.email_address,a.credential_ciphertext,a.credential_iv,a.status,m.agentport_account_id AS linked_account_id
    FROM managed_service_accounts m JOIN assistant_agentmail_accounts a ON a.id=m.id
    WHERE m.owner_link_id=? AND m.tenant_id=? AND a.mode='user_connected' ORDER BY a.id LIMIT 200`)
    .bind(linkId,scope.tenantId).all<AgentMailAccount&{linked_account_id:string|null}>();
  const resources=accounts.results.map(account=>({id:account.id,agentPortAccountId:account.linked_account_id})).sort((left,right)=>left.id.localeCompare(right.id));
  if(accounts.results.some(account=>!account.linked_account_id))throw new Error("agentport_owner_link_resource_incomplete");
  const operationId=await stableClientId(`naelao:owner-link-revoke:${scope.tenantId}:${linkId}`);
  const requestJson=JSON.stringify({linkId,resources});
  const requestHash=await hashString(JSON.stringify({tenantId:scope.tenantId,spaceId:scope.spaceId,projectId:scope.projectId??null,requestJson}));
  const at=new Date().toISOString();
  await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_operations(
    operation_id,tenant_id,space_id,project_id,provider,service_id,operation_name,idempotency_key,request_sha256,request_json,status,created_at,updated_at)
    VALUES(?,?,?,?,'agentmail','agentmail','owner_unlink',?,?,?,'pending',?,?)`)
    .bind(operationId,scope.tenantId,scope.spaceId,scope.projectId??null,operationId,requestHash,requestJson,at,at).run();
  let operation=await env.PLATFORM_DB.prepare("SELECT request_sha256,status,lease_until FROM managed_service_operations WHERE operation_id=? AND tenant_id=?")
    .bind(operationId,scope.tenantId).first<{request_sha256:string;status:string;lease_until:string|null}>();
  if(!operation||operation.request_sha256!==requestHash)throw new Error("managed_service_operation_conflict");
  if(operation.status==="complete")return {revoked:true,accountCount:resources.length,deduplicated:true};
  const claim=await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,error_code=NULL,updated_at=?
    WHERE operation_id=? AND tenant_id=? AND status IN ('pending','held','uncertain')`)
    .bind(new Date(Date.now()+120_000).toISOString(),at,operationId,scope.tenantId).run();
  if(!claim.meta.changes){
    if(operation.status==="running"&&operation.lease_until&&Date.parse(operation.lease_until)>Date.now())return {revoked:false,pending:true,accountCount:resources.length};
    const expired=await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,error_code=NULL,updated_at=?
      WHERE operation_id=? AND tenant_id=? AND status='running' AND (lease_until IS NULL OR lease_until<=?)`)
      .bind(new Date(Date.now()+120_000).toISOString(),at,operationId,scope.tenantId,at).run();
    if(!expired.meta.changes)return {revoked:false,pending:true,accountCount:resources.length};
  }
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`UPDATE managed_service_owner_links SET status='revoked',revoked_by_user_id=?,revoked_at=COALESCE(revoked_at,?),updated_at=?
      WHERE id=? AND tenant_id=? AND owner_type='user' AND owner_id=?`)
      .bind(scope.userId,at,at,linkId,scope.tenantId,scope.userId),
    env.PLATFORM_DB.prepare(`UPDATE assistant_agentmail_accounts SET status='retired',credential_ciphertext=NULL,credential_iv=NULL,
      agentmail_webhook_secret_ciphertext=NULL,agentmail_webhook_secret_iv=NULL,agentport_webhook_secret_ciphertext=NULL,
      agentport_webhook_secret_iv=NULL,updated_at=? WHERE id IN (SELECT id FROM managed_service_accounts WHERE owner_link_id=? AND tenant_id=?) AND mode='user_connected'`)
      .bind(at,linkId,scope.tenantId),
    env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET lifecycle_state='revoking',updated_at=?
      WHERE owner_link_id=? AND tenant_id=? AND lifecycle_state IN ('active','provisioning','billing_hold','suspended')`)
      .bind(at,linkId,scope.tenantId),
  ]);
  try{
    const results=await Promise.allSettled(resources.map(resource=>
      agentPort(env,scope.tenantId,`/accounts/${encodeURIComponent(resource.agentPortAccountId!)}/revoke`,"POST",{})));
    if(results.some(result=>result.status==="rejected"))throw new Error("agentport_account_revoke_uncertain");
    await env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET lifecycle_state='revoked',updated_at=? WHERE owner_link_id=? AND tenant_id=? AND lifecycle_state='revoking'")
      .bind(new Date().toISOString(),linkId,scope.tenantId).run();
    await env.PLATFORM_DB.prepare("UPDATE managed_service_operations SET status='complete',lease_until=NULL,error_code=NULL,updated_at=? WHERE operation_id=? AND status='running'")
      .bind(new Date().toISOString(),operationId).run();
    return {revoked:true,accountCount:resources.length};
  }catch(error){
    const code=error instanceof Error&&/^[a-z][a-z0-9_:-]{1,100}$/.test(error.message)?error.message:"managed_service_owner_link_revoke_failed";
    await deferManagedOperationReconciliation(env,operationId,scope.tenantId,code);
    throw error;
  }
}
export async function connectUserAgentMail(env:AgentsEnv,scope:CommunicationScope,identity:CommunicationIdentity,input:{inboxId:string;apiKey:string;region?:string}){
  if(!env.AGENTMAIL_WEBHOOK_URL||!env.AGENTPORT_EVENT_RECEIVER_URL)throw new Error("agentmail_event_delivery_not_configured");
  if(!/^[A-Za-z0-9._:-]{1,200}$/.test(input.inboxId)||input.apiKey.length<16||input.apiKey.length>4096)throw new Error("agentmail_connection_invalid");
  const region=providerRegion(input.region??"us");
  const inbox=await provider(env,input.apiKey,`/inboxes/${encodeURIComponent(input.inboxId)}`,{},region);
  if(inbox.inbox_id!==input.inboxId||typeof inbox.email!=="string")throw new Error("agentmail_inbox_mismatch");
  const {agentId}=await platformIdentity(env,scope,identity);const now=new Date().toISOString();
  const existing=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE tenant_id=? AND agentport_agent_id=? AND inbox_id=?").bind(scope.tenantId,agentId,input.inboxId).first<AgentMailAccount>();
  const accountId=existing?.id??id("amc");const sealed=await sealCommunication(env,identity,accountId,{apiKey:input.apiKey});
  if(existing){
    if(existing.mode!=="user_connected"||existing.owner_user_id!==scope.userId)throw new Error("agentmail_account_owner_conflict");
    await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET credential_ciphertext=?,credential_iv=?,email_address=?,provider_region=?,status=CASE WHEN status='active' THEN status ELSE 'provisioning' END,last_error=NULL,updated_at=? WHERE id=?")
      .bind(String(sealed.ciphertext),String(sealed.iv),String(inbox.email),region,now,accountId).run();
  }else{
    const saved=await env.PLATFORM_DB.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,project_id,assistant_identity_id,agentport_agent_id,owner_user_id,mode,inbox_id,email_address,credential_ciphertext,credential_iv,status,activated_at,created_at,updated_at,provider_region)
      VALUES(?,?,?,?,?,?,?,'user_connected',?,?,?,?,'provisioning',?,?,?,?)`).bind(accountId,scope.tenantId,scope.spaceId,scope.projectId??null,identity.id,agentId,scope.userId,input.inboxId,String(inbox.email),String(sealed.ciphertext),String(sealed.iv),now,now,now,region).run();
    if(!saved.meta.changes)throw new Error("agentmail_connection_conflict");
  }
  const account=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE id=?").bind(accountId).first<AgentMailAccount>();
  if(!account)throw new Error("agentmail_connection_store_unavailable");
  const link=await linkAgentPort(env,scope,identity,account,{type:"individual",id:scope.userId});
  await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET retire_after=COALESCE(retire_after,next_billing_at),updated_at=? WHERE tenant_id=? AND agentport_agent_id=? AND mode='naelao_managed' AND status='active' AND id<>? AND next_billing_at IS NOT NULL")
    .bind(new Date().toISOString(),scope.tenantId,agentId,accountId).run();
  return {connectionId:accountId,address:account.email_address,status:"active",mode:"user_connected",region,...link};
}
export async function callAgentMailTool(env:AgentsEnv,scope:CommunicationScope,action:string,args:Record<string,unknown>,connectionId?:string){
  const agentId=await ensureAgentPortAssistantIdentity(env,scope);
  const account=await env.PLATFORM_DB.prepare(`SELECT * FROM assistant_agentmail_accounts
    WHERE tenant_id=? AND space_id=? AND project_id IS ? AND agentport_agent_id=? AND status='active'
      AND (? IS NULL OR id=?) AND (mode='naelao_managed' OR owner_user_id=?) ORDER BY created_at DESC LIMIT 1`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId??null,agentId,connectionId??null,connectionId??null,scope.userId).first<AgentMailAccount>();
  if(!account)throw new Error("agentmail_account_not_connected");
  const identity=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_communication_identities WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ?").bind(account.assistant_identity_id,scope.tenantId,scope.spaceId,scope.projectId??null).first<CommunicationIdentity>();
  if(!identity)throw new Error("assistant_identity_unavailable");
  const key=await providerKeyFor(env,identity,account);
  if(!key)throw new Error("agentmail_provider_not_configured");
  const capability=(["agentmail.send","agentmail.reply","agentmail.reply_all","agentmail.forward","agentmail.draft"].includes(action))?"messages.send":
    action==="agentmail.search"?"email.search":action==="agentmail.threads"?"email.threads":action==="agentmail.attachment"?"email.attachments":"messages.read";
  const operationKey=typeof args.idempotency_key==="string"?args.idempotency_key:JSON.stringify(args);
  const authorizationId=await stableClientId(`${account.id}:${action}:${operationKey}`);
  const providerResourceRef=[account.inbox_id,typeof args.messageId==="string"?args.messageId:"",typeof args.attachmentId==="string"?args.attachmentId:""]
    .filter(Boolean).join(":");
  const authorization=await agentPort(env,scope.tenantId,`/accounts/${encodeURIComponent(account.agentport_account_id??"")}/actions/authorize`,"POST",
    {agentId,action:capability,idempotencyKey:authorizationId,resourceRef:providerResourceRef});
  if(authorization.result.decision!=="allow")throw new Error("agentmail_action_not_authorized");
  const endpoint=`/inboxes/${encodeURIComponent(account.inbox_id)}`;
  const methods:Record<string,{method:string;path:string;body?:unknown}>={
    "agentmail.inbox":{method:"GET",path:`${endpoint}/messages${buildQuery(args)}`},
    "agentmail.search":{method:"GET",path:`${endpoint}/messages/search${buildQuery(args)}`},
    "agentmail.threads":{method:"GET",path:`${endpoint}/threads${buildQuery(args)}`},
    "agentmail.read":{method:"GET",path:`${endpoint}/messages/${encodeURIComponent(String(args.messageId??""))}`},
    "agentmail.attachment":{method:"GET",path:`${endpoint}/messages/${encodeURIComponent(String(args.messageId??""))}/attachments/${encodeURIComponent(String(args.attachmentId??""))}`},
    "agentmail.draft":{method:"POST",path:`${endpoint}/drafts`,body:args},
    "agentmail.send":{method:"POST",path:`${endpoint}/messages/send`,body:args},
    "agentmail.reply":{method:"POST",path:`${endpoint}/messages/${encodeURIComponent(String(args.messageId??""))}/reply`,body:args},
    "agentmail.reply_all":{method:"POST",path:`${endpoint}/messages/${encodeURIComponent(String(args.messageId??""))}/reply-all`,body:args},
    "agentmail.forward":{method:"POST",path:`${endpoint}/messages/${encodeURIComponent(String(args.messageId??""))}/forward`,body:args},
  };
  const call=methods[action];if(!call)throw new Error("agentmail_operation_unsupported");
  if(["agentmail.send","agentmail.reply","agentmail.reply_all","agentmail.forward"].includes(action)){
    const policy=validateAutonomy(JSON.parse(identity.autonomy_json));
    if(policy.mode!=="standing")throw new Error("communication_approval_required");
    const recipients=[...normalizeRecipients(args.to),...normalizeRecipients(args.cc),...normalizeRecipients(args.bcc)];
    if(!recipients.length||recipients.some(recipient=>!policy.recipients.includes(recipient)))throw new Error("communication_recipient_not_approved");
    const idem=typeof args.idempotency_key==="string"?args.idempotency_key:"";
    if(!/^[A-Za-z0-9._:-]{1,200}$/.test(idem))throw new Error("agentmail_idempotency_key_required");
    const payload={...(call.body as Record<string,unknown>)};delete payload.idempotency_key;delete payload.messageId;
    const requestHash=await hashString(JSON.stringify(payload)),idemHash=await hashString(idem),at=new Date().toISOString();
    const prior=await env.PLATFORM_DB.prepare("SELECT request_hash,status,provider_message_id,first_attempt_at FROM assistant_agentmail_sends WHERE connection_id=? AND idempotency_hash=?").bind(account.id,idemHash).first<{request_hash:string;status:string;provider_message_id:string|null;first_attempt_at:string}>();
    if(prior&&prior.request_hash!==requestHash)throw new Error("agentmail_idempotency_conflict");
    if(prior?.status==="sent")return {message_id:prior.provider_message_id,idempotent:true};
    if(prior&&Date.now()-Date.parse(prior.first_attempt_at)>24*60*60_000)throw new Error("agentmail_delivery_reconciliation_required");
    const daily=await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM assistant_agentmail_sends WHERE connection_id=? AND status='sent' AND first_attempt_at>=date('now')").bind(account.id).first<{n:number}>();
    if(!prior&&(daily?.n??0)>=policy.dailySendLimit)throw new Error("communication_daily_send_limit");
    await env.PLATFORM_DB.prepare(`INSERT INTO assistant_agentmail_sends(connection_id,idempotency_hash,request_hash,status,first_attempt_at,updated_at) VALUES(?,?,?,'sending',?,?)
      ON CONFLICT(connection_id,idempotency_hash) DO UPDATE SET status='sending',updated_at=excluded.updated_at`).bind(account.id,idemHash,requestHash,at,at).run();
    try{
      const sent=await provider(env,key,call.path,{method:call.method,headers:{"Idempotency-Key":idem},body:JSON.stringify(payload)},account.provider_region);
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_sends SET status='sent',provider_message_id=?,updated_at=? WHERE connection_id=? AND idempotency_hash=?")
        .bind(typeof sent.message_id==="string"?sent.message_id:null,new Date().toISOString(),account.id,idemHash).run();
      return sent;
    }catch(error){
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_sends SET status='indeterminate',updated_at=? WHERE connection_id=? AND idempotency_hash=?").bind(new Date().toISOString(),account.id,idemHash).run();
      throw error;
    }
  }
  return provider(env,key,call.path,{method:call.method,...(call.body===undefined?{}:{body:JSON.stringify(call.body)})},account.provider_region);
}
function buildQuery(args:Record<string,unknown>){const params=new URLSearchParams();for(const [key,value]of Object.entries(args))if(typeof value==="string"||typeof value==="number"||typeof value==="boolean")params.set(key,value.toString());const query=params.toString();return query?`?${query}`:"";}
async function hashString(value:string){const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("");}
function normalizeRecipients(value:unknown){const entries=Array.isArray(value)?value:[value];return entries.flatMap(item=>{const address=typeof item==="string"?item:item&&typeof item==="object"?String((item as Record<string,unknown>).email??(item as Record<string,unknown>).address??""):"";return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)?[address.toLowerCase()]:[];});}
function addMonthlyAnniversary(value:string,anchorDay=new Date(value).getUTCDate()){const source=new Date(value);const next=new Date(Date.UTC(source.getUTCFullYear(),source.getUTCMonth()+1,1,source.getUTCHours(),source.getUTCMinutes(),source.getUTCSeconds()));const lastDay=new Date(Date.UTC(next.getUTCFullYear(),next.getUTCMonth()+1,0)).getUTCDate();next.setUTCDate(Math.min(anchorDay,lastDay));return next.toISOString();}
export async function sweepManagedAgentMailRentals(env:AgentsEnv,now=new Date()){
  if(!env.BILLING_WORKER)return {checked:0,billed:0,held:0,review:0};
  const at=now.toISOString();
  const expired=await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET status='retirement_review_required',updated_at=? WHERE mode='naelao_managed' AND status='active' AND retire_after IS NOT NULL AND retire_after<=?").bind(at,at).run();
  if(expired.meta.changes)await env.PLATFORM_DB.prepare(`UPDATE managed_service_accounts SET lifecycle_state='retirement_review_required',updated_at=?
    WHERE provider='agentmail' AND id IN (SELECT id FROM assistant_agentmail_accounts WHERE mode='naelao_managed' AND status='retirement_review_required' AND retire_after<=?)`).bind(at,at).run();
  const due=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE mode='naelao_managed' AND status IN ('active','billing_hold') AND retire_after IS NULL AND next_billing_at<=? ORDER BY next_billing_at LIMIT 50")
    .bind(at).all<AgentMailAccount & {next_billing_at:string|null}>();
  let billed=0,held=0;
  await Promise.all(due.results.map(async account=>{
    const next=account.next_billing_at;if(!next)return;
    const digest=await stableClientId(`${account.id}:${next}:monthly-rental`);const operationId=`agentmail_renew_${digest}`;
    const workflowId=`agentmail_rent_${digest}`;const updated=at;
    const scope:CommunicationScope={tenantId:account.tenant_id,spaceId:account.space_id,...(account.project_id?{projectId:account.project_id}:{}),userId:account.owner_user_id,role:"product_end_user"};
    const registry=await env.PLATFORM_DB.prepare("SELECT capability_version,region FROM managed_service_accounts WHERE id=? AND tenant_id=?")
      .bind(account.id,account.tenant_id).first<{capability_version:number|null;region:string|null}>();
    if(!registry?.region){
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET status='billing_hold',last_error='managed_service_region_not_verified',updated_at=? WHERE id=? AND status IN ('active','billing_hold')")
        .bind(updated,account.id).run();held++;return;
    }
    let price:ManagedAgentMailPrice;
    try{price=await resolveManagedAgentMailPrice(env,scope,"renew",registry.region,now);}
    catch(error){
      const code=error instanceof Error?error.message:"managed_service_price_unconfigured";
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET status='billing_hold',last_error=?,updated_at=? WHERE id=? AND status IN ('active','billing_hold')")
        .bind(code,updated,account.id).run();
      await env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET lifecycle_state='billing_hold',updated_at=? WHERE id=? AND tenant_id=?")
        .bind(updated,account.id,account.tenant_id).run();held++;return;
    }
    const requestSpec={accountId:account.id,nextBillingAt:next,credits:price.credits,priceVersion:price.priceVersion,
      capabilityVersion:price.capabilityVersion,region:registry.region};
    const requestHash=await hashString(JSON.stringify(requestSpec));
    const quoteDigest=await hashString(`agentmail-renew:${operationId}`);const quoteId=`msq_${quoteDigest.slice(0,32)}`;
    const quoteExpiry=new Date(now.getTime()+180_000).toISOString();
    await env.PLATFORM_DB.batch([env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_operations(
      operation_id,tenant_id,space_id,project_id,account_id,provider,service_id,capability_version,operation_name,region,idempotency_key,
      request_sha256,status,quote_id,price_version,reserved_credits,created_at,updated_at)
      VALUES(?,?,?,?,?,'agentmail','agentmail',?,'renew',?,?,?,'pending',?,?,?, ?,?)`)
      .bind(operationId,account.tenant_id,account.space_id,account.project_id,account.id,price.capabilityVersion,registry.region,operationId,requestHash,
        quoteId,price.priceVersion,price.credits,updated,updated),
      env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_operation_quotes(
        quote_id,tenant_id,space_id,project_id,requester_user_id,plan_tier,provider,service_id,operation_name,region,
        capability_version,price_version,credits,request_sha256,status,operation_id,expires_at,consumed_at,created_at)
        SELECT ?,?,?,?,?,?,'agentmail','agentmail','renew',?,?,?,?,?,'consumed',?,?,?,?
        WHERE EXISTS(SELECT 1 FROM managed_service_operations WHERE operation_id=? AND tenant_id=? AND quote_id=? AND request_sha256=?)`)
        .bind(quoteId,account.tenant_id,account.space_id,account.project_id,account.owner_user_id,price.planTier,registry.region,price.capabilityVersion,
          price.priceVersion,price.credits,requestHash,operationId,quoteExpiry,updated,updated,operationId,account.tenant_id,quoteId,requestHash)]);
    const prior=await env.PLATFORM_DB.prepare("SELECT request_sha256,status,quote_id FROM managed_service_operations WHERE operation_id=? AND tenant_id=?")
      .bind(operationId,account.tenant_id).first<{request_sha256:string;status:string;quote_id:string|null}>();
    if(!prior||prior.request_sha256!==requestHash||prior.quote_id!==quoteId){
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET status='billing_hold',last_error='managed_service_operation_conflict',updated_at=? WHERE id=? AND status IN ('active','billing_hold')")
        .bind(updated,account.id).run();
      await env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET lifecycle_state='billing_hold',updated_at=? WHERE id=? AND tenant_id=?")
        .bind(updated,account.id,account.tenant_id).run();held++;return;
    }
    const operationClaim=await env.PLATFORM_DB.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,error_code=NULL,updated_at=?
      WHERE operation_id=? AND tenant_id=? AND (status IN ('pending','held') OR (status='running' AND (lease_until IS NULL OR lease_until<=?)))`)
      .bind(new Date(now.getTime()+120_000).toISOString(),updated,operationId,account.tenant_id,updated).run();
    if(!operationClaim.meta.changes){
      if(prior.status==="complete"){
        const nextBilling=addMonthlyAnniversary(next,new Date(account.activated_at??next).getUTCDate());
        await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET status='active',next_billing_at=?,last_error=NULL,updated_at=? WHERE id=? AND status IN ('active','billing_hold') AND next_billing_at=?")
          .bind(nextBilling,updated,account.id,next).run();
        await env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET lifecycle_state='active',updated_at=? WHERE id=? AND tenant_id=?")
          .bind(updated,account.id,account.tenant_id).run();
      }
      return;
    }
    await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_agentmail_operations(operation_id,tenant_id,assistant_identity_id,operation,status,created_at,updated_at) VALUES(?,?,?,'renew','pending',?,?)")
      .bind(operationId,account.tenant_id,account.assistant_identity_id,updated,updated).run();
    const claimed=await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_operations SET status='running',attempt=attempt+1,lease_until=?,updated_at=? WHERE operation_id=? AND ((status IN ('pending','held') AND (lease_until IS NULL OR lease_until<=?)) OR (status='running' AND lease_until<=?))")
      .bind(new Date(now.getTime()+120_000).toISOString(),updated,operationId,updated,updated).run();
    if(!claimed.meta.changes){await env.PLATFORM_DB.prepare("UPDATE managed_service_operations SET status='held',lease_until=NULL,error_code='legacy_operation_busy',updated_at=? WHERE operation_id=? AND status='running'").bind(updated,operationId).run();return;}
    let reserved=false,settled=false;
    try{
      if(!registry?.region)throw new Error("managed_service_region_not_verified");
      await reserveManagedServiceCredits(env,scope,{reservationId:workflowId,operationId,provider:"agentmail",serviceId:"agentmail",operationName:"renew",region:registry.region,
        credits:price.credits,priceVersion:price.priceVersion,quoteId,agentPortAgentId:account.agentport_agent_id});reserved=true;
      await env.PLATFORM_DB.prepare("UPDATE managed_service_operations SET reservation_id=?,reserved_credits=?,price_version=?,updated_at=? WHERE operation_id=? AND status='running'")
        .bind(workflowId,price.credits,price.priceVersion,updated,operationId).run();
      await settleManagedServiceCredits(env,scope,workflowId,price.credits);settled=true;
      const nextBilling=addMonthlyAnniversary(next,new Date(account.activated_at??next).getUTCDate());
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET status='active',next_billing_at=?,last_error=NULL,updated_at=? WHERE id=? AND status IN ('active','billing_hold') AND next_billing_at=?")
        .bind(nextBilling,updated,account.id,next).run();
      await env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET lifecycle_state='active',updated_at=? WHERE id=? AND tenant_id=?")
        .bind(updated,account.id,account.tenant_id).run();
      await env.PLATFORM_DB.prepare("UPDATE managed_service_operations SET status='complete',lease_until=NULL,error_code=NULL,provider_operation_ref=?,result_ref=?,updated_at=? WHERE operation_id=? AND status='running'")
        .bind(account.inbox_id,account.id,updated,operationId).run();
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_operations SET status='complete',lease_until=NULL,error_code=NULL,updated_at=? WHERE operation_id=? AND status='running'").bind(updated,operationId).run();billed++;
    }catch(error){
      if(reserved&&!settled)await releaseManagedServiceCredits(env,scope,workflowId,"no_effect").catch(()=>undefined);
      const code=error instanceof Error&&/^[a-z][a-z0-9_:-]{1,100}$/.test(error.message)?error.message:"managed_email_renewal_failed";
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET status='billing_hold',last_error=?,updated_at=? WHERE id=? AND status IN ('active','billing_hold')").bind(code,updated,account.id).run();
      await env.PLATFORM_DB.prepare("UPDATE managed_service_accounts SET lifecycle_state='billing_hold',updated_at=? WHERE id=? AND tenant_id=?")
        .bind(updated,account.id,account.tenant_id).run();
      await env.PLATFORM_DB.prepare("UPDATE managed_service_operations SET status=?,lease_until=NULL,error_code=?,updated_at=? WHERE operation_id=? AND status='running'")
        .bind(settled?"complete":"held",code,updated,operationId).run();
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_operations SET status='held',lease_until=NULL,error_code=?,updated_at=? WHERE operation_id=? AND status='running'").bind(code,updated,operationId).run();held++;
    }
  }));
  return {checked:due.results.length,billed,held,review:expired.meta.changes};
}
function constantTimeEqual(a:Uint8Array,b:Uint8Array){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]!^b[i]!;return diff===0;}
function decodeBase64(value:string){const binary=atob(value);return Uint8Array.from(binary,char=>char.charCodeAt(0));}
async function verifySvix(secret:string,headers:Headers,raw:string){
  const idHeader=headers.get("svix-id")??"",timestamp=headers.get("svix-timestamp")??"",signature=headers.get("svix-signature")??"";
  if(!/^msg_[A-Za-z0-9_-]{1,200}$/.test(idHeader)||!/^\d{1,12}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300)return false;
  const encoded=secret.startsWith("whsec_")?secret.slice(6):"";if(!encoded)return false;
  let key:Uint8Array;try{key=decodeBase64(encoded);}catch{return false;}
  const hmacKey=await crypto.subtle.importKey("raw",key,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signed=`${idHeader}.${timestamp}.${raw}`;const expected=new Uint8Array(await crypto.subtle.sign("HMAC",hmacKey,new TextEncoder().encode(signed)));
  return signature.split(" ").some(part=>{const match=/^v1,([A-Za-z0-9+/=]+)$/.exec(part);if(!match)return false;try{return constantTimeEqual(expected,decodeBase64(match[1]!));}catch{return false;}});
}
async function verifyAgentPortNotification(secret:string,headers:Headers,raw:string){
  const timestamp=headers.get("x-agentport-timestamp")??"",signature=headers.get("x-agentport-signature")??"";
  return (await verifyAgentPortEventWebhook({secret,timestamp,signature,raw:new TextEncoder().encode(raw)})).valid;
}
async function payloadHash(value:unknown){const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");}
export async function receiveAgentMailWebhook(env:AgentsEnv,connectionId:string,request:Request){
  const account=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE id=? AND status='active'").bind(connectionId).first<AgentMailAccount & {agentmail_webhook_secret_ciphertext:string|null;agentmail_webhook_secret_iv:string|null}>();
  if(!account?.agentmail_webhook_secret_ciphertext||!account.agentmail_webhook_secret_iv)return Response.json({error_code:"agentmail_webhook_unavailable"},{status:404});
  const raw=await readBoundedRequestText(request,2*1024*1024).catch(()=>null);if(raw===null)return Response.json({error_code:"webhook_payload_invalid"},{status:413});
  const identity={id:account.assistant_identity_id,tenant_id:account.tenant_id} as CommunicationIdentity;
  const secret=String((await openCommunication(env,identity,account.id,{ciphertext:account.agentmail_webhook_secret_ciphertext,iv:account.agentmail_webhook_secret_iv,algorithm:"aes-256-gcm"})).secret??"");
  if(!await verifySvix(secret,request.headers,raw))return Response.json({error_code:"webhook_signature_invalid"},{status:401});
  let event:Record<string,unknown>;try{event=JSON.parse(raw) as Record<string,unknown>;}catch{return Response.json({error_code:"webhook_json_invalid"},{status:400});}
  if(event.event_type!=="message.received")return new Response(null,{status:204});
  const message=event.message as Record<string,unknown>|undefined;const thread=event.thread as Record<string,unknown>|undefined;
  const eventId=typeof event.event_id==="string"?event.event_id:"";const messageId=typeof message?.message_id==="string"?message.message_id:"";const threadId=typeof message?.thread_id==="string"?message.thread_id:(typeof thread?.thread_id==="string"?thread.thread_id:"");
  if(!eventId||!messageId||!threadId||message?.inbox_id!==account.inbox_id)return Response.json({error_code:"webhook_reference_invalid"},{status:400});
  const at=new Date().toISOString();
  await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_agentmail_event_receipts(account_id,event_id,event_type,message_ref,thread_ref,status,created_at,updated_at) VALUES(?,?,'message.received',?,?,'pending',?,?)").bind(account.id,eventId,messageId,threadId,at,at).run();
  const receipt=await env.PLATFORM_DB.prepare("SELECT status,message_ref,thread_ref FROM assistant_agentmail_event_receipts WHERE account_id=? AND event_id=?").bind(account.id,eventId).first<{status:string;message_ref:string|null;thread_ref:string|null}>();
  if(!receipt||receipt.message_ref!==messageId||receipt.thread_ref!==threadId)return Response.json({error_code:"event_idempotency_conflict"},{status:409});
  if(receipt.status==="queued")return new Response(null,{status:204});
  const serviceId=`agentmail:${account.tenant_id}`;
  const posted=await agentPort(env,account.tenant_id,"/events","POST",{serviceId,accountId:account.agentport_account_id,providerEventId:eventId,eventType:"message.received",threadRef:threadId,dataRef:messageId});
  if(posted.response.status!==202&&posted.response.status!==200) return Response.json({error_code:"agentport_event_ingest_failed"},{status:503});
  await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_event_receipts SET status='queued',updated_at=? WHERE account_id=? AND event_id=?").bind(new Date().toISOString(),account.id,eventId).run();
  return new Response(null,{status:204});
}
export async function receiveAgentPortNotification(env:AgentsEnv,connectionId:string,request:Request){
  const account=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE id=? AND status='active'").bind(connectionId).first<AgentMailAccount & {agentport_webhook_secret_ciphertext:string|null;agentport_webhook_secret_iv:string|null;agentport_subscription_id:string|null}>();
  if(!account?.agentport_webhook_secret_ciphertext||!account.agentport_webhook_secret_iv||!account.agentport_subscription_id)return Response.json({error_code:"agentport_subscription_unavailable"},{status:404});
  const raw=await readBoundedRequestText(request,64*1024).catch(()=>null);if(raw===null)return Response.json({error_code:"event_payload_invalid"},{status:413});
  const identity={id:account.assistant_identity_id,tenant_id:account.tenant_id} as CommunicationIdentity;
  const secret=String((await openCommunication(env,identity,account.id,{ciphertext:account.agentport_webhook_secret_ciphertext,iv:account.agentport_webhook_secret_iv,algorithm:"aes-256-gcm"})).secret??"");
  if(!await verifyAgentPortNotification(secret,request.headers,raw))return Response.json({error_code:"event_signature_invalid"},{status:401});
  let notification:Record<string,unknown>;try{notification=JSON.parse(raw) as Record<string,unknown>;}catch{return Response.json({error_code:"event_json_invalid"},{status:400});}
  const required={id:"eventId",deliveryId:"deliveryId",subscriptionId:"subscriptionId",agentId:"agentId",serviceId:"serviceId",accountId:"accountId",type:"eventType",threadRef:"threadRef",dataRef:"dataRef"};
  const event=Object.fromEntries(Object.entries(required).map(([key,target])=>[target,notification[key]]));
  if(notification.subscriptionId!==account.agentport_subscription_id||notification.agentId!==account.agentport_agent_id||notification.serviceId!==`agentmail:${account.tenant_id}`||notification.accountId!==account.agentport_account_id||notification.type!=="message.received"||typeof notification.id!=="string"||typeof notification.deliveryId!=="string"||typeof notification.threadRef!=="string"||typeof notification.dataRef!=="string")return Response.json({error_code:"event_reference_mismatch"},{status:403});
  const hash=await payloadHash(event);const at=new Date().toISOString();
  await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_agentport_event_receipts(delivery_id,account_id,event_id,status,payload_hash,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)").bind(String(notification.deliveryId),account.id,String(notification.id),hash,at,at).run();
  const receipt=await env.PLATFORM_DB.prepare("SELECT status,payload_hash FROM assistant_agentport_event_receipts WHERE delivery_id=?").bind(String(notification.deliveryId)).first<{status:string;payload_hash:string}>();
  if(!receipt||receipt.payload_hash!==hash)return Response.json({error_code:"event_delivery_conflict"},{status:409});
  if(receipt.status==="queued")return new Response(null,{status:204});
  const consumerId=`naelao:${connectionId}`;const claim=await agentPort(env,account.tenant_id,`/events/${encodeURIComponent(String(notification.id))}/claim`,"POST",{agentId:account.agentport_agent_id,deliveryId:String(notification.deliveryId),consumerId,ttlSeconds:120});
  if(claim.result.claimed!==true)return Response.json({error_code:"event_claim_unavailable"},{status:503});
  if(!env.CHANNEL_SESSIONS)return Response.json({error_code:"session_queue_unavailable"},{status:503});
  const queueMessage={type:"provider_event_reference",tenantId:account.tenant_id,spaceId:account.space_id,...(account.project_id?{projectId:account.project_id}:{}),agentId:account.agentport_agent_id,connectionId:account.id,accountId:String(notification.accountId),subscriptionId:String(notification.subscriptionId),eventId:String(notification.id),deliveryId:String(notification.deliveryId),serviceId:String(notification.serviceId),eventType:String(notification.type),threadRef:String(notification.threadRef),dataRef:String(notification.dataRef)} as const;
  await env.CHANNEL_SESSIONS.send(queueMessage);
  const ack=await agentPort(env,account.tenant_id,`/events/${encodeURIComponent(String(notification.id))}/ack`,"POST",{agentId:account.agentport_agent_id,deliveryId:String(notification.deliveryId),consumerId,result:"delivered"});
  if(ack.result.acknowledged!==true)return Response.json({error_code:"event_acknowledgment_failed"},{status:503});
  await env.PLATFORM_DB.prepare("UPDATE assistant_agentport_event_receipts SET status='queued',updated_at=? WHERE delivery_id=?").bind(new Date().toISOString(),String(notification.deliveryId)).run();
  return new Response(null,{status:204});
}
