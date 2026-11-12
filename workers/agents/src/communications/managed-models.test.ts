import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import { registerCommunicationRoutes } from "./routes.js";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import { createManagedModelQuote, runManagedModelOperation, purgeExpiredManagedModelResults } from "./managed-models.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const AT = new Date();
const EXPIRY = new Date(AT.getTime() + 30 * 86_400_000).toISOString();

function harness(approved = true) {
  const h = fixture();
  const aiRun = vi.fn(async (_model: string, _inputs: Record<string, unknown>) => ({ response: "managed answer" }));
  const billingCalls: Array<{ action:string; body:Record<string,unknown> }> = [];
  const billingFetch = vi.fn(async (request: Request) => {
    const action = new URL(request.url).pathname.split("/").at(-1) ?? "";
    const body = await request.json() as Record<string, unknown>;
    billingCalls.push({ action, body });
    if (action === "reserve") return Response.json({ reserved:true,status:"held",reservation_id:body.reservation_id,credits:body.credits });
    if (action === "settle") return Response.json({ settled:true,reservation_id:body.reservation_id,credits:body.credits });
    if (action === "uncertain") return Response.json({ uncertain:true,reservation_id:body.reservation_id });
    if (action === "release") return Response.json({ released:true,reservation_id:body.reservation_id });
    return Response.json({ error_code:"missing" }, { status:404 });
  });
  (h.env as unknown as { AI: { run: typeof aiRun }; BILLING_WORKER:{fetch:typeof billingFetch} }).AI = { run: aiRun };
  (h.env as unknown as { BILLING_WORKER:{fetch:typeof billingFetch} }).BILLING_WORKER = { fetch:billingFetch };
  const now = AT.toISOString();
  if (approved) {
    h.db.db.prepare(`UPDATE managed_service_capability_versions SET status='verified',verified_by='operator-1',verified_at=?,valid_until=?,regions_json='["global"]'
      WHERE provider='cloudflare' AND service_id='workers-ai' AND version=1`).run(now, EXPIRY);
    h.db.db.prepare(`INSERT INTO managed_service_model_entitlements(
      plan_tier,provider,service_id,capability_version,operation_name,model_id,region,price_version,max_credits_per_operation,
      max_operations_per_period,evidence_json,evidence_sha256,status,verified_by,verified_at,valid_until,created_at,updated_at,
      credits_per_operation,max_output_tokens)
      VALUES('free','cloudflare','workers-ai',1,'generate-text',?,'global','cf-llama-fixed-v1',100,5,'[]',?,'active','operator-1',?,?,?, ?,55,768)`)
      .run(MODEL, "a".repeat(64), now, EXPIRY, now, now);
  }
  return { ...h, aiRun, billingCalls, billingFetch };
}

async function createQuote(h: ReturnType<typeof harness>, prompt = "hello") {
  return createManagedModelQuote(h.env, scope, { modelId:MODEL, prompt }, AT);
}

