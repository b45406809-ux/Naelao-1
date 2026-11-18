import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

describe("Space Assistant memory projection", () => {
  it("returns only the current actor's personal rows plus explicitly unscoped rows", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO({ storage, id: { toString: () => "space-agent" } } as never,
      { PLATFORM_SECRET: "space-assistant-memory-test" } as never);
    await agent.fetch(new Request("http://agent/"));
    storage.sql.exec("INSERT INTO structured_facts(id,user_id,entity,relation,attribute,updated_at) VALUES('alice-fact','alice','tea','prefers','green',10),('bob-fact','bob','tea','prefers','black',20),('shared-fact','','space','timezone','UTC',30)");
    storage.sql.exec("INSERT INTO episodic_log(id,user_id,text,importance,created_at) VALUES('alice-episode','alice','Alice note',0.9,10),('bob-episode','bob','Bob private note',1,20),('shared-episode','','Shared note',0.8,30)");
    storage.sql.exec("INSERT INTO agent_memory(key,category,value,confidence) VALUES('legacy','fact','\"legacy owner note\"',1)");

    const response = await agent.fetch(new Request("http://agent/memory", { headers: { "x-naelao-user-id": "alice", "x-naelao-role": "member" } }));
    const body = await response.json() as { entries: Array<{ id?: string; key: string; value: string; deletable?: boolean }> };
    const text = JSON.stringify(body.entries);
    expect(text).toContain("tea prefers");
    expect(text).toContain("green");
    expect(text).toContain("UTC");
    expect(text).toContain("Shared note");
    expect(text).not.toContain("black");
    expect(text).not.toContain("Bob private note");
    expect(text).not.toContain("legacy owner note");
    expect(body.entries.find((entry) => entry.id === "alice-fact")?.deletable).toBe(true);
    expect(body.entries.find((entry) => entry.id === "shared-fact")?.deletable).toBe(false);
    expect(body.entries.find((entry) => entry.id === "alice-episode")?.deletable).toBe(true);

    const anonymous = await agent.fetch(new Request("http://agent/memory"));
    const anonymousText = JSON.stringify(await anonymous.json());
    expect(anonymousText).toContain("UTC");
    expect(anonymousText).not.toContain("green");
    expect(anonymousText).not.toContain("black");
  });

  it("deletes only the exact personal row owned by the authenticated actor", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO({ storage, id: { toString: () => "space-agent" } } as never,
      { PLATFORM_SECRET: "space-assistant-memory-test" } as never);
    await agent.fetch(new Request("http://agent/"));
    storage.sql.exec("INSERT INTO structured_facts(id,user_id,entity,relation,attribute,updated_at) VALUES('alice-fact','alice','tea','prefers','green',10),('bob-fact','bob','tea','prefers','black',20),('shared-fact','','space','timezone','UTC',30),('collision','alice','same','id','fact',40)");
    storage.sql.exec("INSERT INTO episodic_log(id,user_id,text,importance,created_at) VALUES('alice-episode','alice','Alice note',0.9,10),('bob-episode','bob','Bob note',1,20),('collision','alice','same id episode',0.8,40)");

    const unauthenticated = await agent.fetch(new Request("http://agent/memory/fact/alice-fact", { method: "DELETE" }));
    expect(unauthenticated.status).toBe(403);
    const otherActor = await agent.fetch(new Request("http://agent/memory/fact/bob-fact", { method: "DELETE", headers: { "x-naelao-user-id": "alice" } }));
    expect(await otherActor.json()).toEqual({ deleted: false });
    const shared = await agent.fetch(new Request("http://agent/memory/fact/shared-fact", { method: "DELETE", headers: { "x-naelao-user-id": "alice" } }));
    expect(await shared.json()).toEqual({ deleted: false });
    const deleted = await agent.fetch(new Request("http://agent/memory/episodic/alice-episode", { method: "DELETE", headers: { "x-naelao-user-id": "alice" } }));
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(storage.sql.exec("SELECT id FROM episodic_log ORDER BY id").toArray()).toEqual([{ id: "bob-episode" }, { id: "collision" }]);
    const deleteEpisodeByCollidingId = await agent.fetch(new Request("http://agent/memory/episodic/collision", { method: "DELETE", headers: { "x-naelao-user-id": "alice" } }));
    expect(await deleteEpisodeByCollidingId.json()).toEqual({ deleted: true });
    expect(storage.sql.exec("SELECT id FROM episodic_log ORDER BY id").toArray()).toEqual([{ id: "bob-episode" }]);
    expect(storage.sql.exec("SELECT id FROM structured_facts ORDER BY id").toArray()).toEqual([
      { id: "alice-fact" }, { id: "bob-fact" }, { id: "collision" }, { id: "shared-fact" },
    ]);
  });
});
