import { describe, expect, it } from "vitest";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import { createBlackboardRequestIfPublished, retireProjectCoordination, unpublishBlackboardProject } from "./project-coordination-retirement.js";

describe("project coordination retirement", () => {
  it("removes a retiring project's shared facts, requests, events and policy state without touching another project", async () => {
    const db = createFakeD1([`
      PRAGMA foreign_keys=ON;
      CREATE TABLE space_blackboard_cards(tenant_id TEXT,space_id TEXT,project_id TEXT,summary TEXT,PRIMARY KEY(tenant_id,space_id,project_id));
      CREATE TABLE space_blackboard_requests(tenant_id TEXT,space_id TEXT,id TEXT,source_project_id TEXT,target_project_id TEXT,PRIMARY KEY(tenant_id,space_id,id));
      CREATE TABLE space_blackboard_events(tenant_id TEXT,space_id TEXT,event_id TEXT,project_id TEXT,request_id TEXT,PRIMARY KEY(tenant_id,space_id,event_id,project_id));
      CREATE TABLE space_blackboard_event_receipts(tenant_id TEXT,space_id TEXT,project_id TEXT,event_id TEXT,user_id TEXT,read_at TEXT,PRIMARY KEY(tenant_id,space_id,project_id,event_id,user_id),FOREIGN KEY(tenant_id,space_id,event_id,project_id) REFERENCES space_blackboard_events(tenant_id,space_id,event_id,project_id) ON DELETE CASCADE);
      CREATE TABLE space_blackboard_delivery(tenant_id TEXT,space_id TEXT,project_id TEXT,event_id TEXT,identity_id TEXT,status TEXT,attempts INTEGER,next_at INTEGER,lease_until INTEGER,PRIMARY KEY(tenant_id,space_id,project_id,event_id,identity_id),FOREIGN KEY(tenant_id,space_id,event_id,project_id) REFERENCES space_blackboard_events(tenant_id,space_id,event_id,project_id) ON DELETE CASCADE);
      CREATE TABLE space_blackboard_wakes(tenant_id TEXT,space_id TEXT,project_id TEXT,event_id TEXT,status TEXT,attempts INTEGER,next_at INTEGER,lease_until INTEGER,updated_at INTEGER,dispatch_accepted INTEGER,PRIMARY KEY(tenant_id,space_id,project_id,event_id),FOREIGN KEY(tenant_id,space_id,event_id,project_id) REFERENCES space_blackboard_events(tenant_id,space_id,event_id,project_id) ON DELETE CASCADE);
      CREATE TABLE space_blackboard_sharing_policies(tenant_id TEXT,space_id TEXT,project_id TEXT,PRIMARY KEY(tenant_id,space_id,project_id));
      CREATE TABLE space_blackboard_policy_uses(tenant_id TEXT,space_id TEXT,project_id TEXT,action_key TEXT,PRIMARY KEY(tenant_id,space_id,project_id,action_key));
      CREATE TABLE space_blackboard_policies(tenant_id TEXT,space_id TEXT,project_id TEXT,PRIMARY KEY(tenant_id,space_id,project_id));
      INSERT INTO space_blackboard_cards VALUES('tenant','space','retiring','private disclosure');
      INSERT INTO space_blackboard_cards VALUES('tenant','space','other','other disclosure');
      INSERT INTO space_blackboard_requests VALUES('tenant','space','from-retiring','retiring','other');
      INSERT INTO space_blackboard_requests VALUES('tenant','space','to-retiring','other','retiring');
      INSERT INTO space_blackboard_requests VALUES('tenant','space','unrelated','a','b');
      INSERT INTO space_blackboard_events VALUES('tenant','space','project-event','retiring','none');
      INSERT INTO space_blackboard_events VALUES('tenant','space','request-event','other','from-retiring');
      INSERT INTO space_blackboard_events VALUES('tenant','space','unrelated-event','other','unrelated');
      INSERT INTO space_blackboard_event_receipts VALUES('tenant','space','retiring','project-event','user','now');
      INSERT INTO space_blackboard_delivery VALUES('tenant','space','retiring','project-event','identity','pending',0,0,NULL);
      INSERT INTO space_blackboard_wakes VALUES('tenant','space','retiring','project-event','pending',0,0,NULL,0,0);
      INSERT INTO space_blackboard_sharing_policies VALUES('tenant','space','retiring');
      INSERT INTO space_blackboard_sharing_policies VALUES('tenant','space','other');
      INSERT INTO space_blackboard_policy_uses VALUES('tenant','space','retiring','action');
      INSERT INTO space_blackboard_policy_uses VALUES('tenant','space','other','action');
      INSERT INTO space_blackboard_policies VALUES('tenant','space','retiring');
      INSERT INTO space_blackboard_policies VALUES('tenant','space','other');
    `]);

    await retireProjectCoordination(db as never, "tenant", "space", "retiring");
    await retireProjectCoordination(db as never, "tenant", "space", "retiring");

    expect(db.db.prepare("SELECT project_id FROM space_blackboard_cards ORDER BY project_id").all()).toEqual([{ project_id: "other" }]);
    expect(db.db.prepare("SELECT id FROM space_blackboard_requests ORDER BY id").all()).toEqual([{ id: "unrelated" }]);
    expect(db.db.prepare("SELECT event_id FROM space_blackboard_events ORDER BY event_id").all()).toEqual([{ event_id: "unrelated-event" }]);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM space_blackboard_event_receipts").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM space_blackboard_delivery").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM space_blackboard_wakes").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT project_id FROM space_blackboard_sharing_policies").all()).toEqual([{ project_id: "other" }]);
    expect(db.db.prepare("SELECT project_id FROM space_blackboard_policy_uses").all()).toEqual([{ project_id: "other" }]);
    expect(db.db.prepare("SELECT project_id FROM space_blackboard_policies").all()).toEqual([{ project_id: "other" }]);
  });

  it("creates new requests only while the target is published and withdraws pending requests on unpublish", async () => {
    const db = createFakeD1([`
      CREATE TABLE space_blackboard_cards(tenant_id TEXT,space_id TEXT,project_id TEXT,summary TEXT,PRIMARY KEY(tenant_id,space_id,project_id));
      CREATE TABLE space_blackboard_requests(tenant_id TEXT,space_id TEXT,id TEXT,source_project_id TEXT,target_project_id TEXT,objective TEXT,expected_result TEXT,deadline TEXT,status TEXT,created_by TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(tenant_id,space_id,id));
      CREATE TABLE space_blackboard_events(tenant_id TEXT,space_id TEXT,event_id TEXT,project_id TEXT,request_id TEXT,kind TEXT,created_at TEXT,PRIMARY KEY(tenant_id,space_id,event_id,project_id));
      CREATE TABLE space_blackboard_sharing_policies(tenant_id TEXT,space_id TEXT,project_id TEXT,PRIMARY KEY(tenant_id,space_id,project_id));
      CREATE TABLE space_blackboard_policy_uses(tenant_id TEXT,space_id TEXT,project_id TEXT,action_key TEXT,PRIMARY KEY(tenant_id,space_id,project_id,action_key));
      CREATE TABLE space_blackboard_policies(tenant_id TEXT,space_id TEXT,project_id TEXT,PRIMARY KEY(tenant_id,space_id,project_id));
      INSERT INTO space_blackboard_cards VALUES('tenant','space','target','published summary');
      INSERT INTO space_blackboard_cards VALUES('tenant','space','other','other summary');
      INSERT INTO space_blackboard_requests VALUES('tenant','space','accepted','requester','target','objective','expected',NULL,'accepted','user','now','now');
      INSERT INTO space_blackboard_events VALUES('tenant','space','accepted:accepted','requester','accepted','request.accepted','now');
    `]);
    const input = { tenantId: "tenant", spaceId: "space", requestId: "pending", sourceProjectId: "requester", targetProjectId: "target",
      objective: "Review the published service", expectedResult: "Send a scoped response", deadline: null, userId: "user", now: "now" };

    await createBlackboardRequestIfPublished(db as never, input);
    expect(db.db.prepare("SELECT status FROM space_blackboard_requests WHERE id='pending'").get()).toEqual({ status: "pending" });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM space_blackboard_events WHERE request_id='pending'").get()).toEqual({ count: 1 });

    await unpublishBlackboardProject(db as never, "tenant", "space", "target");
    expect(db.db.prepare("SELECT id FROM space_blackboard_requests ORDER BY id").all()).toEqual([{ id: "accepted" }]);
    expect(db.db.prepare("SELECT request_id FROM space_blackboard_events ORDER BY request_id").all()).toEqual([{ request_id: "accepted" }]);
    expect(db.db.prepare("SELECT project_id FROM space_blackboard_cards ORDER BY project_id").all()).toEqual([{ project_id: "other" }]);

    await createBlackboardRequestIfPublished(db as never, { ...input, requestId: "after-unpublish" });
    expect(db.db.prepare("SELECT id FROM space_blackboard_requests ORDER BY id").all()).toEqual([{ id: "accepted" }]);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM space_blackboard_events WHERE request_id='after-unpublish'").get()).toEqual({ count: 0 });
  });
});