describe("managed Workers AI operations", () => {
  it("requires an active operator verified model entitlement before provider or credit calls", async () => {
    const h = harness(false);
    await expect(createQuote(h))
      .rejects.toThrow("managed_model_not_entitled");
    expect(h.aiRun).not.toHaveBeenCalled();
    expect(h.billingFetch).not.toHaveBeenCalled();
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM managed_service_operations").get()).toEqual({ count:0 });
  });

  it("reserves the exact fixed price, encrypts the result, settles and deduplicates the owner request", async () => {
    const h = harness();
    const request = { modelId:MODEL,prompt:"private prompt body",idempotencyKey:"request-0001" };
    const priced = await createManagedModelQuote(h.env, scope, { modelId:MODEL,prompt:request.prompt }, AT);
    const first = await runManagedModelOperation(h.env, scope, { ...request,quoteId:priced.quoteId });
    expect(first).toMatchObject({ status:"complete",output:"managed answer",credits:55,priceVersion:"cf-llama-fixed-v1",maxOutputTokens:768 });
    expect(h.aiRun).toHaveBeenCalledTimes(1);
    expect(h.aiRun).toHaveBeenCalledWith(MODEL,{messages:[{role:"user",content:request.prompt}],max_tokens:768});
    expect(h.billingCalls.map((call) => call.action)).toEqual(["reserve","settle"]);
    expect(h.billingCalls[0]?.body).toMatchObject({ provider:"cloudflare",service_id:"workers-ai",operation_name:"generate-text",model_id:MODEL,credits:55,price_version:"cf-llama-fixed-v1" });
    expect(h.billingCalls[0]?.body.quote_id).toBe(priced.quoteId);
    expect(h.billingCalls[0]?.body.payer_mandate_id).toBe(h.db.db.prepare("SELECT id FROM managed_service_payer_mandates").get<{id:string}>()?.id);
    expect(h.db.db.prepare("SELECT operation_scopes_json,max_credits_per_operation,max_credits_per_period,auto_renew,authorized_by_user_id FROM managed_service_payer_mandates").get())
      .toMatchObject({ operation_scopes_json:'["cloudflare:workers-ai:generate-text"]',max_credits_per_operation:55,max_credits_per_period:55,auto_renew:0,authorized_by_user_id:"user" });
    const stored = h.db.db.prepare("SELECT envelope_json FROM managed_service_model_results").get() as {envelope_json:string};
    expect(stored.envelope_json).not.toContain("managed answer");
    expect(h.db.db.prepare("SELECT request_json FROM managed_service_operations").get()).toEqual({ request_json:"{}" });

    const replay = await runManagedModelOperation(h.env, scope, { ...request,quoteId:priced.quoteId });
    expect(replay).toMatchObject({ status:"complete",output:"managed answer",deduplicated:true });
    expect(h.aiRun).toHaveBeenCalledTimes(1);
    expect(h.billingCalls.map((call) => call.action)).toEqual(["reserve","settle","settle"]);
    expect(h.billingCalls[1]?.body.reservation_id).toBe(h.billingCalls[2]?.body.reservation_id);
    expect(h.db.db.prepare("SELECT status,credits,price_version,operation_id FROM managed_service_operation_quotes WHERE quote_id=?")
      .get(priced.quoteId)).toMatchObject({status:"consumed",credits:55,price_version:"cf-llama-fixed-v1"});
    expect(h.db.db.prepare("PRAGMA table_info(managed_service_operation_quotes)").all().map((row:any)=>row.name)).not.toContain("prompt");
    await expect(runManagedModelOperation(h.env, scope, { ...request,prompt:"different body",quoteId:priced.quoteId }))
      .rejects.toThrow("managed_model_idempotency_conflict");
  });

  it("keeps uncertain provider results held and never retries inference", async () => {
    const h = harness();
    h.aiRun.mockRejectedValueOnce(new Error("provider_timeout"));
    const request = { modelId:MODEL,prompt:"hello",idempotencyKey:"request-0002",quoteId:(await createQuote(h)).quoteId };
    const result = await runManagedModelOperation(h.env, scope, request);
    expect(result).toMatchObject({ status:"uncertain",errorCode:"provider_timeout",credits:55 });
    expect(h.billingCalls.map((call) => call.action)).toEqual(["reserve","uncertain"]);
    expect(await runManagedModelOperation(h.env, scope, request)).toMatchObject({ status:"uncertain",deduplicated:true });
    expect(h.aiRun).toHaveBeenCalledTimes(1);
  });

  it("requires an unexpired, single-use quote before creating a paid operation", async () => {
    const h = harness();
    const expired = await createQuote(h);
    await expect(runManagedModelOperation(h.env, scope, {modelId:MODEL,prompt:"hello",idempotencyKey:"request-0020",quoteId:expired.quoteId},
      new Date(AT.getTime() + 181_000))).rejects.toThrow("managed_model_quote_expired");
    expect(h.aiRun).not.toHaveBeenCalled();
    expect(h.billingCalls).toHaveLength(0);

    const used = await createQuote(h);
    await runManagedModelOperation(h.env, scope, {modelId:MODEL,prompt:"hello",idempotencyKey:"request-0021",quoteId:used.quoteId});
    await expect(runManagedModelOperation(h.env, scope, {modelId:MODEL,prompt:"another request",idempotencyKey:"request-0022",quoteId:used.quoteId}))
      .rejects.toThrow("managed_model_quote_already_used");
    expect(h.aiRun).toHaveBeenCalledTimes(1);
    expect(h.billingCalls.map((call) => call.action)).toEqual(["reserve","settle"]);
  });

  it("expires encrypted result payloads while retaining their operation receipt", async () => {
    const h = harness();
    const priced = await createQuote(h);
    await runManagedModelOperation(h.env, scope, { modelId:MODEL,prompt:"hello",idempotencyKey:"request-0003",quoteId:priced.quoteId });
    h.db.db.prepare("UPDATE managed_service_operation_quotes SET consumed_at=? WHERE quote_id=?")
      .run(new Date(AT.getTime() - 31 * 86_400_000).toISOString(), priced.quoteId);
    const removed = await purgeExpiredManagedModelResults(h.db, new Date(AT.getTime() + 8 * 86_400_000));
    expect(removed).toBe(1);
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM managed_service_model_results").get()).toEqual({ count:0 });
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM managed_service_operation_quotes").get()).toEqual({ count:0 });
    expect(h.db.db.prepare("SELECT status,result_ref FROM managed_service_operations").get()).toMatchObject({ status:"complete",result_ref:null });
  });

  it("reaches the model adapter through the owner authenticated communications action", async () => {
    const h = harness();
    const app = new Hono<{ Bindings:AgentsEnv }>();
    registerCommunicationRoutes(app);
    const call = async (userId: string, body:Record<string,unknown>) => app.fetch(new Request("https://agents.test/spaces/space/assistant-communications", {
      method:"POST",headers:{"content-type":"application/json","x-naelao-tenant-id":"tenant","x-naelao-user-id":userId,
        "x-naelao-role":"product_end_user","x-naelao-internal-token":await mintInternalToken("secret","tenant")},
      body:JSON.stringify(body),
    }), h.env);
    expect((await call("other",{action:"managed-model-quote",model_id:MODEL,prompt:"owner prompt"})).status).toBe(403);
    const quoteResponse = await call("user",{action:"managed-model-quote",model_id:MODEL,prompt:"owner prompt"});
    expect(quoteResponse.status).toBe(200);
    const priced = await quoteResponse.json() as {quoteId:string;credits:number;priceVersion:string;status:string};
    expect(priced).toMatchObject({credits:55,priceVersion:"cf-llama-fixed-v1",status:"quoted"});
    const response = await call("user",{action:"managed-model-run",confirmed:true,model_id:MODEL,prompt:"owner prompt",
      quote_id:priced.quoteId,idempotency_key:"route-allow-01"});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({status:"complete",output:"managed answer",credits:55});
    expect(h.aiRun).toHaveBeenCalledTimes(1);
  });
});
