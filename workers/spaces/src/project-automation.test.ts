import { requireManageableAutomationProject } from "@naelao/agent-sdk";
import { describe, expect, it } from "vitest";
import { SpaceDO } from "./do/SpaceDO.js";

describe("Project-Anchored Automation Architecture (Item 4)", () => {
  it("enforces manageable project validation before schedule/trigger insert", () => {
    expect(
      requireManageableAutomationProject({
        spaceId: "space-1",
        projectId: "proj-1",
        projectSpaceId: "space-1",
        projectStatus: "active",
        userRole: "editor",
      })
    ).toEqual({ allowed: true });

    expect(() =>
      requireManageableAutomationProject({
        spaceId: "space-1",
        projectId: "",
        projectSpaceId: "space-1",
        projectStatus: "active",
        isSpaceAdmin: true,
      })
    ).toThrow("Automation must be anchored to a project");

    expect(() =>
      requireManageableAutomationProject({
        spaceId: "space-1",
        projectId: "proj-1",
        projectSpaceId: "space-2",
        projectStatus: "active",
        isSpaceAdmin: true,
      })
    ).toThrow("project_not_found");

    expect(() =>
      requireManageableAutomationProject({
        spaceId: "space-1",
        projectId: "proj-1",
        projectSpaceId: "space-1",
        projectStatus: "active",
        userRole: "viewer",
      })
    ).toThrow("insufficient_project_permission");
  });

  it("rejects event trigger creation when project_id is absent or foreign in SpaceDO", async () => {
    const projects = new Map();
    const mockCtx = {
      storage: {
        sql: {
          exec(query, ...params) {
            if (query.includes("FROM projects WHERE id = ?")) {
              const p = projects.get(params[0]);
              return { toArray: () => (p ? [p] : []) };
            }
            return { toArray: () => [] };
          },
        },
        transactionSync: (fn) => fn(),
      },
    };

    projects.set("proj-local", {
      id: "proj-local",
      space_id: "space-1",
      status: "active",
    });
    projects.set("proj-other", {
      id: "proj-other",
      space_id: "space-99",
      status: "active",
    });

    const spaceDO = new SpaceDO(mockCtx, { PLATFORM_SECRET: "secret" });

    const resMissing = await spaceDO.fetch(
      new Request("https://space-do/event-triggers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space_id: "space-1",
          event_type: "thread.created",
          script_name: "test",
        }),
      })
    );
    expect(resMissing.status).toBe(400);

    const resForeign = await spaceDO.fetch(
      new Request("https://space-do/event-triggers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space_id: "space-1",
          project_id: "proj-other",
          event_type: "thread.created",
          script_name: "test",
        }),
      })
    );
    expect(resForeign.status).toBe(404);
  });

  it("rejects cross-space projects and cross-project parents when creating tiered threads", async () => {
    const projects = new Map([
      ["proj-local", { id: "proj-local", space_id: "space-1", status: "active", visibility: "public" }],
      ["proj-other", { id: "proj-other", space_id: "space-99", status: "active", visibility: "public" }],
    ]);
    const parents = new Map([
      ["parent-other", { space_id: "space-1", project_id: "proj-other", status: "active" }],
    ]);
    const mockCtx = {
      storage: {
        sql: {
          exec(query, ...params) {
            if (query.includes("FROM projects WHERE id = ?")) {
              const project = projects.get(String(params[0]));
              return { toArray: () => (project ? [project] : []) };
            }
            if (query.includes("FROM threads WHERE id = ?")) {
              const parent = parents.get(String(params[0]));
              return { toArray: () => (parent ? [parent] : []) };
            }
            return { toArray: () => [] };
          },
        },
        transactionSync: (fn) => fn(),
      },
    };
    const spaceDO = new SpaceDO(mockCtx, { PLATFORM_SECRET: "secret" });

    const foreignProject = await spaceDO.fetch(new Request("https://space-do/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space_id: "space-1", project_id: "proj-other", title: "bad" }),
    }));
    expect(foreignProject.status).toBe(404);

    const foreignParent = await spaceDO.fetch(new Request("https://space-do/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space_id: "space-1", project_id: "proj-local", parent_thread_id: "parent-other", title: "bad parent" }),
    }));
    expect(foreignParent.status).toBe(400);
  });

  it("does not reveal a private project's thread by guessed id", async () => {
    const mockCtx = {
      storage: {
        sql: {
          exec(query, ...params) {
            if (query.includes("FROM threads WHERE id = ?")) {
              return { toArray: () => (String(params[0]) === "private-thread" ? [{
                id: "private-thread", space_id: "space-1", project_id: "private-project",
                thread_tier: "tier_2_task", created_by: "owner-1", status: "active",
              }] : []) };
            }
            if (query.includes("FROM projects WHERE id = ?")) {
              return { toArray: () => (String(params[0]) === "private-project" ? [{
                id: "private-project", space_id: "space-1", visibility: "private", status: "active",
              }] : []) };
            }
            return { toArray: () => [] };
          },
        },
        transactionSync: (fn) => fn(),
      },
    };
    const spaceDO = new SpaceDO(mockCtx, { PLATFORM_SECRET: "secret" });
    const response = await spaceDO.fetch(new Request("https://space-do/threads/private-thread?viewer_id=outsider"));
    expect(response.status).toBe(404);
  });
});
