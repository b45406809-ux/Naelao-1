import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SpaceDO } from "./SpaceDO.js";

describe("project to subspace migration preflight", () => {
  it("supports a project linked to multiple departments while rejecting departments from another root", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "test" } as never);
    await space.fetch(new Request("https://space/projects/project-a/subspace-migration-preflight"));
    storage.sql.exec("INSERT INTO spaces(id,parent_id,name,space_type,tenancy_mode,depth,status,settings,created_at) VALUES('root',NULL,'Company','launchpad','team',0,'active','{}',?),('other-root',NULL,'Other Company','launchpad','team',0,'active','{}',?)", new Date().toISOString(), new Date().toISOString());
    storage.sql.exec("INSERT INTO spaces(id,parent_id,name,space_type,tenancy_mode,depth,status,settings,created_at) VALUES('dept-a','root','Sales','launchpad','team',1,'active','{}',?),( 'dept-b','root','Research','launchpad','team',1,'active','{}',?),( 'other-dept','other-root','Other','launchpad','team',1,'active','{}',?)", new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    storage.sql.exec("INSERT INTO projects(id,space_id,name) VALUES('project-a','root','Forecast')");

    const first = await space.fetch(new Request("https://space/projects/project-a/sub-spaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subspace_id: "dept-a", actor_id: "owner" }) }));
    const second = await space.fetch(new Request("https://space/projects/project-a/sub-spaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subspace_id: "dept-b", actor_id: "owner" }) }));
    const foreign = await space.fetch(new Request("https://space/projects/project-a/sub-spaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subspace_id: "other-dept" }) }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(foreign.status).toBe(400);

    const listed = await space.fetch(new Request("https://space/projects/project-a/sub-spaces"));
    expect(await listed.json()).toMatchObject({ count: 2, data: [{ id: "dept-a", is_primary: 1 }, { id: "dept-b", is_primary: 0 }] });
    const inSecondDepartment = await space.fetch(new Request("https://space/projects?space_id=root&subspace_id=dept-b"));
    expect(await inSecondDepartment.json()).toMatchObject({ count: 1, data: [{ id: "project-a", subspace_id: "dept-b" }] });
  });

  it("reports a read-only inventory for an in-place logical subspace graduation", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO(
      { storage } as never,
      { PLATFORM_SECRET: "preflight-test-secret" } as never
    );
    await space.fetch(
      new Request(
        "https://space/projects/project-a/subspace-migration-preflight"
      )
    );
    storage.sql.exec(
      "INSERT INTO spaces(id,parent_id,name,space_type,tenancy_mode,depth,status,settings,created_at) VALUES(?,NULL,?,'launchpad','team',0,'active','{}',?)",
      "root",
      "Company",
      new Date().toISOString()
    );
    storage.sql.exec(
      "INSERT INTO projects(id,space_id,name) VALUES(?,?,?)",
      "project-a",
      "root",
      "Retention"
    );
    storage.sql.exec(
      "INSERT INTO threads(id,space_id,project_id,title) VALUES(?,?,?,?)",
      "thread-a",
      "root",
      "project-a",
      "Inbox"
    );
    storage.sql.exec(
      "INSERT INTO tasks(id,space_id,project_id,title) VALUES(?,?,?,?)",
      "task-a",
      "root",
      "project-a",
      "Review cohort"
    );
    storage.sql.exec(
      "INSERT INTO workspace_files(project_id,path,content,content_hash,size_bytes,updated_at) VALUES(?,?,?,?,?,?)",
      "project-a",
      "README.md",
      "content",
      "hash",
      7,
      new Date().toISOString()
    );

    const response = await space.fetch(
      new Request(
        "https://space/projects/project-a/subspace-migration-preflight"
      )
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      project_id: "project-a",
      runtime_space_id: "root",
      strategy: "in_place_logical_reparent",
      phase: "ready",
      can_graduate: true,
      runtime_identity_preserved: true,
      inventory: {
        project_scoped_rows: {
          threads: 1,
          tasks: 1,
          workspace_files: 1,
        },
        inaccessible_tables: [],
      },
      blockers: [],
    });
    expect(
      storage.sql
        .exec<{ space_id: string }>(
          "SELECT space_id FROM projects WHERE id='project-a'"
        )
        .toArray()
    ).toEqual([{ space_id: "root" }]);
  });

  it("returns not found without changing state for unknown projects", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO(
      { storage } as never,
      { PLATFORM_SECRET: "preflight-test-secret" } as never
    );
    const response = await space.fetch(
      new Request("https://space/projects/missing/subspace-migration-preflight")
    );
    expect(response.status).toBe(404);
    expect(
      storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM projects")
        .toArray()
    ).toEqual([{ count: 0 }]);
  });

  it("graduates in place and can return the project without rekeying its runtime data", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO(
      { storage } as never,
      { PLATFORM_SECRET: "preflight-test-secret" } as never
    );
    await space.fetch(
      new Request(
        "https://space/projects/project-a/subspace-migration-preflight"
      )
    );
    storage.sql.exec(
      "INSERT INTO spaces(id,parent_id,name,space_type,tenancy_mode,depth,status,settings,created_at) VALUES(?,NULL,?,'launchpad','team',0,'active','{}',?)",
      "root",
      "Company",
      new Date().toISOString()
    );
    storage.sql.exec(
      "INSERT INTO space_assistants(space_id,assistant_actor_id,parent_assistant_actor_id,hierarchy_role) VALUES(?,?,NULL,'DIRECTOR')",
      "root",
      "assistant:space:root"
    );
    storage.sql.exec(
      "INSERT INTO space_members(space_id,user_id,role) VALUES('root','owner','owner')"
    );
    storage.sql.exec(
      "INSERT INTO projects(id,space_id,name,created_by) VALUES(?,?,?,?)",
      "project-a",
      "root",
      "Retention",
      "owner"
    );
    storage.sql.exec(
      "INSERT INTO project_members(project_id,user_id,role) VALUES('project-a','owner','owner')"
    );
    storage.sql.exec(
      "INSERT INTO project_members(project_id,user_id,role) VALUES('project-a','editor','editor')"
    );
    storage.sql.exec(
      "INSERT INTO project_members(project_id,user_id,role) VALUES('project-a','viewer','viewer')"
    );
    storage.sql.exec(
      "INSERT INTO threads(id,space_id,project_id,title) VALUES('thread-a','root','project-a','Inbox')"
    );
    storage.sql.exec(
      "INSERT INTO tasks(id,space_id,project_id,title) VALUES('task-a','root','project-a','Review cohort')"
    );
    storage.sql.exec(
      "INSERT INTO workspace_files(project_id,path,content,content_hash,size_bytes,updated_at) VALUES('project-a','README.md','content','hash',7,?)",
      new Date().toISOString()
    );

    const graduate = await space.fetch(
      new Request("https://space/projects/project-a/graduate-to-subspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor_id: "owner", tenant_id: "tenant" }),
      })
    );
    expect(graduate.status).toBe(201);
    const result = (await graduate.json()) as {
      subspace_id: string;
      runtime_space_id: string;
      runtime_identity_preserved: boolean;
    };
    expect(result).toMatchObject({
      runtime_space_id: "root",
      runtime_identity_preserved: true,
    });
    expect(result.subspace_id).toBeTruthy();
    expect(
      storage.sql
        .exec<{ space_id: string; subspace_id: string }>(
          "SELECT space_id,subspace_id FROM projects WHERE id='project-a'"
        )
        .toArray()
    ).toEqual([{ space_id: "root", subspace_id: result.subspace_id }]);
    expect(
      storage.sql
        .exec<{ role: string }>(
          "SELECT role FROM space_members WHERE space_id=? AND user_id='editor'",
          result.subspace_id
        )
        .toArray()
    ).toEqual([{ role: "member" }]);
    expect(
      storage.sql
        .exec<{ role: string }>(
          "SELECT role FROM space_members WHERE space_id=? AND user_id='viewer'",
          result.subspace_id
        )
        .toArray()
    ).toEqual([{ role: "viewer" }]);
    expect(
      storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM threads WHERE project_id='project-a'"
        )
        .toArray()
    ).toEqual([{ count: 1 }]);
    expect(
      storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM tasks WHERE project_id='project-a'"
        )
        .toArray()
    ).toEqual([{ count: 1 }]);

    const childList = await space.fetch(
      new Request(
        `https://space/projects?space_id=root&subspace_id=${encodeURIComponent(result.subspace_id)}`
      )
    );
    expect(await childList.json()).toMatchObject({
      count: 1,
      data: [{ id: "project-a", subspace_id: result.subspace_id }],
    });
    const rootList = await space.fetch(
      new Request("https://space/projects?space_id=root")
    );
    expect(await rootList.json()).toMatchObject({ count: 0, data: [] });

    const viewerAccess = await space.fetch(
      new Request(
        `https://space/hierarchy-authorize?user_id=viewer&target_space_id=${encodeURIComponent(result.subspace_id)}&action=read`
      )
    );
    expect(await viewerAccess.json()).toMatchObject({
      permitted: true,
      role: "viewer",
    });
    const viewerManage = await space.fetch(
      new Request(
        `https://space/hierarchy-authorize?user_id=viewer&target_space_id=${encodeURIComponent(result.subspace_id)}&action=manage`
      )
    );
    expect(
      ((await viewerManage.json()) as { permitted: boolean }).permitted
    ).toBe(false);
    storage.sql.exec(
      "INSERT INTO space_members(space_id,user_id,role) VALUES(?, 'department-editor', 'editor')",
      result.subspace_id
    );
    const editorRead = await space.fetch(
      new Request(
        `https://space/hierarchy-authorize?user_id=department-editor&target_space_id=${encodeURIComponent(result.subspace_id)}&action=read`
      )
    );
    expect(await editorRead.json()).toMatchObject({ permitted: true, role: "editor" });

    const childProject = await space.fetch(
      new Request("https://space/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space_id: "root",
          subspace_id: result.subspace_id,
          name: "Churn analytics",
          created_by: "owner",
        }),
      })
    );
    expect(childProject.status, await childProject.clone().text()).toBe(201);
    const childListAfterCreate = await space.fetch(
      new Request(
        `https://space/projects?space_id=root&subspace_id=${encodeURIComponent(result.subspace_id)}`
      )
    );
    expect(await childListAfterCreate.json()).toMatchObject({ count: 2 });

    storage.sql.exec(
      "INSERT INTO projects(id,space_id,name) VALUES('root-name-conflict','root','Retention')"
    );
    const blockedReturn = await space.fetch(
      new Request("https://space/projects/project-a/return-to-parent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor_id: "owner", tenant_id: "tenant" }),
      })
    );
    expect(blockedReturn.status).toBe(409);
    expect(await blockedReturn.json()).toMatchObject({ error_code: "project_name_conflict" });
    expect(
      storage.sql.exec<{ subspace_id: string }>("SELECT subspace_id FROM projects WHERE id='project-a'").toArray()
    ).toEqual([{ subspace_id: result.subspace_id }]);
    storage.sql.exec("DELETE FROM projects WHERE id='root-name-conflict'");

    const returned = await space.fetch(
      new Request("https://space/projects/project-a/return-to-parent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor_id: "owner", tenant_id: "tenant" }),
      })
    );
    expect(returned.status).toBe(200);
    expect(await returned.json()).toMatchObject({
      project_id: "project-a",
      runtime_space_id: "root",
      subspace_id: null,
      returned: true,
    });
    expect(
      storage.sql
        .exec<{ status: string; direction: string }>(
          "SELECT 'active' AS status, direction FROM project_subspace_migrations ORDER BY created_at"
        )
        .toArray()
    ).toEqual([
      { status: "active", direction: "graduate" },
      { status: "active", direction: "return_to_parent" },
    ]);
  });
});
