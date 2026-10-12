import { describe, expect, it } from "vitest";
import { BlueprintConformanceWorkflow, conformanceDigest } from "../../workers/spaces/src/BlueprintConformanceWorkflow.js";
import { verifyArtifactCertificate } from "@naelao/security";

async function harness(fail = false) {
  const blueprint = { id: "blueprint", schemaVersion: "2.0", metadata: {}, templateCategory: "venture", requiredExtensions: [], requiredCredentials: [], projects: [] };
  const suite = { fixtures: Array.from({ length: 50 }, (_, i) => ({ id: `fixture-${i}` })) };
  const raw = JSON.stringify({ blueprint, suite, security: { rating: "green" } });
  const objects = new Map<string,string>([["job-key", raw]]); let executions = 0; let installations = 0;
  const env = {
    PLATFORM_SECRET: "secret",
    SCRIPTS_R2: { get: async (key: string) => { const value=objects.get(key); return value ? { size:value.length,text:async()=>value } : null; }, put:async(key: string,value:string)=>{objects.set(key,value);} },
    SPACE_DO: { idFromName: (name: string)=>name, get:()=>({fetch:async()=>{installations++;return Response.json({installed:true});}}) },
    CONFORMANCE_EXECUTOR: { fetch: async (request: Request) => { const { fixture } = await request.json() as { fixture: { id: string } }; executions++; return Response.json(fail && fixture.id === "fixture-0" ? {passed:false,error:"state_delta_mismatch"} : {passed:true}); } },
  };
  let cache = new Map<string,unknown>();
  const step = { async do(name: string, ...args: unknown[]) {
    if(cache.has(name)) return cache.get(name);
    const value=await (args.at(-1) as ()=>Promise<unknown>)(); const serialized=JSON.stringify(value);
    if(serialized.length>1024*1024) throw new Error("Workflow step result exceeds provider limit");
    cache.set(name,JSON.parse(serialized));return cache.get(name);
  } };
  const event = { payload: { tenantId:"tenant", jobId:"job",key:"job-key",digest:await conformanceDigest(raw) } };
  const run = () => new BlueprintConformanceWorkflow({} as never,env as never).run(event as never,step as never);
  return {run,blueprint,objects,executions:()=>executions,installations:()=>installations,restart:()=>{cache=new Map(JSON.parse(JSON.stringify([...cache])));}};
}
describe("blueprint conformance durable step replay (provider interfaces mocked)", () => {
  it("pins artifact bytes and does not repeat fixture effects or signing after restart", async () => {
    const h=await harness();const result=await h.run();
    expect(result).toMatchObject({status:"certified",report:{passed:50,total:50}});
    const envelope=JSON.parse(h.objects.get("blueprints/blueprint.json")!);
    expect(await verifyArtifactCertificate(h.blueprint,envelope.conformanceCertificate,"secret","state-delta")).toBe(true);
    h.restart(); expect(await h.run()).toEqual(result);
    expect(h.executions()).toBe(50); expect(h.installations()).toBe(1);
  });
  it("rejects a regression without creating a publishable artifact", async () => {
    const h=await harness(true);expect(await h.run()).toMatchObject({status:"rejected",report:{passed:49,total:50}});
    expect(h.objects.has("blueprints/blueprint.json")).toBe(false);
  });
  it("rejects changed R2 job bytes before executing a worker", async () => {
    const h=await harness();h.objects.set("job-key",h.objects.get("job-key")!+" ");
    await expect(h.run()).rejects.toThrow("conformance_artifact_changed");expect(h.executions()).toBe(0);
  });
});
