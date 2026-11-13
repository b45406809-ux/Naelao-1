import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { applyMigrations, type SqlStorage } from "@naelao/db";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO, SPACE_DO_MIGRATIONS } from "./do/SpaceDO.js";
import worker from "./index.js";

describe("project coordination access after membership revocation", () => {
  it("rechecks card, request, event and mutation access against the live private-project ACL", async () => {
    const secret = "coordination-access-test-secret";
    const platformDb = createFakeD1([
      `CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,status TEXT NOT NULL);`,
      `CREATE TABLE space_members(space_id TEXT NOT NULL,end_user_id TEXT NOT NULL,role TEXT NOT NULL,suspended_at TEXT,PRIMARY KEY(space_id,end_user_id));`,
      `CREATE TABLE space_blackboard_cards(tenant_id TEXT,space_id TEXT,project_id TEXT,summary TEXT,capabilities_json TEXT,evidence_json TEXT,updated_at TEXT,PRIMARY KEY(tenant_id,space_id,project_id));`,
      `CREATE TABLE space_blackboard_requests(tenant_id TEXT,space_id TEXT,id TEXT,source_project_id TEXT,target_project_id TEXT,objective TEXT,expected_result TEXT,deadline TEXT,status TEXT,response TEXT,created_by TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(tenant_id,space_id,id));`,
      `CREATE TABLE space_blackboard_events(tenant_id TEXT,space_id TEXT,event_id TEXT,project_id TEXT,request_id TEXT,kind TEXT,created_at TEXT,PRIMARY KEY(tenant_id,space_id,event_id,project_id));`,
      `CREATE TABLE space_blackboard_event_receipts(tenant_id TEXT,space_id TEXT,project_id TEXT,event_id TEXT,user_id TEXT,read_at TEXT,PRIMARY KEY(tenant_id,space_id,project_id,event_id,user_id));`,
    ]);
    platformDb.db.exec(`INSERT INTO spaces VALUES('space-a','tenant-a','active');
      INSERT INTO space_members VALUES('space-a','user-a','member',NULL);
      INSERT INTO space_blackboard_cards VALUES('tenant-a','space-a','project-a','private service summary','[]','[]','2026-11-13T00:00:00.000Z');
      INSERT INTO space_blackboard_cards VALUES('tenant-a','space-a','public-a','Space public card','[]','[]','2026-11-13T00:00:00.000Z');
      INSERT INTO space_blackboard_requests VALUES('tenant-a','space-a','request-a','source-a','project-a','review','scoped response',NULL,'pending',NULL,'user-a','2026-11-13T00:00:00.000Z','2026-11-13T00:00:00.000Z');
      INSERT INTO space_blackboard_events VALUES('tenant-a','space-a','request-a:pending','project-a','request-a','request.pending','2026-11-13T00:00:00.000Z');`);

    const storage = createDOStorage();
    applyMigrations(storage as unknown as { sql: SqlStorage; transactionSync<T>(closure: () => T): T }, SPACE_DO_MIGRATIONS);
    const now = new Date().toISOString();
    storage.sql.exec(`INSERT INTO spaces(id,parent_id,name,space_type,tenancy_mode,depth,status,settings,created_at)
      VALUES('space-a',NULL,'Space','launchpad','team',0,'active','{}',?)`, now);
    storage.sql.exec(`INSERT INTO projects(id,space_id,subspace_id,name,visibility,status)
      VALUES('project-a','space-a',NULL,'Private project','private','active'),
            ('public-a','space-a',NULL,'Public project','public','active'),
            ('source-a','space-a',NULL,'Requesting project','private','active')`);
    storage.sql.exec(`INSERT INTO project_members(project_id,user_id,role) VALUES
      ('project-a','user-a','viewer'),('source-a','user-a','editor')`);
    storage.sql.exec("INSERT INTO space_members(space_id,user_id,role) VALUES('space-a','user-a','member')");
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret } as never);
    const env = {
      ENVIRONMENT: "test", PLATFORM_SECRET: secret, PLATFORM_DB: platformDb,
      SPACE_DO: { idFromName: (name: string) => name, get: () => space },
    } as never;
    const token = await mintInternalToken(secret, "tenant-a");
    const callAs = async (userId: string, path: string, method = "GET", body?: unknown) => worker.fetch(new Request(`https://spaces.test${path}`, {
      method, headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": userId,
        "x-naelao-role": "product_end_user", "x-naelao-internal-token": token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, {} as ExecutionContext);
    const call = (path: string, method = "GET", body?: unknown) => callAs("user-a", path, method, body);

    const visibleCard = await call("/internal/spaces/space-a/blackboard/cards/project-a");
    expect(visibleCard.status).toBe(200);
    await expect(visibleCard.json()).resolves.toMatchObject({ card: { summary: "private service summary" } });
    expect((await call("/internal/spaces/space-a/blackboard/requests/project-a")).status).toBe(200);
    expect((await call("/internal/spaces/space-a/blackboard/events/project-a")).status).toBe(200);

    const outsiderCards = await callAs("outsider", "/internal/spaces/space-a/blackboard/cards");
    expect(outsiderCards.status).toBe(200);
    await expect(outsiderCards.json()).resolves.toMatchObject({ cards: [] });

    storage.sql.exec("DELETE FROM project_members WHERE project_id='project-a' AND user_id='user-a'");

    const deniedReads = await Promise.all([
      call("/internal/spaces/space-a/blackboard/cards/project-a"),
      call("/internal/spaces/space-a/blackboard/requests/project-a"),
      call("/internal/spaces/space-a/blackboard/events/project-a"),
    ]);
    expect(deniedReads.map(response => response.status)).toEqual([403, 403, 403]);
    const createRequest = await call("/internal/spaces/space-a/blackboard/requests", "POST", {
      id: "new-request", source_project_id: "source-a", target_project_id: "project-a",
      objective: "review", expected_result: "scoped response",
    });
    const transition = await call("/internal/spaces/space-a/blackboard/requests/request-a/transition", "POST", {
      project_id: "project-a", action: "accept",
    });
    const unpublish = await call("/internal/spaces/space-a/blackboard/cards/project-a", "DELETE");
    expect([createRequest.status, transition.status, unpublish.status]).toEqual([403, 403, 403]);
    for (const response of [...deniedReads, createRequest, transition, unpublish]) {
      const body = await response.json() as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain("private service summary");
      expect(JSON.stringify(body)).not.toContain("request-a");
    }
  });
});
