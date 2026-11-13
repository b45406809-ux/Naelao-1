import type { AgentsEnv } from "../index.js";
import type { CommunicationScope } from "./core.js";
import { readBoundedResponseJson } from "@naelao/http";

type Provenance = "operator_imported" | "provider_api_observed";
type CostBudgetInput = {
  provider: string;
  serviceId: string;
  provenance: Provenance;
  currency: string;
  limitProviderCostMicros: number | null;
};

function validInput(value: CostBudgetInput) {
  return /^[a-z][a-z0-9_-]{1,63}$/.test(value.provider)
    && /^[a-z][a-z0-9_.:-]{1,128}$/.test(value.serviceId)
    && ["operator_imported", "provider_api_observed"].includes(value.provenance)
    && /^[A-Z]{3}$/.test(value.currency)
    && (value.limitProviderCostMicros === null || (Number.isSafeInteger(value.limitProviderCostMicros)
      && value.limitProviderCostMicros > 0 && value.limitProviderCostMicros <= 1_000_000_000_000));
}

async function budgetId(scope: CommunicationScope, input: CostBudgetInput) {
  const key = JSON.stringify([scope.tenantId, scope.spaceId, scope.projectId ?? null, input.provider,
    input.serviceId, input.provenance, input.currency]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return `mscb_${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 48)}`;
}

/** Configure or remove a dashboard warning threshold. It never gates provider dispatch. */
export async function setManagedServiceCostBudget(env: AgentsEnv, scope: CommunicationScope, input: CostBudgetInput) {
  if (!validInput(input)) throw new Error("managed_service_cost_budget_invalid");
  const id = await budgetId(scope, input);
  const at = new Date().toISOString();
  if (input.limitProviderCostMicros === null) {
    await env.PLATFORM_DB.prepare(`DELETE FROM managed_service_cost_budgets WHERE id=? AND tenant_id=? AND space_id=?
      AND project_id IS ? AND provider=? AND service_id=? AND provenance=? AND currency=?`)
      .bind(id, scope.tenantId, scope.spaceId, scope.projectId ?? null, input.provider, input.serviceId, input.provenance, input.currency).run();
    await env.PLATFORM_DB.prepare("DELETE FROM managed_service_cost_budget_alert_state WHERE budget_id=?").bind(id).run();
    return { removed: true };
  }
  const previous = await env.PLATFORM_DB.prepare("SELECT limit_provider_cost_micros FROM managed_service_cost_budgets WHERE id=? AND tenant_id=?")
    .bind(id, scope.tenantId).first<{limit_provider_cost_micros:number}>();
  await env.PLATFORM_DB.prepare(`INSERT INTO managed_service_cost_budgets(id,tenant_id,space_id,project_id,provider,service_id,
      provenance,currency,limit_provider_cost_micros,created_by_user_id,updated_by_user_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET limit_provider_cost_micros=excluded.limit_provider_cost_micros,
      updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at
    WHERE tenant_id=excluded.tenant_id AND space_id=excluded.space_id AND project_id IS excluded.project_id
      AND provider=excluded.provider AND service_id=excluded.service_id AND provenance=excluded.provenance AND currency=excluded.currency`)
    .bind(id, scope.tenantId, scope.spaceId, scope.projectId ?? null, input.provider, input.serviceId,
      input.provenance, input.currency, input.limitProviderCostMicros, scope.userId, scope.userId, at, at).run();
  const stored = await env.PLATFORM_DB.prepare(`SELECT tenant_id,space_id,project_id,provider,service_id,provenance,currency,
      limit_provider_cost_micros FROM managed_service_cost_budgets WHERE id=?`)
    .bind(id).first<Record<string, unknown>>();
  if (!stored || stored.tenant_id !== scope.tenantId || stored.space_id !== scope.spaceId
    || stored.project_id !== (scope.projectId ?? null) || stored.provider !== input.provider || stored.service_id !== input.serviceId
    || stored.provenance !== input.provenance || stored.currency !== input.currency
    || Number(stored.limit_provider_cost_micros) !== input.limitProviderCostMicros) {
    throw new Error("managed_service_cost_budget_conflict");
  }
  if (previous && Number(previous.limit_provider_cost_micros) !== input.limitProviderCostMicros) {
    // A changed threshold is a new alert contract. Invalidate an in-flight evaluator so it
    // cannot publish a crossing computed against the old limit.
    await env.PLATFORM_DB.prepare(`UPDATE managed_service_cost_budget_alert_state SET threshold_reached=0,lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE budget_id=?`).bind(at,id).run();
  }
  return { removed: false, limitProviderCostMicros: input.limitProviderCostMicros };
}

export async function listManagedServiceCostBudgets(env: AgentsEnv, scope: CommunicationScope) {
  const query = scope.projectId
    ? "tenant_id=? AND space_id=? AND project_id=?"
    : "tenant_id=? AND space_id=? AND project_id IS NULL";
  const bindings = scope.projectId ? [scope.tenantId, scope.spaceId, scope.projectId] : [scope.tenantId, scope.spaceId];
  const result = await env.PLATFORM_DB.prepare(`SELECT provider,service_id,provenance,currency,limit_provider_cost_micros,updated_at
    FROM managed_service_cost_budgets WHERE ${query} ORDER BY provider,service_id,provenance,currency`)
    .bind(...bindings)
    .all<{ provider:string;service_id:string;provenance:Provenance;currency:string;limit_provider_cost_micros:number;updated_at:string }>();
  return result.results.map(row => ({ provider:row.provider,serviceId:row.service_id,provenance:row.provenance,currency:row.currency,
    limitProviderCostMicros:row.limit_provider_cost_micros,updatedAt:row.updated_at }));
}

type CostBudgetRow = {
  id:string;tenant_id:string;space_id:string;project_id:string|null;provider:string;service_id:string;
  provenance:Provenance;currency:string;limit_provider_cost_micros:number;updated_at:string;
};
type CostBudgetAlertState = { threshold_reached:number;lease_token:string|null;last_observed_provider_cost_micros:number };

const OPENROUTER_DECISION_COST_SERVICE_ID = "decision-model";

async function observedCostForBudget(env:AgentsEnv,budget:CostBudgetRow,windowStart:string,windowEnd:string):Promise<number>{
  const table=budget.provenance==="operator_imported"?"managed_service_provider_cost_receipts":"managed_service_provider_cost_observations";
  // A Space-level budget is a rollup across all of that Space's projects, matching the
  // owner dashboard totals. A project-level budget remains isolated to that exact project.
  const projectClause=budget.project_id===null?"":" AND project_id=?";
  const bindings=budget.project_id===null
    ?[budget.tenant_id,budget.space_id,budget.provider,budget.service_id,budget.currency,windowStart,windowEnd]
    :[budget.tenant_id,budget.space_id,budget.project_id,budget.provider,budget.service_id,budget.currency,windowStart,windowEnd];
  const query=budget.provenance==="operator_imported"
    ?`SELECT COALESCE(SUM(provider_cost_micros),0) AS amount FROM ${table}
      WHERE tenant_id=? AND space_id=?${projectClause} AND provider=? AND service_id=? AND currency=? AND period_start>=? AND period_end<=?`
    :`SELECT COALESCE(SUM(provider_cost_micros),0) AS amount FROM ${table}
      WHERE tenant_id=? AND space_id=?${projectClause} AND provider=? AND service_id=? AND currency=? AND period_start>=? AND period_end<=?`;
  const row=await env.PLATFORM_DB.prepare(query).bind(...bindings).first<{amount:number}>();
  let amount=Number(row?.amount??0);
  // OpenRouter decision receipts already have an authoritative, settled generation ledger.
  // Include it directly in the provider-observed budget view instead of copying those receipts
  // into the generic provider-cost observation table.
  if(budget.provenance==="provider_api_observed"&&budget.provider==="openrouter"
    &&budget.service_id===OPENROUTER_DECISION_COST_SERVICE_ID&&budget.currency==="USD"){
    const decisionProjectClause=budget.project_id===null?"":" AND project_id=?";
    const decisionBindings=budget.project_id===null
      ?[budget.tenant_id,budget.space_id,windowStart,windowEnd]
      :[budget.tenant_id,budget.space_id,budget.project_id,windowStart,windowEnd];
    const decision=await env.PLATFORM_DB.prepare(`SELECT COALESCE(SUM(ROUND(provider_cost_usd*1000000)),0) AS amount
      FROM decision_call_reservations WHERE org_id=? AND space_id=?${decisionProjectClause} AND status='settled'
        AND provider_cost_usd IS NOT NULL AND usage_evidence_source IN ('openrouter_response','openrouter_generation_api')
        AND julianday(created_at)>=julianday(?) AND julianday(created_at)<=julianday(?)`)
      .bind(...decisionBindings).first<{amount:number}>();
    amount+=Number(decision?.amount??0);
  }
  if(!Number.isSafeInteger(amount)||amount<0)throw new Error("managed_service_cost_budget_total_invalid");
  return amount;
}

/** Reconcile rolling thresholds into durable owner-dashboard alerts. The alert state uses a
 * lease and compare-and-set so overlapping cron invocations emit one event per crossing. */
export async function sweepManagedServiceCostBudgetAlerts(
  env:AgentsEnv,
  now=new Date(),
  limit=100,
):Promise<{scanned:number;alertsCreated:number;thresholdsReset:number;deferred:number}>{
  if(!Number.isInteger(limit)||limit<1||limit>250)throw new Error("managed_service_cost_budget_sweep_limit_invalid");
  const windowEnd=now.toISOString(),windowStart=new Date(now.getTime()-30*86_400_000).toISOString();
  const due=await env.PLATFORM_DB.prepare(`SELECT id,tenant_id,space_id,project_id,provider,service_id,provenance,currency,
      limit_provider_cost_micros,updated_at FROM managed_service_cost_budgets ORDER BY updated_at,id LIMIT ?`)
    .bind(limit).all<CostBudgetRow>();
  const result={scanned:0,alertsCreated:0,thresholdsReset:0,deferred:0};
  for(const budget of due.results){
    result.scanned++;
    const at=now.toISOString(),token=`cba_${crypto.randomUUID()}`;
    await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_cost_budget_alert_state
      (budget_id,threshold_reached,last_observed_provider_cost_micros,updated_at)
      SELECT id,0,0,? FROM managed_service_cost_budgets WHERE id=? AND tenant_id=?`)
      .bind(at,budget.id,budget.tenant_id).run();
    const claimed=await env.PLATFORM_DB.prepare(`UPDATE managed_service_cost_budget_alert_state SET lease_token=?,lease_until=?,updated_at=?
      WHERE budget_id=? AND (lease_until IS NULL OR lease_until<=?)`)
      .bind(token,new Date(now.getTime()+120_000).toISOString(),at,budget.id,at).run();
    if(!claimed.meta.changes){result.deferred++;continue;}
    try{
      const state=await env.PLATFORM_DB.prepare(`SELECT threshold_reached,lease_token,last_observed_provider_cost_micros
        FROM managed_service_cost_budget_alert_state WHERE budget_id=?`).bind(budget.id).first<CostBudgetAlertState>();
      if(!state||state.lease_token!==token) {result.deferred++;continue;}
      const amount=await observedCostForBudget(env,budget,windowStart,windowEnd);
      const reached=amount>=budget.limit_provider_cost_micros;
      const wasReached=state.threshold_reached===1;
      const crossing=!wasReached&&reached;
      const alertId=crossing?`mca_${crypto.randomUUID()}`:null;
      const statements=[];
      if(crossing){
        statements.push(env.PLATFORM_DB.prepare(`INSERT INTO managed_service_cost_budget_alerts(id,budget_id,tenant_id,space_id,project_id,
          provider,service_id,provenance,currency,observed_provider_cost_micros,limit_provider_cost_micros,window_start,window_end,created_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM managed_service_cost_budget_alert_state
            WHERE budget_id=? AND lease_token=? AND threshold_reached=0)`)
          .bind(alertId,budget.id,budget.tenant_id,budget.space_id,budget.project_id,budget.provider,budget.service_id,budget.provenance,
            budget.currency,amount,budget.limit_provider_cost_micros,windowStart,windowEnd,at,budget.id,token));
        statements.push(env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_cost_budget_alert_deliveries
          (id,alert_id,tenant_id,space_id,user_id,status,attempts,next_at,created_at,updated_at)
          SELECT 'mcad_'||a.id,a.id,a.tenant_id,a.space_id,b.updated_by_user_id,'pending',0,?,?,?
          FROM managed_service_cost_budget_alerts a JOIN managed_service_cost_budgets b ON b.id=a.budget_id
          WHERE a.id=? AND b.updated_by_user_id IS NOT NULL`)
          .bind(at,at,at,alertId));
      }
      statements.push(env.PLATFORM_DB.prepare(`UPDATE managed_service_cost_budget_alert_state SET threshold_reached=?,
          last_observed_provider_cost_micros=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE budget_id=? AND lease_token=? AND threshold_reached=?`)
        .bind(reached?1:0,amount,at,budget.id,token,wasReached?1:0));
      const saved=await env.PLATFORM_DB.batch(statements);
      if(saved[0]?.meta.changes !== 1 || saved.slice(1).some(entry=>!entry?.meta.changes)){result.deferred++;continue;}
      if(crossing)result.alertsCreated++;
      else if(wasReached&&!reached)result.thresholdsReset++;
    }catch{
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_cost_budget_alert_state SET lease_token=NULL,lease_until=NULL,updated_at=?
        WHERE budget_id=? AND lease_token=?`).bind(at,budget.id,token).run().catch(()=>undefined);
      result.deferred++;
    }
  }
  return result;
}

export async function listManagedServiceCostBudgetAlerts(env:AgentsEnv,scope:CommunicationScope,limit=50){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("managed_service_cost_budget_alert_limit_invalid");
  const projectClause=scope.projectId?"a.project_id=?":"a.project_id IS NULL";
  const bindings=scope.projectId?[scope.tenantId,scope.spaceId,scope.projectId,limit]:[scope.tenantId,scope.spaceId,limit];
  const rows=await env.PLATFORM_DB.prepare(`SELECT a.id,a.provider,a.service_id,a.provenance,a.currency,a.observed_provider_cost_micros,
      a.limit_provider_cost_micros,a.window_start,a.window_end,a.created_at,
      (SELECT d.status FROM managed_service_cost_budget_alert_deliveries d WHERE d.alert_id=a.id) AS push_delivery_status
    FROM managed_service_cost_budget_alerts a
    WHERE a.tenant_id=? AND a.space_id=? AND ${projectClause} AND a.acknowledged_at IS NULL ORDER BY a.created_at DESC,a.id LIMIT ?`)
    .bind(...bindings).all<Record<string,unknown>>();
  return rows.results.map(row=>({id:String(row.id),provider:String(row.provider),serviceId:String(row.service_id),provenance:row.provenance as Provenance,
    currency:String(row.currency),observedProviderCostMicros:Number(row.observed_provider_cost_micros),
    limitProviderCostMicros:Number(row.limit_provider_cost_micros),windowStart:String(row.window_start),windowEnd:String(row.window_end),createdAt:String(row.created_at),
    pushDeliveryStatus:typeof row.push_delivery_status==="string"?row.push_delivery_status:null}));
}

type CostAlertDeliveryRow={id:string;alert_id:string;tenant_id:string;space_id:string;user_id:string;attempts:number;
  provider:string;service_id:string;currency:string;observed_provider_cost_micros:number;limit_provider_cost_micros:number;acknowledged_at:string|null};

/** Deliver dashboard crossings to the configuring user's opted-in browser subscriptions.
 * The D1 outbox is at-least-once across a lost Notifications response, with retry/backoff;
 * missing subscriptions and already-acknowledged alerts are terminal and remain visible in-app. */
export async function sweepManagedServiceCostBudgetAlertDeliveries(
  env:AgentsEnv,
  now=new Date(),
  limit=50,
):Promise<{scanned:number;delivered:number;noSubscription:number;suppressed:number;ambiguous:number;deferred:number}>{
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("managed_service_cost_budget_delivery_limit_invalid");
  const at=now.toISOString();
  const due=await env.PLATFORM_DB.prepare(`SELECT d.id FROM managed_service_cost_budget_alert_deliveries d
    WHERE (d.status='pending' AND d.next_at<=?) OR (d.status='running' AND d.lease_until<=?)
    ORDER BY d.next_at,d.created_at,d.id LIMIT ?`).bind(at,at,limit).all<{id:string}>();
  const result={scanned:due.results.length,delivered:0,noSubscription:0,suppressed:0,ambiguous:0,deferred:0};
  for(const candidate of due.results){
    const token=`mcadl_${crypto.randomUUID()}`;
    const claimed=await env.PLATFORM_DB.prepare(`UPDATE managed_service_cost_budget_alert_deliveries
      SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=?
      AND ((status='pending' AND next_at<=?) OR (status='running' AND lease_until<=?))`)
      .bind(token,new Date(now.getTime()+60_000).toISOString(),at,candidate.id,at,at).run();
    if(!claimed.meta.changes){result.deferred++;continue;}
    const row=await env.PLATFORM_DB.prepare(`SELECT d.id,d.alert_id,d.tenant_id,d.space_id,d.user_id,d.attempts,
        a.provider,a.service_id,a.currency,a.observed_provider_cost_micros,a.limit_provider_cost_micros,a.acknowledged_at
      FROM managed_service_cost_budget_alert_deliveries d JOIN managed_service_cost_budget_alerts a ON a.id=d.alert_id
      WHERE d.id=? AND d.lease_token=?`).bind(candidate.id,token).first<CostAlertDeliveryRow>();
    if(!row){result.deferred++;continue;}
    if(row.acknowledged_at){
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_cost_budget_alert_deliveries SET status='suppressed',lease_token=NULL,lease_until=NULL,
        last_error='already_acknowledged',updated_at=? WHERE id=? AND lease_token=?`).bind(at,row.id,token).run();
      result.suppressed++;continue;
    }
    const stillAuthorized=await env.PLATFORM_DB.prepare(`SELECT 1 AS ok FROM orgs o JOIN spaces s ON s.tenant_id=o.id
      WHERE o.id=? AND o.status='active' AND s.id=? AND s.status='active' AND
        (o.owner_id=? OR EXISTS(SELECT 1 FROM org_members m WHERE m.org_id=o.id AND m.user_id=? AND m.role IN ('owner','admin') AND m.joined_at IS NOT NULL)
          OR EXISTS(SELECT 1 FROM space_members sm WHERE sm.space_id=s.id AND sm.end_user_id=? AND sm.role IN ('owner','admin') AND sm.suspended_at IS NULL)) LIMIT 1`)
      .bind(row.tenant_id,row.space_id,row.user_id,row.user_id,row.user_id).first<{ok:number}>();
    if(!stillAuthorized){
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_cost_budget_alert_deliveries SET status='suppressed',lease_token=NULL,lease_until=NULL,
        last_error='recipient_access_revoked',updated_at=? WHERE id=? AND lease_token=?`).bind(at,row.id,token).run();
      result.suppressed++;continue;
    }
    if(!env.NOTIFICATIONS_WORKER){
      await deferManagedServiceCostBudgetAlertDelivery(env,row,token,at,"notifications_worker_unavailable",now);
      result.deferred++;continue;
    }
    try{
      const response=await env.NOTIFICATIONS_WORKER.fetch(new Request("http://notifications-worker/internal/notify",{
        method:"POST",headers:{"content-type":"application/json","x-naelao-tenant-id":row.tenant_id},
        body:JSON.stringify({channel:"web_push",space_id:row.space_id,user_id:row.user_id,
          subject:"Managed service cost threshold reached",
          message:`${row.provider} ${row.service_id} recorded ${formatCostMicros(row.observed_provider_cost_micros)} ${row.currency} over 30 days, reaching the configured ${formatCostMicros(row.limit_provider_cost_micros)} ${row.currency} threshold.`,
          notification_id:`managed-cost-alert:${row.id}`}),
      }));
      const body=await readBoundedResponseJson<{delivered?:unknown;reason?:unknown;outcome?:unknown}>(response,8_192)
        .catch(()=>({} as {delivered?:unknown;reason?:unknown;outcome?:unknown}));
      if(response.ok&&body.delivered===true){
        const saved=await env.PLATFORM_DB.prepare(`UPDATE managed_service_cost_budget_alert_deliveries SET status='delivered',lease_token=NULL,
          lease_until=NULL,last_error=NULL,delivered_at=?,updated_at=? WHERE id=? AND lease_token=?`)
          .bind(at,at,row.id,token).run();
        if(saved.meta.changes)result.delivered++;else result.deferred++;
      }else if(body.outcome==="attempt_ambiguous"){
        await env.PLATFORM_DB.prepare(`UPDATE managed_service_cost_budget_alert_deliveries SET status='ambiguous',lease_token=NULL,lease_until=NULL,
          last_error='notification_outcome_ambiguous',updated_at=? WHERE id=? AND lease_token=?`)
          .bind(at,row.id,token).run();
        result.ambiguous++;
      }else if(response.status===404||response.status===403||(response.status>=400&&response.status<500&&response.status!==408&&response.status!==429)){
        const terminal=response.status===404?"no_subscription":"suppressed";
        await env.PLATFORM_DB.prepare(`UPDATE managed_service_cost_budget_alert_deliveries SET status=?,lease_token=NULL,lease_until=NULL,
          last_error=?,updated_at=? WHERE id=? AND lease_token=?`)
          .bind(terminal,response.status===404?"no_active_web_push_subscription":String(body.reason??"notification_not_authorized").slice(0,100),at,row.id,token).run();
        if(terminal==="no_subscription")result.noSubscription++;else result.suppressed++;
      }else{
        const code=typeof body.reason==="string"&&/^[a-z0-9_-]{1,100}$/.test(body.reason)?body.reason:`notifications_http_${response.status}`;
        await deferManagedServiceCostBudgetAlertDelivery(env,row,token,at,code,now);
        result.deferred++;
      }
    }catch{
      await deferManagedServiceCostBudgetAlertDelivery(env,row,token,at,"notifications_delivery_unavailable",now);
      result.deferred++;
    }
  }
  return result;
}

async function deferManagedServiceCostBudgetAlertDelivery(env:AgentsEnv,row:CostAlertDeliveryRow,token:string,at:string,error:string,now:Date){
  const delay=Math.min(6*60*60_000,60_000*2**Math.min(Math.max(row.attempts-1,0),8));
  await env.PLATFORM_DB.prepare(`UPDATE managed_service_cost_budget_alert_deliveries SET status='pending',next_at=?,lease_token=NULL,
    lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease_token=?`)
    .bind(new Date(now.getTime()+delay).toISOString(),error.slice(0,100),at,row.id,token).run();
}

function formatCostMicros(value:number){
  return (value/1_000_000).toFixed(6).replace(/0+$/,"").replace(/\.$/,"");
}

export async function acknowledgeManagedServiceCostBudgetAlert(env:AgentsEnv,scope:CommunicationScope,alertId:string){
  if(!/^mca_[A-Za-z0-9_-]{1,128}$/.test(alertId))throw new Error("managed_service_cost_budget_alert_invalid");
  const at=new Date().toISOString();
  const result=await env.PLATFORM_DB.prepare(`UPDATE managed_service_cost_budget_alerts SET acknowledged_at=?,acknowledged_by_user_id=?
    WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND acknowledged_at IS NULL`)
    .bind(at,scope.userId,alertId,scope.tenantId,scope.spaceId,scope.projectId??null).run();
  if(result.meta.changes)return {acknowledged:true,replayed:false};
  const prior=await env.PLATFORM_DB.prepare(`SELECT acknowledged_by_user_id FROM managed_service_cost_budget_alerts
    WHERE id=? AND tenant_id=? AND space_id=? AND project_id IS ?`).bind(alertId,scope.tenantId,scope.spaceId,scope.projectId??null)
    .first<{acknowledged_by_user_id:string|null}>();
  if(!prior)throw new Error("managed_service_cost_budget_alert_not_found");
  return {acknowledged:true,replayed:true};
}
