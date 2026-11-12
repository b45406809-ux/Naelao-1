import { afterEach, describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { sealConnection } from "./connection-crypto.js";
import app from "./index.js";

const secret="runtime-route-secret",digest=`sha256:${"a".repeat(64)}`;

class Statement {
  values:unknown[]=[];
  constructor(readonly db:RuntimeDb,readonly sql:string){}
  bind(...values:unknown[]){this.values=values;return this;}
  first<T>(){return Promise.resolve(this.db.first<T>(this.sql,this.values));}
  all<T>(){return Promise.resolve({results:this.db.all<T>(this.sql,this.values)});}
  run(){return Promise.resolve(this.db.run(this.sql,this.values));}
}

class RuntimeDb {
  readonly operations=new Map<string,Record<string,unknown>>();
  readonly executions=new Map<string,Record<string,unknown>>();
  readonly transfers=new Map<string,Record<string,unknown>>();
  readonly deletions=new Map<string,Record<string,unknown>>();
  allocation:Record<string,unknown>|null=null;
  computer:Record<string,unknown>;
  connectionStatus="configured_unverified";
  failNextBatch=false;
  constructor(row:Record<string,unknown>){this.computer=row;}
  prepare(sql:string){return new Statement(this,sql);}
  first<T>(sql:string,values:unknown[]):T|null{
    if(sql.startsWith("SELECT id,space_id,project_id FROM sandbox_computers"))return {id:this.computer.id,space_id:this.computer.space_id,project_id:this.computer.project_id} as T;
    if(sql.includes("FROM sandbox_computers c LEFT JOIN sandbox_connections"))return {...this.computer,connection_status:this.connectionStatus} as T;
    if(sql.includes("FROM sandbox_computers c")&&sql.includes("JOIN sandbox_connections conn"))return {connection_status:this.connectionStatus,deleted_at:null} as T;
    if(sql.includes("FROM sandbox_allocations")&&sql.includes("WHERE computer_id=?"))return this.allocation as T|null;
    if(sql.includes("FROM sandbox_operations")&&sql.includes("WHERE id=?"))return ([...this.operations.values()].find(row=>row.id===values[0])??null) as T|null;
    if(sql.includes("FROM sandbox_operations")&&sql.includes("idempotency_key"))return (this.operations.get(`${values[0]}:${values[1]}`)??null) as T|null;
    if(sql.includes("FROM sandbox_executions")&&sql.includes("idempotency_key"))return ([...this.executions.values()].find(row=>row.computer_id===values[0]&&row.idempotency_key===values[1])??null) as T|null;
    if(sql.includes("FROM sandbox_executions")&&sql.includes("WHERE id=?"))return this.executions.get(String(values[0])) as T|null;
    if(sql.includes("FROM sandbox_artifact_transfers")&&sql.includes("WHERE id=?"))return this.transfers.get(String(values[0])) as T|null;
    return null;
  }
  all<T>(sql:string,_values:unknown[]):T[]{
    if(sql.includes("FROM sandbox_computers c WHERE tenant_id=?")){
      const operation=[...this.operations.values()].find(item=>item.id===this.computer.active_operation_id);
      return [{...this.computer,active_operation_type:operation?.operation??null,active_operation_status:operation?.status??null} as T];
    }
    if(sql.includes("SELECT id AS allocation_id,connection_id,provider,external_id,generation FROM sandbox_allocations")){
      return this.allocation&&this.allocation.status!=="destroyed"?[{allocation_id:this.allocation.id,connection_id:this.allocation.connection_id,provider:this.allocation.provider,
        external_id:this.allocation.external_id,generation:this.allocation.generation} as T]:[];
    }
    return [];
  }
  run(sql:string,v:unknown[]){
    let changes=1;
    if(sql.includes("INSERT INTO sandbox_operations")){
      const row={id:v[0],tenant_id:v[1],computer_id:v[2],operation:"start",idempotency_key:v[3],payload_hash:v[4],status:"pending",generation:v[5],result_json:null,error_code:null};
      this.operations.set(`${v[1]}:${v[3]}`,row);
    }else if(sql.includes("UPDATE sandbox_operations SET status='running'")){
      const row=[...this.operations.values()].find(item=>item.id===v[2]);if(row)row.status="running";else changes=0;
    }else if(sql.includes("UPDATE sandbox_operations SET status='complete'")){
      const row=[...this.operations.values()].find(item=>item.id===v[2]);if(row){row.status="complete";row.result_json=v[0];row.error_code=null;}
    }else if(sql.includes("UPDATE sandbox_operations SET status='failed'")){
      const row=[...this.operations.values()].find(item=>item.id===v[v.length-1]);if(row){row.status="failed";row.error_code=sql.match(/error_code='([^']+)'/)?.[1]??v[0];}
    }else if(sql.includes("UPDATE sandbox_operations SET status='indeterminate'")){
      const row=[...this.operations.values()].find(item=>item.id===v[v.length-1]);if(row){row.status="indeterminate";row.error_code=v[0];}
    }else if(sql.includes("UPDATE sandbox_computers SET state='provisioning'")){
      this.computer={...this.computer,allocation_generation:v[0],active_operation_id:v[1],state:"provisioning"};
    }else if(sql.includes("INSERT INTO sandbox_allocations")){
      this.allocation={id:v[0],computer_id:v[1],connection_id:v[2],provider:"agent37",external_id:null,generation:v[3],status:"intent",operation_id:v[4],image_digest:null};
    }else if(sql.includes("UPDATE sandbox_allocations SET external_id=?")){
      if(this.allocation){this.allocation.external_id=v[0];this.allocation.status="active";}
    }else if(sql.includes("INSERT OR IGNORE INTO sandbox_provider_deletion_operations")){
      if(!this.deletions.has(String(v[0])))this.deletions.set(String(v[0]),{id:v[0],tenant_id:v[1],allocation_id:v[5],external_id:v[8],generation:v[9],status:v[11],reason_code:v[12]});
      else changes=0;
    }else if(sql.includes("UPDATE sandbox_computers SET state=CASE")){
      this.computer={...this.computer,state:this.allocation?.external_id?"deleting":"recovery_required"};
    }else if(sql.includes("UPDATE sandbox_allocations SET image_digest=?")){
      if(this.allocation)this.allocation.image_digest=v[0];
    }else if(sql.includes("UPDATE sandbox_connections SET execution_key_check_status='verified'")){
      if(this.connectionStatus==="revoked")changes=0;
      else this.computer={...this.computer,execution_key_check_status:"verified"};
    }else if(sql.includes("UPDATE sandbox_computers SET state='running'")){
      this.computer={...this.computer,state:"running",active_operation_id:null};
    }else if(sql.includes("UPDATE sandbox_computers SET state=?,active_operation_id=NULL")){
      this.computer={...this.computer,state:v[0],active_operation_id:null};
    }else if(sql.includes("UPDATE sandbox_allocations SET status=?,updated_at=?")){
      if(this.allocation)this.allocation={...this.allocation,status:v[0]};
    }else if(sql.includes("UPDATE sandbox_executions SET status=?")){
      const row=this.executions.get(String(v[8]));if(row){row.status=v[0];row.exit_code=v[1];row.truncated=v[2];row.publication_id=v[3];row.workspace_state=v[4];row.result_ciphertext=v[5];row.result_iv=v[6];}
    }else if(sql.includes("INSERT INTO sandbox_executions")){
      const row={id:v[0],tenant_id:v[1],owner_id:v[2],computer_id:v[3],idempotency_key:v[4],payload_hash:v[5],status:"running",created_at:v[6],updated_at:v[7],request_ciphertext:v[8],request_iv:v[9],provider_execution_name:v[10],recovery_after:v[11],allocation_id:v[12],allocation_generation:v[13]};
      this.executions.set(String(v[0]),row);
    }else if(sql.includes("INSERT INTO sandbox_artifact_transfers")){
      const row={id:v[0],tenant_id:v[1],owner_id:v[2],computer_id:v[3],allocation_id:v[4],allocation_generation:v[5],direction:v[6],idempotency_key:v[7],payload_hash:v[8],status:"running",request_json:v[9],created_at:v[10],updated_at:v[11]};
      this.transfers.set(String(v[0]),row);
    }else if(sql.includes("UPDATE sandbox_executions SET status=?")){
      const row=this.executions.get(String(v[8]));if(row){row.status=v[0];row.exit_code=v[1];row.truncated=v[2];row.publication_id=v[3];row.workspace_state=v[4];row.result_ciphertext=v[5];row.result_iv=v[6];}
    }else if(sql.includes("UPDATE sandbox_computers SET state='recovery_required'")){
      this.computer={...this.computer,state:"recovery_required"};
    }else if(sql.includes("UPDATE sandbox_artifact_transfers SET status='failed'")){
      const row=this.transfers.get(String(v[2]));if(row){row.status="failed";row.error_code=v[0];row.updated_at=v[1];}
    }else if(sql.includes("UPDATE sandbox_artifact_transfers SET")){
      const assignments=sql.match(/SET (.*?) WHERE/)?.[1]?.split(",").map(part=>part.trim().split("=")[0])??[];
      const row=this.transfers.get(String(v[v.length-1]));if(row){assignments.forEach((name,index)=>{row[name!]=v[index];});}
    }
    return {success:true,meta:{changes}};
  }
  async batch(statements:Statement[]){if(this.failNextBatch){this.failNextBatch=false;throw new Error("simulated D1 unavailable");}const results=[];for(const statement of statements)results.push(await statement.run());return results;}
}

async function setup(input:{enabled?:boolean;state?:string;executionKey?:string;workspace?:boolean;workspaceHandler?:(body:Record<string,unknown>)=>Response|Promise<Response>}={}){
  const encrypted=await sealConnection(secret,"tenant-a","user-a","connection-a",JSON.stringify({apiKey:"control-secret",instanceKey:"instance-secret"}));
  const row:Record<string,unknown>={id:"computer-a",tenant_id:"tenant-a",owner_id:"user-a",space_id:input.workspace?"space-a":null,project_id:input.workspace?"project-a":null,branch:"main",template_id:"node",template_version:"v1",
    ownership:"customer_owned",filesystem_id:"filesystem-a",filesystem_mode:"snapshot_diff",provider_preference:"agent37",state:input.state??"configured",resources_json:JSON.stringify({cpu:2,memoryMiB:4096,diskGiB:10}),
    idle_timeout_seconds:900,allocation_generation:input.state==="running"?1:0,connection_id:"connection-a",active_operation_id:null,connection_provider:"agent37",connection_ownership:"customer_owned",
    connection_status:"configured_unverified",connection_region:"us",credential_ciphertext:encrypted.ciphertext,credential_iv:encrypted.iv,credential_check_status:"verified",control_plane_verified_at:new Date().toISOString(),
    execution_key_check_status:input.executionKey??(input.state==="running"?"verified":"not_checked"),template_digest:digest,template_constraints_json:JSON.stringify({provider:"agent37",region:"us",instanceType:"default",capabilities:["exec","files"],resources:[{cpu:2,memoryMiB:4096,minDiskGiB:2,maxDiskGiB:12}]}),
    template_capabilities_json:'["exec","files"]',template_status:"verified",template_valid_until:new Date(Date.now()+24*60*60_000).toISOString()};
  const db=new RuntimeDb(row);
  if(input.state==="running")db.allocation={id:"allocation-a",computer_id:"computer-a",connection_id:"connection-a",provider:"agent37",external_id:"ab12cd34ef",generation:1,status:"active",image_digest:digest};
  const workspaceOperations:string[]=[];
  const workspaceBinding=input.workspace?{fetch:async(request:Request)=>{
    if(new URL(request.url).pathname==="/internal/workspaces/erasure-check")return Response.json({erased:false});
    const body=await request.json() as {operation?:string;stageId?:string};
    if(body.operation)workspaceOperations.push(body.operation);
    if(input.workspaceHandler)return input.workspaceHandler(body as Record<string,unknown>);
    if(body.operation==="stage")return Response.json({stageId:body.stageId,status:"staged"});
    return Response.json({error_code:"unexpected_workspace_operation"},{status:500});
  }}:undefined;
  const token=await mintInternalToken(secret,"tenant-a"),env={PLATFORM_DB:db as unknown as D1Database,PLATFORM_SECRET:secret,AGENT37_RUNTIME_ENABLED:input.enabled===false?"false":"true",
    ...(workspaceBinding?{AGENTS_WORKER:workspaceBinding as unknown as Fetcher}:{})};
  const send=(path:string,method:string,body?:string,headers:Record<string,string>={})=>app.fetch(new Request(`https://sandbox.test${path}`,{method,headers:{"content-type":"application/json","x-naelao-tenant-id":"tenant-a","x-naelao-user-id":"user-a","x-naelao-role":"owner","x-naelao-internal-token":token,...headers},...(body===undefined?{}:{body})}),env as never);
  return{db,send,workspaceOperations};
}

describe("Agent37 runtime caller",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("fails closed unless rollout is enabled and provider billing was explicitly accepted",async()=>{
    const disabled=await setup({enabled:false});
    expect(await (await disabled.send("/providers","GET")).json()).toMatchObject({providers:expect.arrayContaining([expect.objectContaining({id:"agent37",status:"gated",reasonCode:"agent37_runtime_rollout_disabled"})])});
    expect((await disabled.send("/computers/computer-a/start","POST","{}",{"idempotency-key":"start-disabled"})).status).toBe(503);
    const admitted=await setup();
    expect(await (await admitted.send("/providers","GET")).json()).toMatchObject({providers:expect.arrayContaining([expect.objectContaining({id:"agent37",status:"customer_owned_connection_required",reasonCode:"customer_owned_connection_and_verified_template_required"})])});
    expect((await admitted.send("/computers/computer-a/start","POST","{}",{"idempotency-key":"start-no-consent"})).status).toBe(428);
  });

  it("journals an allocation, verifies both credential planes and deduplicates create",async()=>{
    const f=await setup(),requests:string[]=[];
    const fetcher=vi.fn(async(input:URL|RequestInfo,init?:RequestInit)=>{
      const url=String(input),method=init?.method??"GET";requests.push(`${method} ${url}`);
      if(url==="https://api.agent37.com/v1/instances"&&method==="POST")return Response.json({id:"ab12cd34ef",image_digest:digest},{status:201});
      if(url==="https://api.agent37.com/v1/instances/ab12cd34ef")return Response.json({id:"ab12cd34ef",status:"running",image_digest:digest});
      if(url==="https://ab12cd34ef.agent37.app/v1/files")return Response.json({path:"/home/node",entries:[],truncated:false});
      return Response.json({}, {status:404});
    }) as typeof fetch;
    vi.stubGlobal("fetch",fetcher);
    const headers={"idempotency-key":"start-a"},body=JSON.stringify({providerBillingConsent:true});
    const first=await f.send("/computers/computer-a/start","POST",body,headers);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({operation:{status:"complete",result:{state:"running",billingModel:"customer_owned_agent37_account"}}});
    const second=await f.send("/computers/computer-a/start","POST",body,headers);
    expect(second.status).toBe(200);
    expect(requests.filter(value=>value.startsWith("POST https://api.agent37.com/v1/instances"))).toHaveLength(1);
    expect(f.db.computer.state).toBe("running");
    expect(f.db.computer.execution_key_check_status).toBe("verified");
  });

  it.each([
    {action:"start",priorAllocationStatus:"sleeping",observedState:"running",targetState:"running"},
    {action:"sleep",priorAllocationStatus:"active",observedState:"sleeping",targetState:"sleeping"},
  ] as const)("reconciles an indeterminate $action through owner-confirmed provider inspection only",async({action,priorAllocationStatus,observedState,targetState})=>{
    const f=await setup({state:"running"}),operationId=`op-transition-${action}`;
    f.db.computer={...f.db.computer,state:"recovery_required",active_operation_id:operationId};
    f.db.allocation={...f.db.allocation!,status:priorAllocationStatus,operation_id:"op-original-create"};
    f.db.operations.set(`tenant-a:transition-${action}`,{id:operationId,tenant_id:"tenant-a",computer_id:"computer-a",operation:action,
      idempotency_key:`transition-${action}`,payload_hash:"hash",status:"indeterminate",generation:1,error_code:"agent37_transition_outcome_unknown"});
    const requests:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async(input:URL|RequestInfo,init?:RequestInit)=>{
      const method=init?.method??"GET";requests.push(`${method} ${String(input)}`);
      return Response.json({id:"ab12cd34ef",status:observedState,image_digest:digest});
    }) as typeof fetch);

    const response=await f.send(`/computers/computer-a/operations/${operationId}/reconcile`,"POST",JSON.stringify({confirm:true}));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({operation:{id:operationId,type:action,status:"complete",result:{state:targetState,actionReplayed:false}}});
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/^GET https:\/\/api\.agent37\.com\/v1\/instances\/ab12cd34ef$/);
    expect(f.db.computer).toMatchObject({state:targetState,active_operation_id:null});
    expect(f.db.allocation).toMatchObject({status:targetState==="running"?"active":"sleeping"});
    expect([...f.db.operations.values()].find(row=>row.id===operationId)).toMatchObject({status:"complete"});
  });

  it("keeps an indeterminate transition unresolved when provider state does not match",async()=>{
    const f=await setup({state:"running"}),operationId="op-transition-start";
    f.db.computer={...f.db.computer,state:"recovery_required",active_operation_id:operationId};
    f.db.allocation={...f.db.allocation!,status:"sleeping",operation_id:"op-original-create"};
    f.db.operations.set("tenant-a:transition-start",{id:operationId,tenant_id:"tenant-a",computer_id:"computer-a",operation:"start",
      idempotency_key:"transition-start",payload_hash:"hash",status:"indeterminate",generation:1,error_code:"agent37_transition_outcome_unknown"});
    const fetcher=vi.fn(async()=>Response.json({id:"ab12cd34ef",status:"sleeping",image_digest:digest}));
    vi.stubGlobal("fetch",fetcher as typeof fetch);

    const response=await f.send(`/computers/computer-a/operations/${operationId}/reconcile`,"POST",JSON.stringify({confirm:true}));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({operation:{id:operationId,status:"indeterminate",observedState:"sleeping",actionReplayed:false}});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.db.computer).toMatchObject({state:"recovery_required",active_operation_id:operationId});
    expect(f.db.allocation).toMatchObject({status:"sleeping"});
    expect([...f.db.operations.values()].find(row=>row.id===operationId)).toMatchObject({status:"indeterminate"});
  });

  it("requires owner role and explicit confirmation before inspecting a transition",async()=>{
    const f=await setup({state:"running"}),operationId="op-transition-owner";
    f.db.computer={...f.db.computer,state:"recovery_required",active_operation_id:operationId};
    f.db.allocation={...f.db.allocation!,status:"active",operation_id:"op-original-create"};
    f.db.operations.set("tenant-a:transition-owner",{id:operationId,tenant_id:"tenant-a",computer_id:"computer-a",operation:"sleep",
      idempotency_key:"transition-owner",payload_hash:"hash",status:"indeterminate",generation:1,error_code:"agent37_transition_outcome_unknown"});
    const fetcher=vi.fn(async()=>Response.json({id:"ab12cd34ef",status:"sleeping",image_digest:digest}));
    vi.stubGlobal("fetch",fetcher as typeof fetch);

    const inventory=await f.send("/computers","GET");
    expect(await inventory.json()).toMatchObject({computers:[{id:"computer-a",state:"recovery_required",activeOperationId:operationId,
      activeOperationType:"sleep",activeOperationStatus:"indeterminate"}]});

    const nonOwner=await f.send(`/computers/computer-a/operations/${operationId}/reconcile`,"POST",JSON.stringify({confirm:true}),{"x-naelao-role":"editor"});
    const unconfirmed=await f.send(`/computers/computer-a/operations/${operationId}/reconcile`,"POST",JSON.stringify({confirm:false}));

    expect(nonOwner.status).toBe(403);
    expect(unconfirmed.status).toBe(428);
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.db.computer).toMatchObject({state:"recovery_required",active_operation_id:operationId});
  });

  it("rejects transition reconciliation if allocation generation changes during inspection",async()=>{
    const f=await setup({state:"running"}),operationId="op-transition-sleep";
    f.db.computer={...f.db.computer,state:"recovery_required",active_operation_id:operationId};
    f.db.allocation={...f.db.allocation!,status:"active",operation_id:"op-original-create"};
    f.db.operations.set("tenant-a:transition-sleep",{id:operationId,tenant_id:"tenant-a",computer_id:"computer-a",operation:"sleep",
      idempotency_key:"transition-sleep",payload_hash:"hash",status:"indeterminate",generation:1,error_code:"agent37_transition_outcome_unknown"});
    vi.stubGlobal("fetch",vi.fn(async()=>{
      f.db.computer={...f.db.computer,allocation_generation:2};
      return Response.json({id:"ab12cd34ef",status:"sleeping",image_digest:digest});
    }) as typeof fetch);

    const response=await f.send(`/computers/computer-a/operations/${operationId}/reconcile`,"POST",JSON.stringify({confirm:true}));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({error_code:"transition_reconciliation_fence_changed"});
    expect(f.db.computer).toMatchObject({state:"recovery_required",active_operation_id:operationId,allocation_generation:2});
    expect([...f.db.operations.values()].find(row=>row.id===operationId)).toMatchObject({status:"indeterminate"});
  });

  it("does not dispatch a paid provider create when the durable D1 admission batch fails",async()=>{
    const f=await setup(),provider=vi.fn(async()=>Response.json({id:"must-not-exist",image_digest:digest},{status:201}));
    f.db.failNextBatch=true;
    vi.stubGlobal("fetch",provider as typeof fetch);

    const response=await f.send("/computers/computer-a/start","POST",JSON.stringify({providerBillingConsent:true}),{"idempotency-key":"start-d1-failure"});

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({error_code:"agent37_operation_journal_failed"});
    expect(provider).not.toHaveBeenCalled();
    expect(f.db.allocation).toBeNull();
    expect(f.db.computer.state).toBe("configured");
  });

  it("queues provider cleanup when the customer revokes the connection during allocation",async()=>{
    const f=await setup();
    const fetcher=vi.fn(async(input:URL|RequestInfo,init?:RequestInit)=>{
      const url=String(input),method=init?.method??"GET";
      if(url==="https://api.agent37.com/v1/instances"&&method==="POST"){
        f.db.connectionStatus="revoked";
        return Response.json({id:"ab12cd34ef",image_digest:digest},{status:201});
      }
      return Response.json({}, {status:404});
    }) as typeof fetch;
    vi.stubGlobal("fetch",fetcher);

    const response=await f.send("/computers/computer-a/start","POST",JSON.stringify({providerBillingConsent:true}),{"idempotency-key":"start-revoked"});

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({operation:{status:"failed",errorCode:"agent37_connection_revoked_during_create",cleanup:"queued"}});
    expect(f.db.deletions.size).toBe(1);
    expect([...f.db.deletions.values()][0]).toMatchObject({external_id:"ab12cd34ef",status:"pending"});
    expect(f.db.computer.state).toBe("deleting");
    expect(f.db.operations.get("tenant-a:start-revoked")?.status).toBe("failed");
  });

  it("encrypts execution receipts and reuses Agent37's stable execution name after a timeout",async()=>{
    const f=await setup({state:"running"}),names:string[]=[];let execCalls=0;
    const fetcher=vi.fn(async(input:URL|RequestInfo,init?:RequestInit)=>{
      const url=String(input);
      if(url.endsWith("/exec")){execCalls++;names.push(String(JSON.parse(String(init?.body)).name));if(execCalls===1)return Response.json({error:"try_again"},{status:504});return Response.json({exit_code:0,stdout:"done",stderr:"",truncated:false});}
      return Response.json({}, {status:404});
    }) as typeof fetch;
    vi.stubGlobal("fetch",fetcher);
    const body=JSON.stringify({command:"printf",args:["%s","done"],timeoutMs:5000});
    const first=await f.send("/computers/computer-a/executions","POST",body,{"idempotency-key":"exec-a"});
    const result=await first.json() as {execution:{id:string;status:string}};
    expect(first.status).toBe(202);expect(result.execution.status).toBe("indeterminate");
    const row=f.db.executions.get(result.execution.id)!;
    expect(row.result_ciphertext).toEqual(expect.any(String));
    expect(row.request_ciphertext).toEqual(expect.any(String));
    const reconciled=await f.send(`/computers/computer-a/executions/${result.execution.id}/reconcile`,"POST");
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({execution:{id:result.execution.id,status:"succeeded",stdout:"done"}});
    expect(execCalls).toBe(2);expect(names[0]).toBe(names[1]);
  });

  it("reconciles a lost artifact stage response through its durable stage id and source hash",async()=>{
    const f=await setup({state:"running",workspace:true}),bytes=new TextEncoder().encode("data");
    const hash=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(value=>value.toString(16).padStart(2,"0")).join("");
    f.db.transfers.set("xfer-a",{id:"xfer-a",tenant_id:"tenant-a",owner_id:"user-a",computer_id:"computer-a",allocation_id:"allocation-a",allocation_generation:1,
      direction:"stage_output",idempotency_key:"artifact-a",status:"indeterminate",workspace_session_id:"ws_12345678-1234-1234-1234-123456789012",workspace_fence:2,
      base_revision:9,stage_id:"agent37-xfer-a",request_json:JSON.stringify({paths:["artifact.txt"],publish:false}),
      receipt_json:JSON.stringify({direction:"stage_output",sourceRevision:9,allocationId:"allocation-a",allocationGeneration:1,imageDigest:digest,stageId:"agent37-xfer-a",
        files:[{path:"artifact.txt",sha256:hash,size:4,contentType:"text/plain; charset=utf-8",expectedHash:null,executable:false}]}),error_code:"artifact_stage_response_lost"});
    vi.stubGlobal("fetch",vi.fn(async(input:URL|RequestInfo,init?:RequestInit)=>{
      const url=new URL(String(input)),method=init?.method??"GET";
      if(url.hostname==="ab12cd34ef.agent37.app"&&url.pathname==="/v1/files"&&method==="GET"){
        const path=url.searchParams.get("path");
        return Response.json({path,entries:path==="/home/node/workspace"?[{name:"artifact.txt",path:"/home/node/workspace/artifact.txt",type:"file",size:4,modified:1}]:[],truncated:false});
      }
      if(url.hostname==="ab12cd34ef.agent37.app"&&url.pathname==="/v1/files/content"&&method==="GET")return new Response(bytes,{headers:{"content-length":"4"}});
      return Response.json({error:"unexpected_provider_request"},{status:404});
    }) as typeof fetch);
    const before=f.db.transfers.get("xfer-a")!.status;
    expect(before).toBe("indeterminate");
    const response=await f.send("/computers/computer-a/artifact-transfers/xfer-a/reconcile","POST");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({transfer:{id:"xfer-a",status:"staged",receipt:{stageId:"agent37-xfer-a"}}});
    expect(f.db.transfers.get("xfer-a")!.status).toBe("staged");
    expect(f.workspaceOperations).toEqual(["stage"]);
  });

  it("stops a selected-file import when the owner revokes Agent37 during transfer",async()=>{
    const bytes=new TextEncoder().encode("selected input"),hash=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(value=>value.toString(16).padStart(2,"0")).join("");
    const f=await setup({state:"running",workspace:true,workspaceHandler:async(body)=>{
      if(body.operation==="open")return Response.json({session:{id:"ws_12345678-1234-1234-1234-123456789012",fence:2}});
      if(body.operation==="snapshot")return Response.json({session:{baseRevision:9,allocationGeneration:1},entries:[{path:"input.txt",sha256:hash,size:bytes.byteLength,executable:false,contentType:"text/plain; charset=utf-8"}]});
      if(body.operation==="content")return new Response(bytes,{headers:{"content-length":String(bytes.byteLength),"x-content-sha256":hash,"x-executable":"false","content-type":"text/plain; charset=utf-8"}});
      return Response.json({status:"closed"});
    }});
    const requests:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async(input:URL|RequestInfo,init?:RequestInit)=>{
      const url=new URL(String(input)),method=init?.method??"GET";requests.push(`${method} ${url.href}`);
      if(url.hostname==="sandbox.agent37.app"&&url.pathname.endsWith("/exec")){
        f.db.connectionStatus="revoked";
        return Response.json({exit_code:0,stdout:"",stderr:"",truncated:false});
      }
      return Response.json({error:"unexpected_provider_request"},{status:404});
    }) as typeof fetch);

    const response=await f.send("/computers/computer-a/artifacts","POST",JSON.stringify({direction:"import",paths:["input.txt"]}),{"idempotency-key":"import-revoke"});

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({error_code:"agent37_customer_connection_required"});
    expect(requests.some(value=>value.startsWith("PUT "))).toBe(false);
    expect([...f.db.transfers.values()][0]).toMatchObject({status:"failed",error_code:"agent37_customer_connection_required"});
  });
});
