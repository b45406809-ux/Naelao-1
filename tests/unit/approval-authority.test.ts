import { afterEach, describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "../../workers/agents/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

describe("human approval authority with actual SQLite membership",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("denies agents, viewers, editors and revoked owners before touching HITL state",async()=>{
    const db=createFakeD1(["CREATE TABLE orgs(id TEXT,status TEXT);INSERT INTO orgs VALUES ('tenant','active');CREATE TABLE spaces(id TEXT,tenant_id TEXT,status TEXT);INSERT INTO spaces VALUES ('space','tenant','active');CREATE TABLE org_members(org_id TEXT,user_id TEXT,role TEXT);INSERT INTO org_members VALUES ('tenant','user','owner');"]);
    const calls=vi.fn(async()=>Response.json({status:"approved"}));
    const env={PLATFORM_SECRET:"secret",PLATFORM_DB:db as unknown as D1Database,HITL_APPROVAL_DO:{idFromName:(name:string)=>name,get:()=>({fetch:calls})}};
    const internal=await mintInternalToken("secret","tenant");
    const request=(role:string)=>worker.fetch!(new Request("https://agents/spaces/space/sessions/session/approvals/approval/approve",{method:"PUT",headers:{"x-naelao-tenant-id":"tenant","x-naelao-user-id":"user","x-naelao-role":role,"x-naelao-internal-token":internal}}),env as never,{waitUntil(){},passThroughOnException(){}} as never);
    for(const role of ["agent","viewer","editor"]) expect((await request(role)).status).toBe(403);
    expect(calls).not.toHaveBeenCalled();
    expect((await request("owner")).status).toBe(200);
    db.db.exec("UPDATE orgs SET status='suspended'");calls.mockClear();
    expect((await request("owner")).status).toBe(403);expect(calls).not.toHaveBeenCalled();
    db.db.exec("UPDATE orgs SET status='active'");
    db.db.exec("DELETE FROM org_members");calls.mockClear();
    expect((await request("owner")).status).toBe(403);expect(calls).not.toHaveBeenCalled();
    db.db.close();
  });
});
