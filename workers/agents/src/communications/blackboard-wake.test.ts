import { describe, expect, it, vi } from "vitest";
import { sweepBlackboardWakes } from "./blackboard-wake.js";
import type { AgentsEnv } from "../index.js";
const { access } = vi.hoisted(() => ({ access: vi.fn(async () => true) }));
vi.mock("./core.js", () => ({ scopeAccess: access }));
function fixture() {
  const updates: unknown[][] = [];
  const row={tenant_id:"t",space_id:"s",project_id:"p",event_id:"request:pending"};
  const db={prepare:(sql:string)=>({bind:(...args:unknown[])=>({run:async()=>{if(sql.startsWith("UPDATE space_blackboard_wakes SET status=?,")) updates.push(args);return {meta:{changes:1}};},all:async()=>({results:[row]}),first:async()=>({authorized_user_id:"owner"})})})};
  return { env:{ PLATFORM_DB:db } as unknown as AgentsEnv, updates };
}
describe("blackboard project wakes",()=>{
  it("checks current project authority and dispatches an untrusted event in project scope",async()=>{
    access.mockResolvedValueOnce(true); const f=fixture(); const wake=vi.fn(async(_input:unknown)=>new Response("ok"));
    await sweepBlackboardWakes(f.env,wake,100);
    expect(wake).toHaveBeenCalledOnce();
    expect(wake.mock.calls[0]![0]).toMatchObject({projectId:"p",userId:"owner"});
    expect(f.updates[0]![0]).toBe("completed");
  });
  it("holds on revoked authority and retries a busy assistant",async()=>{
    const denied=fixture(); access.mockResolvedValueOnce(false); const noWake=vi.fn();
    await sweepBlackboardWakes(denied.env,noWake,100);
    expect(noWake).not.toHaveBeenCalled(); expect(denied.updates[0]![0]).toBe("held");
    const busy=fixture(); access.mockResolvedValueOnce(true);
    await sweepBlackboardWakes(busy.env,async()=>Response.json({reason:"assistant_busy"},{status:409}),100);
    expect(busy.updates[0]![0]).toBe("pending");
  });
});
