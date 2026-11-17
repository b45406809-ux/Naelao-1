import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

describe("project memory fact deletion", () => {
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
});
