import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import type { AgentsEnv } from "../index.js";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import { getManagedServiceDashboard } from "./managed-service-dashboard.js";
import { acknowledgeManagedServiceCostBudgetAlert, setManagedServiceCostBudget, sweepManagedServiceCostBudgetAlertDeliveries,
  sweepManagedServiceCostBudgetAlertEmailDeliveries, sweepManagedServiceCostBudgetAlerts } from "./managed-service-cost-budgets.js";
import { recordProviderApiCostObservation } from "./managed-service-cost-observations.js";
import { registerCommunicationRoutes } from "./routes.js";

describe("managed-service provider-cost threshold notices", () => {
  it("rotates the bounded alert sweep through budgets beyond its per-run limit", async () => {
    const f=fixture();
    for(let index=0;index<105;index++){
      await setManagedServiceCostBudget(f.env,scope,{provider:"test-provider",serviceId:`service-${String(index).padStart(3,"0")}`,
        provenance:"provider_api_observed",currency:"USD",limitProviderCostMicros:1_000});
    }
    const first=await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z"),50);
    const second=await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:01:00.000Z"),50);
    const third=await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:02:00.000Z"),50);
    expect([first.scanned,second.scanned,third.scanned]).toEqual([50,50,50]);
    expect(f.db.db.prepare("SELECT count(*) AS count FROM managed_service_cost_budget_alert_state").get()).toEqual({count:105});
  });

  it("keeps the owner-selected rolling threshold scoped by space, source and currency", async () => {
    const f = fixture();
    await recordProviderApiCostObservation(f.db, {
      tenantId:scope.tenantId,spaceId:scope.spaceId,provider:"telnyx",serviceId:"phone-number",
      operationRef:"private-operation-ref",accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",
      quantityMicros:1_000_000,providerCost:"0.004500",currency:"USD",periodStart:"2026-11-12T01:00:00.000Z",
      sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z",
    });
    const input={provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed" as const,currency:"USD",limitProviderCostMicros:5_000};
    await expect(setManagedServiceCostBudget(f.env,scope,input)).resolves.toMatchObject({removed:false,limitProviderCostMicros:5_000});
    const dashboard=await getManagedServiceDashboard(f.env,scope,new Date("2026-11-12T02:00:00.000Z"));
    expect(dashboard.providerCostBudgets30d).toEqual([expect.objectContaining({
      provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",currency:"USD",
      limitProviderCostMicros:5_000,observedProviderCostMicros:4_500,thresholdReached:false,
    })]);
    expect(JSON.stringify(dashboard.providerCostBudgets30d)).not.toContain("private-");

    await setManagedServiceCostBudget(f.env,scope,{...input,limitProviderCostMicros:4_000});
    const reached=await getManagedServiceDashboard(f.env,scope,new Date("2026-11-12T02:00:00.000Z"));
    expect(reached.providerCostBudgets30d[0]?.thresholdReached).toBe(true);
    const sweep=await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z"));
    expect(sweep).toMatchObject({scanned:1,alertsCreated:1,thresholdsReset:0,deferred:0});
    expect(f.db.db.prepare("SELECT status,user_id FROM managed_service_cost_budget_alert_deliveries").get())
      .toEqual({status:"pending",user_id:scope.userId});
    expect(f.db.db.prepare("SELECT count(*) AS count FROM managed_service_cost_budget_email_deliveries").get())
      .toEqual({count:0});
    await expect(sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:01:00.000Z")))
      .resolves.toMatchObject({alertsCreated:0,thresholdsReset:0,deferred:0});
    const alerted=await getManagedServiceDashboard(f.env,scope,new Date("2026-11-12T02:01:00.000Z"));
    expect(alerted.providerCostAlerts).toEqual([expect.objectContaining({provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",
      observedProviderCostMicros:4_500,limitProviderCostMicros:4_000,windowStart:"2026-10-13T02:00:00.000Z",windowEnd:"2026-11-12T02:00:00.000Z"})]);
    const alertId=alerted.providerCostAlerts[0]!.id;
    expect(alerted.providerCostAlerts[0]?.pushDeliveryStatus).toBe("pending");
    await expect(acknowledgeManagedServiceCostBudgetAlert(f.env,scope,alertId)).resolves.toEqual({acknowledged:true,replayed:false});
    await expect(acknowledgeManagedServiceCostBudgetAlert(f.env,scope,alertId)).resolves.toEqual({acknowledged:true,replayed:true});
    expect((await getManagedServiceDashboard(f.env,scope,new Date("2026-11-12T02:02:00.000Z"))).providerCostAlerts).toEqual([]);

    await expect(sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-12-20T02:00:00.000Z")))
      .resolves.toMatchObject({alertsCreated:0,thresholdsReset:1,deferred:0});
    await recordProviderApiCostObservation(f.db, {
      tenantId:scope.tenantId,spaceId:scope.spaceId,provider:"telnyx",serviceId:"phone-number",
      operationRef:"second-operation-ref",accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",
      quantityMicros:1_000_000,providerCost:"0.006000",currency:"USD",periodStart:"2026-12-20T01:00:00.000Z",
      sourceApi:"telnyx.messages.get",observedAt:"2026-12-20T01:01:00.000Z",
    });
    await expect(sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-12-20T02:01:00.000Z")))
      .resolves.toMatchObject({alertsCreated:1,thresholdsReset:0,deferred:0});
    await setManagedServiceCostBudget(f.env,scope,{...input,limitProviderCostMicros:null});
    const cleared=await getManagedServiceDashboard(f.env,scope,new Date("2026-11-12T02:00:00.000Z"));
    expect(cleared.providerCostBudgets30d).toEqual([]);
  });

  it("rejects unsupported provenance, currencies and unbounded limits", async () => {
    const f=fixture();
    const save=(input:Record<string,unknown>)=>setManagedServiceCostBudget(f.env,scope,input as never);
    await expect(save({provider:"telnyx",serviceId:"phone-number",provenance:"invoice_claimed",currency:"USD",limitProviderCostMicros:1000}))
      .rejects.toThrow("managed_service_cost_budget_invalid");
    await expect(save({provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",currency:"usd",limitProviderCostMicros:1000}))
      .rejects.toThrow("managed_service_cost_budget_invalid");
    await expect(save({provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",currency:"USD",limitProviderCostMicros:1_000_000_000_001}))
      .rejects.toThrow("managed_service_cost_budget_invalid");
  });

  it("uses dashboard-consistent Space rollups while keeping project budgets isolated", async () => {
    const f=fixture();
    const observation=(projectId:string,operationRef:string,providerCost:string)=>recordProviderApiCostObservation(f.db,{
      tenantId:scope.tenantId,spaceId:scope.spaceId,projectId,provider:"telnyx",serviceId:"phone-number",operationRef,
      accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",quantityMicros:1_000_000,providerCost,
      currency:"USD",periodStart:"2026-11-12T01:00:00.000Z",sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z",
    });
    await observation("project-a","project-a-operation","0.003000");
    await observation("project-b","project-b-operation","0.003000");
    const budget={provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed" as const,currency:"USD",limitProviderCostMicros:5_000};
    await setManagedServiceCostBudget(f.env,scope,budget);

    const workspaceDashboard=await getManagedServiceDashboard(f.env,scope,new Date("2026-11-12T02:00:00.000Z"));
    expect(workspaceDashboard.providerCostBudgets30d[0]).toMatchObject({observedProviderCostMicros:6_000,thresholdReached:true});
    const sweeps=await Promise.all([
      sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z")),
      sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z")),
    ]);
    expect(sweeps.reduce((total,result)=>total+result.alertsCreated,0)).toBe(1);
    expect(sweeps.reduce((total,result)=>total+result.deferred,0)).toBeGreaterThanOrEqual(1);
    expect((await getManagedServiceDashboard(f.env,scope,new Date("2026-11-12T02:01:00.000Z"))).providerCostAlerts)
      .toHaveLength(1);

    const projectScope={...scope,projectId:"project-a"};
    await setManagedServiceCostBudget(f.env,projectScope,budget);
    const projectDashboard=await getManagedServiceDashboard(f.env,projectScope,new Date("2026-11-12T02:00:00.000Z"));
    expect(projectDashboard.providerCostBudgets30d[0]).toMatchObject({observedProviderCostMicros:3_000,thresholdReached:false});
  });

  it("uses settled OpenRouter decision receipts in the existing provider-observed budget and alert path", async () => {
    const f=fixture();
    const insert=`INSERT INTO decision_call_reservations(
      id,org_id,space_id,project_id,run_id,model_id,price_snapshot,input_usd_per_token,output_usd_per_token,
      max_tokens,max_credits,status,actual_tokens,cost_credits,rate_card_version,provider_generation_id,
      provider_cost_usd,usage_evidence_source,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const save=(id:string,projectId:string,status:string,cost:number,source:string)=>f.db.prepare(insert).bind(
      id,scope.tenantId,scope.spaceId,projectId,`run-${id}`,"openai/gpt-4o-mini","2026-11-12T01:00:00.000Z",
      0.0000001,0.0000004,1000,100,status,12,1,`openrouter:generation:gen-${id}`,`gen-${id}`,cost,source,
      "2026-11-12 01:00:00","2026-11-12 01:01:00",
    ).run();
    await save("decision-a","project-a","settled",0.001,"openrouter_response");
    await save("decision-b","project-a","settled",0.002,"openrouter_generation_api");
    await save("decision-c","project-b","settled",0.004,"openrouter_generation_api");
    await save("decision-uncertain","project-a","uncertain",0.5,"openrouter_generation_api");

    const spaceBudget={provider:"openrouter",serviceId:"decision-model",provenance:"provider_api_observed" as const,
      currency:"USD",limitProviderCostMicros:6_000};
    await setManagedServiceCostBudget(f.env,scope,spaceBudget);
    const at=new Date("2026-11-12T02:00:00.000Z");
    expect((await getManagedServiceDashboard(f.env,scope,at)).providerCostBudgets30d).toEqual([
      expect.objectContaining({provider:"openrouter",serviceId:"decision-model",observedProviderCostMicros:7_000,
        thresholdReached:true,limitProviderCostMicros:6_000}),
    ]);
    await expect(sweepManagedServiceCostBudgetAlerts(f.env,at)).resolves.toMatchObject({scanned:1,alertsCreated:1});
    expect((await getManagedServiceDashboard(f.env,scope,at)).providerCostAlerts).toEqual([
      expect.objectContaining({provider:"openrouter",serviceId:"decision-model",observedProviderCostMicros:7_000,
        currency:"USD",provenance:"provider_api_observed"}),
    ]);

    const projectScope={...scope,projectId:"project-a"};
    await setManagedServiceCostBudget(f.env,projectScope,{...spaceBudget,limitProviderCostMicros:4_000});
    expect((await getManagedServiceDashboard(f.env,projectScope,at)).providerCostBudgets30d[0])
      .toMatchObject({observedProviderCostMicros:3_000,thresholdReached:false});
    await expect(sweepManagedServiceCostBudgetAlerts(f.env,at)).resolves.toMatchObject({scanned:2,alertsCreated:0});
  });

  it("saves and removes a threshold through the owner-authenticated UserPort action", async () => {
    const f = fixture();
    const app = new Hono<{ Bindings: AgentsEnv }>();
    registerCommunicationRoutes(app);
    const headers = {
      "content-type": "application/json",
      "x-naelao-tenant-id": scope.tenantId,
      "x-naelao-user-id": scope.userId,
      "x-naelao-role": scope.role,
      "x-naelao-internal-token": await mintInternalToken("secret", scope.tenantId),
    };
    const call = (userId: string, limit: number | null, emailAlertsEnabled?: boolean) => app.request(
      "/spaces/space/assistant-communications?action=managed-service-cost-budget",
      { method: "POST", headers: { ...headers, "x-naelao-user-id": userId }, body: JSON.stringify({
        action: "managed-service-cost-budget", provider: "telnyx", service_id: "phone-number",
        provenance: "provider_api_observed", currency: "USD", limit_provider_cost_micros: limit,
        ...(emailAlertsEnabled === undefined ? {} : { email_alerts_enabled: emailAlertsEnabled }),
      }) }, f.env,
    );

    expect((await call("other", 5_000)).status).toBe(403);
    expect((await call(scope.userId, 5_000, true)).status).toBe(200);
    expect((await getManagedServiceDashboard(f.env, scope)).providerCostBudgets30d[0]?.emailAlertsEnabled).toBe(true);
    expect((await call(scope.userId, 5_000, "yes" as never)).status).toBe(400);
    expect((await call(scope.userId, null)).status).toBe(200);
    expect((await getManagedServiceDashboard(f.env, scope)).providerCostBudgets30d).toEqual([]);
  });

  it("acknowledges durable cost alerts only through the owner-authorized action", async () => {
    const f=fixture();
    await recordProviderApiCostObservation(f.db,{tenantId:scope.tenantId,spaceId:scope.spaceId,provider:"telnyx",serviceId:"phone-number",
      operationRef:"alert-operation-ref",accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",quantityMicros:1_000_000,
      providerCost:"0.010000",currency:"USD",periodStart:"2026-11-12T01:00:00.000Z",sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z"});
    await setManagedServiceCostBudget(f.env,scope,{provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",currency:"USD",limitProviderCostMicros:5_000});
    await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z"));
    const alert=(await getManagedServiceDashboard(f.env,scope)).providerCostAlerts[0]!;
    const app=new Hono<{Bindings:AgentsEnv}>();registerCommunicationRoutes(app);
    const headers={"content-type":"application/json","x-naelao-tenant-id":scope.tenantId,"x-naelao-user-id":scope.userId,
      "x-naelao-role":scope.role,"x-naelao-internal-token":await mintInternalToken("secret",scope.tenantId)};
    const call=(userId:string)=>app.request("/spaces/space/assistant-communications?action=managed-service-cost-alert-ack",
      {method:"POST",headers:{...headers,"x-naelao-user-id":userId},body:JSON.stringify({action:"managed-service-cost-alert-ack",alert_id:alert.id})},f.env);
    expect((await call("other")).status).toBe(403);
    expect((await call(scope.userId)).status).toBe(200);
    expect((await call(scope.userId)).status).toBe(200);
    expect((await getManagedServiceDashboard(f.env,scope)).providerCostAlerts).toEqual([]);
  });

  it("delivers opted-in browser push alerts through a leased durable outbox and retries transient failures", async () => {
    const f=fixture();
    await recordProviderApiCostObservation(f.db,{tenantId:scope.tenantId,spaceId:scope.spaceId,provider:"telnyx",serviceId:"phone-number",
      operationRef:"push-alert-operation",accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",quantityMicros:1_000_000,
      providerCost:"0.010000",currency:"USD",periodStart:"2026-11-12T01:00:00.000Z",sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z"});
    await setManagedServiceCostBudget(f.env,scope,{provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",currency:"USD",limitProviderCostMicros:5_000});
    await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z"));
    const notify=vi.fn(async()=>Response.json({delivered:true,channel:"web_push",devices:1}));
    f.env.NOTIFICATIONS_WORKER={fetch:notify} as unknown as Fetcher;
    await expect(sweepManagedServiceCostBudgetAlertDeliveries(f.env,new Date("2026-11-12T02:01:00.000Z")))
      .resolves.toEqual({scanned:1,delivered:1,noSubscription:0,suppressed:0,ambiguous:0,deferred:0});
    const request=notify.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("http://notifications-worker/internal/notify");
    expect(request.headers.get("x-naelao-tenant-id")).toBe(scope.tenantId);
    const payload=await request.json() as Record<string,unknown>;
    expect(payload).toMatchObject({channel:"web_push",space_id:scope.spaceId,user_id:scope.userId,
      subject:"Managed service cost threshold reached",message:expect.stringContaining("0.01 USD"),
      notification_id:expect.stringMatching(/^managed-cost-alert:/)});
    expect(f.db.db.prepare("SELECT status,attempts,last_error FROM managed_service_cost_budget_alert_deliveries").get())
      .toEqual({status:"delivered",attempts:1,last_error:null});

    const retry=fixture();
    await recordProviderApiCostObservation(retry.db,{tenantId:scope.tenantId,spaceId:scope.spaceId,provider:"telnyx",serviceId:"phone-number",
      operationRef:"retry-alert-operation",accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",quantityMicros:1_000_000,
      providerCost:"0.010000",currency:"USD",periodStart:"2026-11-12T01:00:00.000Z",sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z"});
    await setManagedServiceCostBudget(retry.env,scope,{provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",currency:"USD",limitProviderCostMicros:5_000});
    await sweepManagedServiceCostBudgetAlerts(retry.env,new Date("2026-11-12T02:00:00.000Z"));
    retry.env.NOTIFICATIONS_WORKER={fetch:vi.fn(async()=>Response.json({delivered:false},{status:503}))} as unknown as Fetcher;
    await expect(sweepManagedServiceCostBudgetAlertDeliveries(retry.env,new Date("2026-11-12T02:01:00.000Z")))
      .resolves.toMatchObject({scanned:1,delivered:0,deferred:1});
    expect(retry.db.db.prepare("SELECT status,attempts,last_error FROM managed_service_cost_budget_alert_deliveries").get())
      .toMatchObject({status:"pending",attempts:1,last_error:"notifications_http_503"});
    await expect(sweepManagedServiceCostBudgetAlertDeliveries(retry.env,new Date("2026-11-12T02:01:30.000Z")))
      .resolves.toMatchObject({scanned:0});
    retry.env.NOTIFICATIONS_WORKER={fetch:vi.fn(async()=>Response.json({delivered:false,reason:"no_subscription"},{status:404}))} as unknown as Fetcher;
    await expect(sweepManagedServiceCostBudgetAlertDeliveries(retry.env,new Date("2026-11-12T02:02:00.000Z")))
      .resolves.toMatchObject({scanned:1,noSubscription:1,deferred:0});
    expect(retry.db.db.prepare("SELECT status,last_error FROM managed_service_cost_budget_alert_deliveries").get())
      .toEqual({status:"no_subscription",last_error:"no_active_web_push_subscription"});
  });

  it("delivers an explicitly opted-in email alert to the current active account address", async () => {
    const f = fixture();
    f.db.db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL,status TEXT NOT NULL); INSERT INTO users VALUES('user','owner@example.test','active');");
    const ownerScope = { ...scope, role: "owner" };
    await recordProviderApiCostObservation(f.db, { tenantId:scope.tenantId,spaceId:scope.spaceId,provider:"telnyx",serviceId:"phone-number",
      operationRef:"email-alert-operation",accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",quantityMicros:1_000_000,
      providerCost:"0.010000",currency:"USD",periodStart:"2026-11-12T01:00:00.000Z",sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z" });
    await setManagedServiceCostBudget(f.env, ownerScope, { provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",
      currency:"USD",limitProviderCostMicros:5_000,emailAlertsEnabled:true });
    await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z"));
    expect(f.db.db.prepare("SELECT user_id,recipient_kind,status FROM managed_service_cost_budget_email_deliveries").get())
      .toEqual({user_id:"user",recipient_kind:"builder_user",status:"pending"});
    expect(JSON.stringify(f.db.db.prepare("SELECT * FROM managed_service_cost_budget_email_deliveries").get())).not.toContain("owner@example.test");

    const notify=vi.fn(async()=>Response.json({delivered:true,accepted:true,outcome:"provider_accepted",channel:"email"}));
    f.env.NOTIFICATIONS_WORKER={fetch:notify} as unknown as Fetcher;
    await expect(sweepManagedServiceCostBudgetAlertEmailDeliveries(f.env,new Date("2026-11-12T02:01:00.000Z")))
      .resolves.toEqual({scanned:1,accepted:1,rejected:0,ambiguous:0,suppressed:0,noRecipient:0,deferred:0});
    const request=notify.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("http://notifications-worker/internal/notify");
    expect(request.headers.get("x-naelao-tenant-id")).toBe(scope.tenantId);
    expect(await request.json()).toMatchObject({channel:"email",space_id:scope.spaceId,to:"owner@example.test",
      subject:"Managed service cost warning",body:expect.stringContaining("0.01 USD"),
      notification_id:expect.stringMatching(/^managed-cost-alert-email:/)});
    expect(f.db.db.prepare("SELECT status,attempts,last_error,accepted_at FROM managed_service_cost_budget_email_deliveries").get())
      .toMatchObject({status:"provider_accepted",attempts:1,last_error:null,accepted_at:"2026-11-12T02:01:00.000Z"});
    expect((await getManagedServiceDashboard(f.env,ownerScope,new Date("2026-11-12T02:01:00.000Z"))).providerCostAlerts[0]?.emailDeliveryStatus)
      .toBe("provider_accepted");
  });

  it("resolves product-user email through the Space product and preserves provider rejection as terminal", async () => {
    const f = fixture();
    f.db.db.exec(`CREATE TABLE product_end_users (
      product_space_id TEXT NOT NULL,end_user_id TEXT NOT NULL,email TEXT,email_verified_at TEXT,
      suspended_at TEXT,deleted_at TEXT,PRIMARY KEY(product_space_id,end_user_id));
      ALTER TABLE spaces ADD COLUMN product_id TEXT;
      UPDATE spaces SET product_id='product' WHERE id='space';
      INSERT INTO product_end_users(product_space_id,end_user_id,email,email_verified_at)
        VALUES('product','user','verified@example.test','2026-11-01T00:00:00.000Z');`);
    const productOwnerScope = { ...scope, role: "product_end_user" };
    await recordProviderApiCostObservation(f.db,{tenantId:scope.tenantId,spaceId:scope.spaceId,provider:"telnyx",serviceId:"phone-number",
      operationRef:"product-email-alert-operation",accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",quantityMicros:1_000_000,
      providerCost:"0.010000",currency:"USD",periodStart:"2026-11-12T01:00:00.000Z",sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z"});
    await setManagedServiceCostBudget(f.env,productOwnerScope,{provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",
      currency:"USD",limitProviderCostMicros:5_000,emailAlertsEnabled:true});
    await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z"));
    const notify=vi.fn(async()=>Response.json({delivered:false,outcome:"provider_rejected",status:422},{status:502}));
    f.env.NOTIFICATIONS_WORKER={fetch:notify} as unknown as Fetcher;
    await expect(sweepManagedServiceCostBudgetAlertEmailDeliveries(f.env,new Date("2026-11-12T02:01:00.000Z")))
      .resolves.toMatchObject({rejected:1,deferred:0});
    const request=notify.mock.calls[0]?.[0] as Request;
    expect(await request.json()).toMatchObject({channel:"email",to:"verified@example.test"});
    expect(f.db.db.prepare("SELECT status,last_error FROM managed_service_cost_budget_email_deliveries").get())
      .toEqual({status:"provider_rejected",last_error:"email_provider_rejected"});
    await expect(sweepManagedServiceCostBudgetAlertEmailDeliveries(f.env,new Date("2026-11-12T02:02:00.000Z")))
      .resolves.toMatchObject({scanned:0,rejected:0});
    expect(notify).toHaveBeenCalledOnce();
  });

  it("suppresses queued email if an owner removes its cost threshold", async () => {
    const f=fixture();
    await recordProviderApiCostObservation(f.db,{tenantId:scope.tenantId,spaceId:scope.spaceId,provider:"telnyx",serviceId:"phone-number",
      operationRef:"email-removed-operation",accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",quantityMicros:1_000_000,
      providerCost:"0.010000",currency:"USD",periodStart:"2026-11-12T01:00:00.000Z",sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z"});
    const ownerScope={...scope,role:"owner"};
    const budget={provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed" as const,currency:"USD"};
    await setManagedServiceCostBudget(f.env,ownerScope,{...budget,limitProviderCostMicros:5_000,emailAlertsEnabled:true});
    await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z"));
    await setManagedServiceCostBudget(f.env,ownerScope,{...budget,limitProviderCostMicros:null});
    const notify=vi.fn();f.env.NOTIFICATIONS_WORKER={fetch:notify} as unknown as Fetcher;
    await expect(sweepManagedServiceCostBudgetAlertEmailDeliveries(f.env,new Date("2026-11-12T02:01:00.000Z")))
      .resolves.toMatchObject({scanned:0,accepted:0});
    expect(notify).not.toHaveBeenCalled();
    expect(f.db.db.prepare("SELECT status,last_error FROM managed_service_cost_budget_email_deliveries").get())
      .toEqual({status:"suppressed",last_error:"budget_removed"});
  });

  it("pauses email after an ambiguous provider outcome and suppresses queued delivery after access revocation", async () => {
    const f=fixture();
    f.db.db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL,status TEXT NOT NULL); INSERT INTO users VALUES('user','owner@example.test','active');");
    const ownerScope={...scope,role:"owner"};
    await recordProviderApiCostObservation(f.db,{tenantId:scope.tenantId,spaceId:scope.spaceId,provider:"telnyx",serviceId:"phone-number",
      operationRef:"email-ambiguous-operation",accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",quantityMicros:1_000_000,
      providerCost:"0.010000",currency:"USD",periodStart:"2026-11-12T01:00:00.000Z",sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z"});
    await setManagedServiceCostBudget(f.env,ownerScope,{provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",
      currency:"USD",limitProviderCostMicros:5_000,emailAlertsEnabled:true});
    await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z"));
    const notify=vi.fn(async()=>Response.json({delivered:false,outcome:"attempt_ambiguous",reconcile_required:true},{status:502}));
    f.env.NOTIFICATIONS_WORKER={fetch:notify} as unknown as Fetcher;
    await expect(sweepManagedServiceCostBudgetAlertEmailDeliveries(f.env,new Date("2026-11-12T02:01:00.000Z")))
      .resolves.toMatchObject({ambiguous:1,accepted:0});
    await expect(sweepManagedServiceCostBudgetAlertEmailDeliveries(f.env,new Date("2026-11-12T02:02:00.000Z")))
      .resolves.toMatchObject({scanned:0});
    expect(notify).toHaveBeenCalledOnce();

    const revoked=fixture();
    revoked.db.db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL,status TEXT NOT NULL); INSERT INTO users VALUES('user','owner@example.test','active');");
    await recordProviderApiCostObservation(revoked.db,{tenantId:scope.tenantId,spaceId:scope.spaceId,provider:"telnyx",serviceId:"phone-number",
      operationRef:"email-revoked-operation",accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",quantityMicros:1_000_000,
      providerCost:"0.010000",currency:"USD",periodStart:"2026-11-12T01:00:00.000Z",sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z"});
    await setManagedServiceCostBudget(revoked.env,ownerScope,{provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",
      currency:"USD",limitProviderCostMicros:5_000,emailAlertsEnabled:true});
    await sweepManagedServiceCostBudgetAlerts(revoked.env,new Date("2026-11-12T02:00:00.000Z"));
    revoked.db.db.prepare("DELETE FROM org_members WHERE org_id=? AND user_id=?").run(scope.tenantId,scope.userId);
    revoked.db.db.prepare("UPDATE orgs SET owner_id='somebody-else' WHERE id=?").run(scope.tenantId);
    revoked.db.db.prepare("DELETE FROM space_members WHERE space_id=? AND end_user_id=?").run(scope.spaceId,scope.userId);
    const noSend=vi.fn();
    revoked.env.NOTIFICATIONS_WORKER={fetch:noSend} as unknown as Fetcher;
    await expect(sweepManagedServiceCostBudgetAlertEmailDeliveries(revoked.env,new Date("2026-11-12T02:01:00.000Z")))
      .resolves.toMatchObject({suppressed:1,accepted:0});
    expect(noSend).not.toHaveBeenCalled();
    expect(revoked.db.db.prepare("SELECT status,last_error FROM managed_service_cost_budget_email_deliveries").get())
      .toEqual({status:"suppressed",last_error:"recipient_access_revoked"});
  });

  it("holds an ambiguous notification outcome without automatic re-egress", async () => {
    const f=fixture();
    await recordProviderApiCostObservation(f.db,{tenantId:scope.tenantId,spaceId:scope.spaceId,provider:"telnyx",serviceId:"phone-number",
      operationRef:"ambiguous-alert-operation",accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",quantityMicros:1_000_000,
      providerCost:"0.010000",currency:"USD",periodStart:"2026-11-12T01:00:00.000Z",sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z"});
    await setManagedServiceCostBudget(f.env,scope,{provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",currency:"USD",limitProviderCostMicros:5_000});
    await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z"));
    const notify=vi.fn(async()=>Response.json({delivered:false,outcome:"attempt_ambiguous",reconcile_required:true},{status:409}));
    f.env.NOTIFICATIONS_WORKER={fetch:notify} as unknown as Fetcher;
    await expect(sweepManagedServiceCostBudgetAlertDeliveries(f.env,new Date("2026-11-12T02:01:00.000Z")))
      .resolves.toMatchObject({scanned:1,delivered:0,ambiguous:1,deferred:0});
    expect(f.db.db.prepare("SELECT status,last_error FROM managed_service_cost_budget_alert_deliveries").get())
      .toEqual({status:"ambiguous",last_error:"notification_outcome_ambiguous"});
    const dashboard=await getManagedServiceDashboard(f.env,scope,new Date("2026-11-12T02:02:00.000Z"));
    expect(dashboard.providerCostAlerts[0]?.pushDeliveryStatus).toBe("ambiguous");
    await expect(sweepManagedServiceCostBudgetAlertDeliveries(f.env,new Date("2026-11-12T02:02:00.000Z")))
      .resolves.toMatchObject({scanned:0,ambiguous:0});
    expect(notify).toHaveBeenCalledOnce();
  });

  it("suppresses queued push after the configuring user loses organization and Space access", async () => {
    const f=fixture();
    await recordProviderApiCostObservation(f.db,{tenantId:scope.tenantId,spaceId:scope.spaceId,provider:"telnyx",serviceId:"phone-number",
      operationRef:"revoked-alert-operation",accountRef:"private-account-ref",usageKind:"sms",quantityUnit:"message",quantityMicros:1_000_000,
      providerCost:"0.010000",currency:"USD",periodStart:"2026-11-12T01:00:00.000Z",sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z"});
    await setManagedServiceCostBudget(f.env,scope,{provider:"telnyx",serviceId:"phone-number",provenance:"provider_api_observed",currency:"USD",limitProviderCostMicros:5_000});
    await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z"));
    f.db.db.prepare("DELETE FROM org_members WHERE org_id=? AND user_id=?").run(scope.tenantId,scope.userId);
    f.db.db.prepare("UPDATE orgs SET owner_id='somebody-else' WHERE id=?").run(scope.tenantId);
    f.db.db.prepare("DELETE FROM space_members WHERE space_id=? AND end_user_id=?").run(scope.spaceId,scope.userId);
    const notify=vi.fn();
    f.env.NOTIFICATIONS_WORKER={fetch:notify} as unknown as Fetcher;
    await expect(sweepManagedServiceCostBudgetAlertDeliveries(f.env,new Date("2026-11-12T02:01:00.000Z")))
      .resolves.toMatchObject({scanned:1,suppressed:1,delivered:0});
    expect(notify).not.toHaveBeenCalled();
    expect(f.db.db.prepare("SELECT status,last_error FROM managed_service_cost_budget_alert_deliveries").get())
      .toEqual({status:"suppressed",last_error:"recipient_access_revoked"});
  });

  it("rechecks exact project-owner authority before delivering project-scoped alerts", async () => {
    const f=fixture();
    const projectScope={...scope,projectId:"project-costs"};
    for(const serviceId of ["project-service-a","project-service-b"]){
      await recordProviderApiCostObservation(f.db,{tenantId:scope.tenantId,spaceId:scope.spaceId,projectId:projectScope.projectId,
        provider:"telnyx",serviceId,operationRef:`${serviceId}-operation`,accountRef:"private-account-ref",usageKind:"sms",
        quantityUnit:"message",quantityMicros:1_000_000,providerCost:"0.010000",currency:"USD",
        periodStart:"2026-11-12T01:00:00.000Z",sourceApi:"telnyx.messages.get",observedAt:"2026-11-12T01:01:00.000Z"});
      await setManagedServiceCostBudget(f.env,projectScope,{provider:"telnyx",serviceId,provenance:"provider_api_observed",
        currency:"USD",limitProviderCostMicros:5_000});
    }
    await sweepManagedServiceCostBudgetAlerts(f.env,new Date("2026-11-12T02:00:00.000Z"));
    await f.db.prepare("UPDATE orgs SET owner_id='another-user' WHERE id=?").bind(scope.tenantId).run();
    await f.db.prepare("INSERT INTO org_members(org_id,user_id,role,joined_at) VALUES(?,?,?,?)").bind(scope.tenantId,"another-user","owner","now").run();
    await f.db.prepare("UPDATE space_members SET role='member' WHERE space_id=? AND end_user_id=?").bind(scope.spaceId,scope.userId).run();
    let projectRole="owner";
    f.fetch.mockImplementation(async request=>request.url.includes("assistant-access")
      ?Response.json({effective_role:projectRole})
      :Response.json({preferences:{enabled:{email:true,phone:false}}}));
    f.env.NOTIFICATIONS_WORKER={fetch:vi.fn(async()=>{
      projectRole="viewer";
      return Response.json({delivered:true,channel:"web_push",devices:1});
    })} as unknown as Fetcher;

    const deliveryResult=await sweepManagedServiceCostBudgetAlertDeliveries(f.env,new Date("2026-11-12T02:01:00.000Z"));
    expect(deliveryResult).toMatchObject({scanned:2,delivered:1,suppressed:1,deferred:0});
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls.every(([request])=>String(request.url).includes(`/projects/${projectScope.projectId}/assistant-access?user_id=${scope.userId}`))).toBe(true);
    expect(f.env.NOTIFICATIONS_WORKER.fetch).toHaveBeenCalledTimes(1);
    expect(f.db.db.prepare("SELECT status,last_error FROM managed_service_cost_budget_alert_deliveries ORDER BY id").all())
      .toEqual(expect.arrayContaining([{status:"delivered",last_error:null},{status:"suppressed",last_error:"recipient_access_revoked"}]));
  });
});
