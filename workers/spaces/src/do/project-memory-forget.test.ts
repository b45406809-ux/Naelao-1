import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

describe("project memory fact deletion", () => {
  it("keeps fact, Fabric, and Wiki recall inside the requested Project", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "project-memory-scope-test" } as never);
    await space.fetch(new Request("http://space/"));
    storage.sql.exec("INSERT INTO spaces(id,name,space_type,depth) VALUES('space','Test','business',0)");
    storage.sql.exec("INSERT INTO projects(id,space_id,name) VALUES('project-a','space','A'),('project-b','space','B')");
    storage.sql.exec(`INSERT INTO project_facts(id,project_id,entity,relation,attribute,required_role_rank,created_at,updated_at)
      VALUES('fact-a','project-a','launch','owner','team',0,'2026-11-18','2026-11-18'),
            ('fact-b','project-b','launch','owner','private-team',0,'2026-11-18','2026-11-18')`);
    storage.sql.exec(`INSERT INTO project_fabric(id,project_id,session_id,summary,key_insights,required_role_rank,created_at)
      VALUES('fabric-a','project-a','session-a','launch budget approved','[]',0,'2026-11-18'),
            ('fabric-b','project-b','session-b','launch budget private plan','[]',0,'2026-11-18')`);
    storage.sql.exec(`INSERT INTO project_wiki(project_id,concept,definition,relationships,required_role_rank,updated_at)
      VALUES('project-a','launch','approved launch policy','[]',0,'2026-11-18'),
            ('project-b','launch','private launch plan','[]',0,'2026-11-18')`);

    const facts = await space.fetch(new Request("http://space/projects/project-a/memory/facts?q=launch%20owner&role_rank=3"));
    const fabric = await space.fetch(new Request("http://space/projects/project-a/memory/fabric?q=launch%20budget&role_rank=3"));
    const wiki = await space.fetch(new Request("http://space/projects/project-a/memory/wiki?q=launch&role_rank=3"));

    expect((await facts.json() as { data: Array<{ id: string }> }).data.map((row) => row.id)).toEqual(["fact-a"]);
    expect((await fabric.json() as { data: Array<{ id: string }> }).data.map((row) => row.id)).toEqual(["fabric-a"]);
    expect((await wiki.json() as { data: Array<{ project_id: string; concept: string }> }).data.map((row) => `${row.project_id}:${row.concept}`)).toEqual(["project-a:launch"]);
    expect(storage.sql.exec("SELECT id FROM project_facts WHERE id='fact-b'").toArray()).toEqual([{ id: "fact-b" }]);
  });

  it("only deletes facts at or below the caller's current effective role rank", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "project-memory-forget-test" } as never);
    await space.fetch(new Request("http://space/"));
    storage.sql.exec("INSERT INTO spaces(id,name,space_type,depth) VALUES('space','Test','business',0)");
    storage.sql.exec("INSERT INTO projects(id,space_id,name) VALUES('project','space','Test')");
    storage.sql.exec("INSERT INTO project_facts(id,project_id,entity,relation,attribute,required_role_rank,created_at,updated_at) VALUES('public','project','a','b','c',0,1,1),('editor','project','d','e','f',1,1,1),('owner','project','g','h','i',3,1,1)");

    const deleteFact = (id: string, roleRank: number) => space.fetch(new Request(
      `http://space/projects/project/memory/facts/${id}?role_rank=${roleRank}`,
      { method: "DELETE" },
    ));
    expect((await deleteFact("owner", 1)).status).toBe(200);
    expect((await deleteFact("editor", 1)).status).toBe(200);
    expect(storage.sql.exec("SELECT id FROM project_facts WHERE project_id='project' ORDER BY id").toArray()).toEqual([{ id: "owner" }, { id: "public" }]);
    expect((await deleteFact("public", 0)).status).toBe(200);
    expect(storage.sql.exec("SELECT id FROM project_facts WHERE project_id='project'").toArray()).toEqual([{ id: "owner" }]);
  });

  it("returns the authoritative fact update timestamp for memory provenance", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "project-memory-provenance-test" } as never);
    await space.fetch(new Request("http://space/"));
    storage.sql.exec("INSERT INTO spaces(id,name,space_type,depth) VALUES('space','Test','business',0)");
    storage.sql.exec("INSERT INTO projects(id,space_id,name) VALUES('project','space','Test')");
    storage.sql.exec("INSERT INTO project_facts(id,project_id,entity,relation,attribute,required_role_rank,created_at,updated_at) VALUES('fact','project','launch','owner','team',0,'2026-11-17T00:00:00.000Z','2026-11-18T00:00:00.000Z')");

    const response = await space.fetch(new Request("http://space/projects/project/memory/facts?q=launch%20team&role_rank=1"));
    expect(await response.json()).toMatchObject({ data: [{ id: "fact", updated_at: "2026-11-18T00:00:00.000Z" }] });
  });

  it("lists only memory facts permitted by the current role rank", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "project-memory-list-test" } as never);
    await space.fetch(new Request("http://space/"));
    storage.sql.exec("INSERT INTO spaces(id,name,space_type,depth) VALUES('space','Test','business',0)");
    storage.sql.exec("INSERT INTO projects(id,space_id,name) VALUES('project','space','Test')");
    storage.sql.exec("INSERT INTO project_facts(id,project_id,entity,relation,attribute,required_role_rank,created_at,updated_at) VALUES('public','project','a','b','c',0,1,1),('editor','project','d','e','f',1,1,2),('owner','project','g','h','i',3,1,3)");

    const response = await space.fetch(new Request("http://space/projects/project/memory/facts?list=true&role_rank=1&limit=50"));
    const body = await response.json() as { data: Array<{ id: string }> };
    expect(body.data.map(item => item.id)).toEqual(["editor", "public"]);
    const unrequestedList = await space.fetch(new Request("http://space/projects/project/memory/facts?role_rank=3"));
    expect(await unrequestedList.json()).toEqual({ data: [] });
  });
});
