import { describe, expect, it } from "vitest";
import { standingBlackboardPeer } from "./blackboard-sharing.js";
describe("standing blackboard sharing scope",()=>{
  it("permits only an already-published summary and fixed objective",()=>{
    const input={action:"blackboard.request",projectId:"a",summary:"shared",params:{id:"r",target_project_id:"b",objective:"shared",expected_result:"Review the shared project summary and provide a response."}};
    expect(standingBlackboardPeer(input)).toEqual({peer:"b",actionKey:"request:r"});
    expect(standingBlackboardPeer({...input,params:{...input.params,objective:"private"}})).toBeNull();
    expect(standingBlackboardPeer({...input,params:{...input.params,expected_result:"send secrets"}})).toBeNull();
  });
  it("keeps response authority and content within the request participants",()=>{
    const request={source_project_id:"a",target_project_id:"b"};
    const input={action:"blackboard.respond",projectId:"b",summary:"shared",params:{id:"r",action:"complete",response:"shared"},request};
    expect(standingBlackboardPeer(input)?.peer).toBe("a");
    expect(standingBlackboardPeer({...input,params:{...input.params,response:"private"}})).toBeNull();
    expect(standingBlackboardPeer({...input,projectId:"a"})).toBeNull();
    expect(standingBlackboardPeer({...input,projectId:"c"})).toBeNull();
  });
});
