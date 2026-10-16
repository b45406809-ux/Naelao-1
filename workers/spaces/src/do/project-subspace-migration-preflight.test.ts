import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SpaceDO } from "./SpaceDO.js";

describe("project to subspace migration preflight", () => {
  it("reports a read-only inventory and blocks cutover while cross-worker adapters are missing", async () => {
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
      source_space_id: "root",
      strategy: "copy_verify_cutover",
      phase: "inventory_only",
      cutover_supported: false,
      inventory: { threads: 1, tasks: 1, workspace_files: 1 },
      blockers: expect.arrayContaining([
        expect.stringContaining("AgentDO"),
        expect.stringContaining("ToolSandbox"),
        expect.stringContaining("authorization and canonical routing"),
      ]),
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
});
