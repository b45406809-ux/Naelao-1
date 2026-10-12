import { describe, expect, it } from "vitest";
import { SpaceDO } from "./SpaceDO.js";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";

describe("durable artifact linter intervention",()=>{
  it("preserves two repairs across restart and requires the matching human approval to resume",async()=>{
    const storage=createDOStorage();const state={storage};let instance=new SpaceDO(state as never,{} as never);
    await instance.fetch(new Request("http://space/artifact-validation/diagnostic?space_id=space&id=missing"));
    storage.sql.exec("INSERT INTO projects(id,space_id,name) VALUES ('project','space','Test')");
    storage.sql.exec("INSERT INTO tasks(id,space_id,project_id,title,status) VALUES ('task','space','project','Validate','in_progress')");
    const linters=[{id:"invoice",path:"/workspace/invoice.json",fields:{amount:{type:"number",required:true,min:0}}}];
    storage.sql.exec("UPDATE projects SET artifact_linter_policy=? WHERE id='project'",JSON.stringify(linters));
    const call=(action:string,body:unknown)=>instance.fetch(new Request(`http://space/artifact-validation/${action}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}));
    const check=(content:string)=>call("check",{space_id:"space",project_id:"project",path:"/workspace/invoice.json",content,work_key:"task",task_id:"task"});
    let diagnosticId="";
    for(let i=0;i<3;i++){
      const result=await(await check('{"amount":"private value"}')).json() as {status:string;diagnosticId:string};diagnosticId=result.diagnosticId;
      expect(result.status).toBe(i<2?"REPAIR_REQUIRED":"REQUIRES_HUMAN_INTERVENTION");
      if(i===1) instance=new SpaceDO(state as never,{} as never);
    }
    expect(storage.sql.exec("SELECT status,intervention_status FROM tasks WHERE id='task'").toArray()[0]).toMatchObject({status:"blocked",intervention_status:"REQUIRES_HUMAN_INTERVENTION"});
    expect(await(await check('{"amount":10}')).json()).toMatchObject({allowed:false,status:"REQUIRES_HUMAN_INTERVENTION"});
    const snapshot=await instance.fetch(new Request(`http://space/artifact-validation/diagnostic?space_id=space&id=${diagnosticId}`));
    expect(await snapshot.text()).not.toContain("private value");
    await call("approval",{id:diagnosticId,space_id:"space",approval_id:"approval"});
    expect((await call("resume",{id:diagnosticId,space_id:"space",approval_id:"different"})).status).toBe(409);
    expect((await call("resume",{id:diagnosticId,space_id:"space",approval_id:"approval"})).status).toBe(200);
    expect(await(await check('{"amount":10}')).json()).toMatchObject({allowed:true,status:"PASSED"});
    expect((await call("check",{space_id:"other",project_id:"project",path:"/workspace/invoice.json",content:"{}",work_key:"task"})).status).toBe(404);
  });
});
