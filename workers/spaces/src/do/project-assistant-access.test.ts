import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

describe("Project assistant access", () => {
  it("limits implicit Space owner access to the Project's owning Space and applies explicit assistant clamps", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "assistant-access-test" } as never);
    await space.fetch(new Request("http://space/")); // apply the SpaceDO migrations first
    storage.sql.exec("INSERT INTO spaces(id,name,space_type,depth) VALUES('space-a','A','business',0),('space-b','B','business',0)");
    storage.sql.exec("INSERT INTO projects(id,space_id,name) VALUES('project-b','space-b','B private project')");
    storage.sql.exec("INSERT INTO space_members(space_id,user_id,role) VALUES('space-a','owner-a','owner'),('space-b','owner-b','owner')");
    storage.sql.exec("INSERT INTO project_members(project_id,user_id,role,assistant_mode,added_at) VALUES('project-b','member-a','editor','read_only',datetime('now'))");

    const access = async (userId: string) => {
      const response = await space.fetch(new Request(`http://space/projects/project-b/assistant-access?user_id=${userId}`));
      expect(response.status).toBe(200);
      return (await response.json() as { effective_role: string | null }).effective_role;
    };
    expect(await access("owner-a")).toBeNull();
    expect(await access("owner-b")).toBe("owner");
    expect(await access("member-a")).toBe("viewer");
  });
});
