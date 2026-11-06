import { mintInternalToken, readBoundedRequestText, readBoundedResponseJson } from "@naelao/http";
import { AgentPortServiceClient } from "@agentport/sdk";
import { verifyAgentPortEventWebhook } from "@agentport/sdk";
import type { AgentsEnv } from "../index.js";
import { ensureAgentPortAssistantIdentity, type CommunicationIdentity, type CommunicationScope, sealCommunication, openCommunication, validateAutonomy } from "./core.js";
import { reserveManagedCarrierCredits,settleManagedCarrierCredits,releaseManagedCarrierCredits } from "./managed-carrier-billing.js";

type AgentMailAccount={id:string;tenant_id:string;space_id:string;project_id:string|null;assistant_identity_id:string;agentport_agent_id:string;agentport_account_id:string|null;owner_user_id:string;mode:"naelao_managed"|"user_connected";pod_id:string|null;inbox_id:string;email_address:string;credential_ciphertext:string|null;credential_iv:string|null;status:string;activated_at:string|null};
const API="https://api.agentmail.to/v0";
function id(prefix:string){return `${prefix}_${crypto.randomUUID().replaceAll("-","")}`;}
async function stableClientId(value:string){const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));return `naelao_${[...bytes].map(x=>x.toString(16).padStart(2,"0")).join("")}`;}
async function provider(env:AgentsEnv,key:string,path:string,init:RequestInit={}){
  const response=await fetch(`${env.AGENTMAIL_API_BASE_URL??API}${path}`,{...init,headers:{authorization:`Bearer ${key}`,accept:"application/json",...(init.body?{"content-type":"application/json"}:{}),...init.headers}});
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
  return {agentId,serviceId};
}
export async function getAssistantAgentMailStatus(env:AgentsEnv,scope:CommunicationScope){
  const rows=await env.PLATFORM_DB.prepare(`SELECT a.id,a.mode,a.email_address,a.status,a.activated_at,a.next_billing_at,
      (SELECT COUNT(*) FROM assistant_agentmail_event_receipts e WHERE e.account_id=a.id AND e.status='queued') AS received_count,
      (SELECT COUNT(*) FROM assistant_agentmail_sends s WHERE s.connection_id=a.id AND s.status='sent') AS sent_count,
      (SELECT MAX(value) FROM (SELECT MAX(e.created_at) AS value FROM assistant_agentmail_event_receipts e WHERE e.account_id=a.id AND e.status='queued' UNION ALL SELECT MAX(s.updated_at) AS value FROM assistant_agentmail_sends s WHERE s.connection_id=a.id AND s.status='sent')) AS last_activity_at
    FROM assistant_agentmail_accounts a WHERE tenant_id=? AND space_id=? AND project_id IS ? ORDER BY created_at DESC LIMIT 20`).bind(scope.tenantId,scope.spaceId,scope.projectId??null).all<{id:string;mode:string;email_address:string;status:string;activated_at:string|null;next_billing_at:string|null;received_count:number;sent_count:number;last_activity_at:string|null}>();
  const latestOperation=await env.PLATFORM_DB.prepare(`SELECT o.status,o.error_code,o.updated_at FROM assistant_agentmail_operations o
    JOIN assistant_communication_identities i ON i.id=o.assistant_identity_id
    WHERE i.tenant_id=? AND i.space_id=? AND i.project_id IS ? AND o.operation='provision' ORDER BY o.updated_at DESC LIMIT 1`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId??null).first<{status:string;error_code:string|null;updated_at:string}>();
  return {provider:"agentmail",connections:rows.results.map(row=>({id:row.id,mode:row.mode,address:row.email_address,status:row.status,activatedAt:row.activated_at,nextBillingAt:row.next_billing_at,
    receivedMessages:row.received_count,sentMessages:row.sent_count,lastActivityAt:row.last_activity_at,activity30d:!!row.last_activity_at&&Date.parse(row.last_activity_at)>=Date.now()-30*86400_000?"active":"idle"})),
    ...(latestOperation?.status==="held"?{lastProvisioningFailure:{errorCode:latestOperation.error_code,occurredAt:latestOperation.updated_at}}:{})};
}
async function linkAgentPort(env:AgentsEnv,scope:CommunicationScope,identity:CommunicationIdentity,account:AgentMailAccount,providerOwner:{type:"individual"|"organization";id:string},activateLocal=true){
  const {agentId,serviceId}=await platformIdentity(env,scope,identity);
  const {result}=await agentPort(env,scope.tenantId,"/accounts","POST",{serviceId,accountModel:"agent_native",ownerType:providerOwner.type,ownerId:providerOwner.id,externalAccountId:account.inbox_id,credentialRef:account.id,metadata:{provider:"agentmail",connectionMode:account.mode}});
  const created=result.account as {id?:string;status?:string}|undefined;
  if(!created?.id)throw new Error("agentport_account_link_unavailable");
  if(created.status==="pending")await agentPort(env,scope.tenantId,`/accounts/${encodeURIComponent(created.id)}/activate`,"POST",{});
  const grants=["email.read","email.send","email.search","email.threads","email.attachments","channels.manage","messages.read","messages.send"];
  await agentPort(env,scope.tenantId,`/accounts/${encodeURIComponent(created.id)}/grants`,"POST",{agentId,grantedBy:providerOwner.id,permissions:grants});
  account.agentport_agent_id=agentId;account.agentport_account_id=created.id;
  await env.PLATFORM_DB.prepare(`UPDATE assistant_agentmail_accounts SET agentport_agent_id=?,agentport_account_id=?,status=CASE WHEN ? THEN 'active' ELSE status END,updated_at=? WHERE id=?`)
    .bind(agentId,created.id,activateLocal?1:0,new Date().toISOString(),account.id).run();
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
    try{created=await provider(env,providerKey,`/inboxes/${encodeURIComponent(account.inbox_id)}/webhooks`,{method:"POST",body:JSON.stringify({url:hookUrl,event_types:["message.received"],client_id:client})});}
    catch(error){
      if(!(error instanceof Error&&error.message.endsWith("_409")))throw error;
      const list=await provider(env,providerKey,`/inboxes/${encodeURIComponent(account.inbox_id)}/webhooks`);
      const existing=(list.webhooks as Array<Record<string,unknown>>|undefined)?.find(item=>item.client_id===client);
      if(!existing||typeof existing.webhook_id!=="string")throw new Error("agentmail_webhook_reconciliation_required");
      created=await provider(env,providerKey,`/inboxes/${encodeURIComponent(account.inbox_id)}/webhooks/${encodeURIComponent(existing.webhook_id)}`);
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
async function providerKeyFor(env:AgentsEnv,identity:CommunicationIdentity,account:AgentMailAccount){
  if(account.mode==="naelao_managed")return env.AGENTMAIL_API_KEY??"";
  if(!account.credential_ciphertext||!account.credential_iv)throw new Error("agentmail_credential_unavailable");
  return String((await openCommunication(env,identity,account.id,{ciphertext:account.credential_ciphertext,iv:account.credential_iv,algorithm:"aes-256-gcm"})).apiKey??"");
}
async function ensurePod(env:AgentsEnv,tenantId:string){
  const existing=await env.PLATFORM_DB.prepare("SELECT pod_id FROM assistant_agentmail_pods WHERE tenant_id=? AND status='active'").bind(tenantId).first<{pod_id:string}>();
  if(existing)return existing.pod_id;
  if(!env.AGENTMAIL_API_KEY)throw new Error("agentmail_managed_provisioning_not_configured");
  const client=await stableClientId(`naelao:customer-pod:${tenantId}`);
  let pod:Record<string,unknown>;
  try{pod=await provider(env,env.AGENTMAIL_API_KEY,"/pods",{method:"POST",body:JSON.stringify({name:`Naelao customer ${tenantId.slice(0,12)}`,client_id:client})});}
  catch(error){
    // A timeout after provider creation is reconciled by the same provider idempotency key.
    if(!(error instanceof Error&&error.message.startsWith("agentmail_provider_409")))throw error;
    const list=await provider(env,env.AGENTMAIL_API_KEY,`/pods?client_id=${encodeURIComponent(client)}`);
    const items=(list.pods as Array<Record<string,unknown>>|undefined)??[];pod=items.find(item=>item.client_id===client)??{};
  }
  const podId=typeof pod.pod_id==="string"?pod.pod_id:"";
  if(!podId)throw new Error("agentmail_pod_reconciliation_required");
  const now=new Date().toISOString();
  await env.PLATFORM_DB.prepare("INSERT INTO assistant_agentmail_pods(tenant_id,pod_id,status,created_at,updated_at) VALUES(?,?,'active',?,?) ON CONFLICT(tenant_id) DO UPDATE SET pod_id=excluded.pod_id,status='active',updated_at=excluded.updated_at")
    .bind(tenantId,podId,now,now).run();
  return podId;
}
export async function provisionManagedAgentMail(env:AgentsEnv,scope:CommunicationScope,identity:CommunicationIdentity,displayName?:string){
  if(!env.AGENTMAIL_API_KEY||!env.AGENTMAIL_DEFAULT_DOMAIN)throw new Error("agentmail_managed_provisioning_not_configured");
  if(!env.AGENTMAIL_WEBHOOK_URL||!env.AGENTPORT_EVENT_RECEIVER_URL)throw new Error("agentmail_event_delivery_not_configured");
  const {agentId}=await platformIdentity(env,scope,identity);
  const found=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE tenant_id=? AND agentport_agent_id=? AND mode='naelao_managed' AND status IN ('active','provisioning','billing_hold') ORDER BY created_at LIMIT 1").bind(scope.tenantId,agentId).first<AgentMailAccount>();
  if(found?.status==="active"){
    if((found as AgentMailAccount&{retire_after?:string|null}).retire_after)await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET retire_after=NULL,status='active',updated_at=? WHERE id=? AND status='active'").bind(new Date().toISOString(),found.id).run();
    return {connectionId:found.id,address:found.email_address,status:found.status,agentportAgentId:agentId};
  }
  const opId=await stableClientId(`naelao:email-provision:${scope.tenantId}:${agentId}`);const now=Date.now();const timestamp=new Date(now).toISOString();
  await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_agentmail_operations(operation_id,tenant_id,assistant_identity_id,operation,status,created_at,updated_at) VALUES(?,?,?,'provision','pending',?,?)")
    .bind(opId,scope.tenantId,identity.id,timestamp,timestamp).run();
  const claimed=await env.PLATFORM_DB.prepare(`UPDATE assistant_agentmail_operations SET status='running',attempt=attempt+1,lease_until=?,updated_at=? WHERE operation_id=? AND ((status IN ('pending','held') AND (lease_until IS NULL OR lease_until<=?)) OR (status='running' AND lease_until<=?))`)
    .bind(new Date(now+120_000).toISOString(),timestamp,opId,timestamp,timestamp).run();
  if(!claimed.meta.changes)return {status:"provisioning",pending:true,agentportAgentId:agentId};
  const workflowId=`agentmail_rent_${opId}`;const scopeForBilling:CommunicationScope={...scope,role:"product_end_user"};
  let reserved=false;
  try{
    await reserveManagedCarrierCredits(env,scopeForBilling,workflowId,300,`managed-email:${agentId}`);reserved=true;
    const podId=await ensurePod(env,scope.tenantId);const client=await stableClientId(`naelao:managed-inbox:${scope.tenantId}:${agentId}`);
    const inbox=await provider(env,env.AGENTMAIL_API_KEY,`/pods/${encodeURIComponent(podId)}/inboxes`,{method:"POST",body:JSON.stringify({domain:env.AGENTMAIL_DEFAULT_DOMAIN,display_name:displayName??"Naelao Assistant",client_id:client,metadata:{naelao_agent_id:agentId}})});
    const inboxId=typeof inbox.inbox_id==="string"?inbox.inbox_id:"",address=typeof inbox.email==="string"?inbox.email:"";
    if(!inboxId||!address)throw new Error("agentmail_inbox_response_invalid");
    const connectionId=id("amc");
    await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO assistant_agentmail_accounts(id,tenant_id,space_id,project_id,assistant_identity_id,agentport_agent_id,owner_user_id,mode,pod_id,inbox_id,email_address,status,activated_at,next_billing_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'naelao_managed',?,?,?,'provisioning',NULL,NULL,?,?)`).bind(connectionId,scope.tenantId,scope.spaceId,scope.projectId??null,identity.id,agentId,scope.userId,podId,inboxId,address,timestamp,timestamp).run();
    const account=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE tenant_id=? AND agentport_agent_id=? AND inbox_id=? ORDER BY created_at LIMIT 1").bind(scope.tenantId,agentId,inboxId).first<AgentMailAccount>();
    if(!account)throw new Error("agentmail_connection_store_unavailable");
    const link=await linkAgentPort(env,scope,identity,account,{type:"organization",id:scope.tenantId},false);
    await settleManagedCarrierCredits(env,scopeForBilling,workflowId,300);
    const activatedAt=new Date(now).toISOString();const next=addMonthlyAnniversary(activatedAt);
    await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET status='active',activated_at=?,next_billing_at=?,last_error=NULL,updated_at=? WHERE id=?")
      .bind(activatedAt,next,activatedAt,account.id).run();
    await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_operations SET status='complete',result_ref=?,lease_until=NULL,error_code=NULL,updated_at=? WHERE operation_id=? AND status='running'")
      .bind(account.id,activatedAt,opId).run();
    return {connectionId:account.id,address,status:"active",priceCredits:300,...link};
  }catch(error){
    if(reserved)await releaseManagedCarrierCredits(env,scopeForBilling,workflowId).catch(()=>undefined);
    const code=error instanceof Error&&/^[a-z][a-z0-9_:-]{1,100}$/.test(error.message)?error.message:"agentmail_provisioning_failed";
    await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_operations SET status='held',lease_until=NULL,error_code=?,updated_at=? WHERE operation_id=? AND status='running'").bind(code,new Date().toISOString(),opId).run();
    throw error;
  }
}
export async function connectUserAgentMail(env:AgentsEnv,scope:CommunicationScope,identity:CommunicationIdentity,input:{inboxId:string;apiKey:string}){
  if(!env.AGENTMAIL_WEBHOOK_URL||!env.AGENTPORT_EVENT_RECEIVER_URL)throw new Error("agentmail_event_delivery_not_configured");
  if(!/^[A-Za-z0-9._:-]{1,200}$/.test(input.inboxId)||input.apiKey.length<16||input.apiKey.length>4096)throw new Error("agentmail_connection_invalid");
  const inbox=await provider(env,input.apiKey,`/inboxes/${encodeURIComponent(input.inboxId)}`);
  if(inbox.inbox_id!==input.inboxId||typeof inbox.email!=="string")throw new Error("agentmail_inbox_mismatch");
  const {agentId}=await platformIdentity(env,scope,identity);const now=new Date().toISOString();
  const existing=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE tenant_id=? AND agentport_agent_id=? AND inbox_id=?").bind(scope.tenantId,agentId,input.inboxId).first<AgentMailAccount>();
  const accountId=existing?.id??id("amc");const sealed=await sealCommunication(env,identity,accountId,{apiKey:input.apiKey});
  if(existing){
    if(existing.mode!=="user_connected"||existing.owner_user_id!==scope.userId)throw new Error("agentmail_account_owner_conflict");
    await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET credential_ciphertext=?,credential_iv=?,email_address=?,status=CASE WHEN status='active' THEN status ELSE 'provisioning' END,last_error=NULL,updated_at=? WHERE id=?")
      .bind(String(sealed.ciphertext),String(sealed.iv),String(inbox.email),now,accountId).run();
  }else{
    const saved=await env.PLATFORM_DB.prepare(`INSERT INTO assistant_agentmail_accounts(id,tenant_id,space_id,project_id,assistant_identity_id,agentport_agent_id,owner_user_id,mode,inbox_id,email_address,credential_ciphertext,credential_iv,status,activated_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'user_connected',?,?,?,?,'provisioning',?,?,?)`).bind(accountId,scope.tenantId,scope.spaceId,scope.projectId??null,identity.id,agentId,scope.userId,input.inboxId,String(inbox.email),String(sealed.ciphertext),String(sealed.iv),now,now,now).run();
    if(!saved.meta.changes)throw new Error("agentmail_connection_conflict");
  }
  const account=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE id=?").bind(accountId).first<AgentMailAccount>();
  if(!account)throw new Error("agentmail_connection_store_unavailable");
  const link=await linkAgentPort(env,scope,identity,account,{type:"individual",id:scope.userId});
  await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET retire_after=COALESCE(retire_after,next_billing_at),updated_at=? WHERE tenant_id=? AND agentport_agent_id=? AND mode='naelao_managed' AND status='active' AND id<>? AND next_billing_at IS NOT NULL")
    .bind(new Date().toISOString(),scope.tenantId,agentId,accountId).run();
  return {connectionId:accountId,address:account.email_address,status:"active",mode:"user_connected",...link};
}
export async function callAgentMailTool(env:AgentsEnv,scope:CommunicationScope,action:string,args:Record<string,unknown>){
  const agentId=await ensureAgentPortAssistantIdentity(env,scope);
  const account=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE tenant_id=? AND space_id=? AND project_id IS ? AND agentport_agent_id=? AND status='active' ORDER BY created_at DESC LIMIT 1")
    .bind(scope.tenantId,scope.spaceId,scope.projectId??null,agentId).first<AgentMailAccount>();
  if(!account)throw new Error("agentmail_account_not_connected");
  const identity=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_communication_identities WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ?").bind(account.assistant_identity_id,scope.tenantId,scope.spaceId,scope.projectId??null).first<CommunicationIdentity>();
  if(!identity)throw new Error("assistant_identity_unavailable");
  const key=await providerKeyFor(env,identity,account);
  if(!key)throw new Error("agentmail_provider_not_configured");
  const capability=(["agentmail.send","agentmail.reply","agentmail.reply_all","agentmail.forward","agentmail.draft"].includes(action))?"messages.send":"messages.read";
  const authorization=await agentPort(env,scope.tenantId,`/accounts/${encodeURIComponent(account.agentport_account_id??"")}/access/check`,"POST",{agentId,action:capability});
  if(authorization.result.authorized!==true)throw new Error("agentmail_action_not_authorized");
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
      const sent=await provider(env,key,call.path,{method:call.method,headers:{"Idempotency-Key":idem},body:JSON.stringify(payload)});
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_sends SET status='sent',provider_message_id=?,updated_at=? WHERE connection_id=? AND idempotency_hash=?")
        .bind(typeof sent.message_id==="string"?sent.message_id:null,new Date().toISOString(),account.id,idemHash).run();
      return sent;
    }catch(error){
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_sends SET status='indeterminate',updated_at=? WHERE connection_id=? AND idempotency_hash=?").bind(new Date().toISOString(),account.id,idemHash).run();
      throw error;
    }
  }
  return provider(env,key,call.path,{method:call.method,...(call.body===undefined?{}:{body:JSON.stringify(call.body)})});
}
function buildQuery(args:Record<string,unknown>){const params=new URLSearchParams();for(const [key,value]of Object.entries(args))if(typeof value==="string"||typeof value==="number"||typeof value==="boolean")params.set(key,value.toString());const query=params.toString();return query?`?${query}`:"";}
async function hashString(value:string){const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("");}
function normalizeRecipients(value:unknown){const entries=Array.isArray(value)?value:[value];return entries.flatMap(item=>{const address=typeof item==="string"?item:item&&typeof item==="object"?String((item as Record<string,unknown>).email??(item as Record<string,unknown>).address??""):"";return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)?[address.toLowerCase()]:[];});}
function addMonthlyAnniversary(value:string,anchorDay=new Date(value).getUTCDate()){const source=new Date(value);const next=new Date(Date.UTC(source.getUTCFullYear(),source.getUTCMonth()+1,1,source.getUTCHours(),source.getUTCMinutes(),source.getUTCSeconds()));const lastDay=new Date(Date.UTC(next.getUTCFullYear(),next.getUTCMonth()+1,0)).getUTCDate();next.setUTCDate(Math.min(anchorDay,lastDay));return next.toISOString();}
export async function sweepManagedAgentMailRentals(env:AgentsEnv,now=new Date()){
  if(!env.BILLING_WORKER)return {checked:0,billed:0,held:0,review:0};
  const at=now.toISOString();
  const expired=await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET status='retirement_review_required',updated_at=? WHERE mode='naelao_managed' AND status='active' AND retire_after IS NOT NULL AND retire_after<=?").bind(at,at).run();
  const due=await env.PLATFORM_DB.prepare("SELECT * FROM assistant_agentmail_accounts WHERE mode='naelao_managed' AND status IN ('active','billing_hold') AND retire_after IS NULL AND next_billing_at<=? ORDER BY next_billing_at LIMIT 50")
    .bind(at).all<AgentMailAccount & {next_billing_at:string|null}>();
  let billed=0,held=0;
  await Promise.all(due.results.map(async account=>{
    const next=account.next_billing_at;if(!next)return;
    const digest=await stableClientId(`${account.id}:${next}:monthly-rental`);const workflowId=`agentmail_renew_${digest}`;
    const operationId=workflowId;const updated=at;
    await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_agentmail_operations(operation_id,tenant_id,assistant_identity_id,operation,status,created_at,updated_at) VALUES(?,?,?,'renew','pending',?,?)")
      .bind(operationId,account.tenant_id,account.assistant_identity_id,updated,updated).run();
    const claimed=await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_operations SET status='running',attempt=attempt+1,lease_until=?,updated_at=? WHERE operation_id=? AND ((status IN ('pending','held') AND (lease_until IS NULL OR lease_until<=?)) OR (status='running' AND lease_until<=?))")
      .bind(new Date(now.getTime()+120_000).toISOString(),updated,operationId,updated,updated).run();
    if(!claimed.meta.changes)return;
    const scope:CommunicationScope={tenantId:account.tenant_id,spaceId:account.space_id,...(account.project_id?{projectId:account.project_id}:{}),userId:account.owner_user_id,role:"product_end_user"};
    let reserved=false;
    try{
      await reserveManagedCarrierCredits(env,scope,workflowId,300,`managed-email:${account.agentport_agent_id}`);reserved=true;
      await settleManagedCarrierCredits(env,scope,workflowId,300);
      const nextBilling=addMonthlyAnniversary(next,new Date(account.activated_at??next).getUTCDate());
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET status='active',next_billing_at=?,last_error=NULL,updated_at=? WHERE id=? AND status IN ('active','billing_hold') AND next_billing_at=?")
        .bind(nextBilling,updated,account.id,next).run();
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_operations SET status='complete',lease_until=NULL,error_code=NULL,updated_at=? WHERE operation_id=? AND status='running'").bind(updated,operationId).run();billed++;
    }catch(error){
      if(reserved)await releaseManagedCarrierCredits(env,scope,workflowId).catch(()=>undefined);
      const code=error instanceof Error&&/^[a-z][a-z0-9_:-]{1,100}$/.test(error.message)?error.message:"managed_email_renewal_failed";
      await env.PLATFORM_DB.prepare("UPDATE assistant_agentmail_accounts SET status='billing_hold',last_error=?,updated_at=? WHERE id=? AND status IN ('active','billing_hold')").bind(code,updated,account.id).run();
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
