import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SpaceDO } from "./SpaceDO.js";

describe("private project-owner Space coordination proposals", () => {
  async function setup() {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, {} as never);
    const root = "http://space/space-coordination-proposals";
    await space.fetch(new Request("http://space/space-coordination-policy?tenant_id=tenant&space_id=space"));
    storage.sql.exec("INSERT INTO spaces(id,name,space_type) VALUES('space','Space','workspace')");
    storage.sql.exec("INSERT INTO projects(id,space_id,name,visibility) VALUES('private-project','space','Secret service project','private')");
    storage.sql.exec("INSERT INTO project_members(project_id,user_id,role) VALUES('private-project','manager','editor')");
    storage.sql.exec("INSERT INTO project_members(project_id,user_id,role) VALUES('private-project','second-manager','owner')");
    storage.sql.exec("INSERT INTO space_members(space_id,user_id,role) VALUES('space','space-admin','admin')");
    storage.sql.exec("INSERT INTO space_members(space_id,user_id,role) VALUES('space','outsider','member')");
    const draft = {
      schema_version: 2,
      capability_key: "official.website",
      label: "The Space has an official public website",
      description: "A fact explicitly authored for review.",
      audience: "space_members",
      expires_at: null,
    } as const;
    const submit = (proposalId = "10000000-0000-4000-8000-000000000001", requesterId = "manager", projectId = "private-project", submittedDraft: unknown = draft) =>
      space.fetch(new Request(root, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        tenant_id: "tenant", space_id: "space", proposal_id: proposalId, project_id: projectId,
        requester_id: requesterId, requester_role: "project_manager", confirm_disclosure: true, draft: submittedDraft,
      }) }));
    const list = (viewerId: string, viewerRole: string, projectId?: string, after?: string) => {
      const params = new URLSearchParams({ tenant_id: "tenant", space_id: "space", viewer_id: viewerId, viewer_role: viewerRole,
        ...(projectId ? { project_id: projectId } : {}), ...(after ? { after } : {}) });
      return space.fetch(new Request(`${root}?${params}`));
    };
    const review = (proposalId: string, action: "approve" | "reject", expectedRevision = 1, reviewedDraft: unknown = draft) =>
      space.fetch(new Request(`${root}/${proposalId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({
        tenant_id: "tenant", space_id: "space", actor_id: "space-admin", actor_role: "admin",
        expected_revision: expectedRevision, action, ...(action === "approve" ? { confirm_disclosure: true, draft: reviewedDraft } : {}),
      }) }));
    const withdraw = (proposalId: string, requesterId: string, expectedRevision = 1) =>
      space.fetch(new Request(`${root}/${proposalId}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({
        tenant_id: "tenant", space_id: "space", requester_id: requesterId, expected_revision: expectedRevision,
      }) }));
    return { space, storage, root, draft, submit, list, review, withdraw };
  }

  it("keeps pending text private to its requester and the Space review queue", async () => {
    const { submit, list, draft } = await setup();
    const created = await submit();
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ proposal: { draft, status: "pending", revision: 1 }, access_granted: false });
    const requester = await list("manager", "member", "private-project").then(response => response.json()) as { proposals: Array<Record<string, unknown>> };
    expect(requester.proposals).toMatchObject([{ proposal_id: "10000000-0000-4000-8000-000000000001", draft, status: "pending" }]);
    expect(requester.proposals[0]).not.toHaveProperty("requester_id");
    const otherProjectManager = await list("second-manager", "member", "private-project").then(response => response.json()) as { proposals: unknown[] };
    expect(otherProjectManager.proposals).toEqual([]);
    const outsider = await list("outsider", "member", "private-project").then(response => response.json()) as { proposals: unknown[] };
    expect(outsider.proposals).toEqual([]);
    const queue = await list("space-admin", "admin").then(response => response.json()) as { proposals: Array<Record<string, unknown>> };
    expect(queue.proposals).toMatchObject([{ requester_id: "manager", project_id: "private-project", draft, status: "pending", revision: 1 }]);
    expect((await list("outsider", "member")).status).toBe(403);
  });

  it("requires the current member-fact policy and exact reviewer confirmation before atomic publication", async () => {
    const { space, storage, draft, submit, review } = await setup();
    await submit();
    const blocked = await review("10000000-0000-4000-8000-000000000001", "approve");
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ error_code: "coordination_member_facts_disabled" });
    expect(storage.sql.exec("SELECT status,revision FROM space_coordination_publication_proposals").toArray()).toEqual([{ status: "pending", revision: 1 }]);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM space_coordination_entries").toArray()).toEqual([{ count: 0 }]);

    const policy = await space.fetch(new Request("http://space/space-coordination-policy?tenant_id=tenant&space_id=space", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
        member_facts_enabled: true, expected_revision: 0, actor_id: "space-admin", actor_role: "admin", confirmed: true,
      }),
    }));
    expect(policy.status).toBe(200);
    const changedDraft = { ...draft, label: "Different wording" };
    const changed = await review("10000000-0000-4000-8000-000000000001", "approve", 1, changedDraft);
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toMatchObject({ error_code: "coordination_proposal_draft_changed" });
    const approved = await review("10000000-0000-4000-8000-000000000001", "approve");
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({ proposal: { status: "approved", revision: 2, reviewed_by: "space-admin" },
      entry: { entry_id: "10000000-0000-4000-8000-000000000001", label: draft.label, audience: "space_members", created_by: "manager", approved_by: "space-admin", advisory_only: true },
      access_granted: false });
    expect(storage.sql.exec("SELECT source_project_id,source_proposal_id FROM space_coordination_entries").toArray()).toEqual([
      { source_project_id: "private-project", source_proposal_id: "10000000-0000-4000-8000-000000000001" },
    ]);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM project_members WHERE project_id='private-project'").toArray()).toEqual([{ count: 2 }]);
    expect(storage.sql.exec("SELECT action,revision,status_after FROM space_coordination_proposal_revisions ORDER BY revision").toArray())
      .toEqual([{ action: "submitted", revision: 1, status_after: "pending" }, { action: "approved", revision: 2, status_after: "approved" }]);
  });

  it("fences withdrawal and review races and retires linked facts when their project is archived", async () => {
    const { space, storage, draft, submit, review, withdraw } = await setup();
    const adminAudienceDraft = { ...draft, audience: "space_admins" };
    await submit("10000000-0000-4000-8000-000000000001", "manager", "private-project", adminAudienceDraft);
    const [approval, withdrawal] = await Promise.all([
      review("10000000-0000-4000-8000-000000000001", "approve", 1, adminAudienceDraft),
      withdraw("10000000-0000-4000-8000-000000000001", "manager"),
    ]);
    expect([approval.status, withdrawal.status].filter(status => status === 200 || status === 201)).toHaveLength(1);
    expect([approval.status, withdrawal.status].filter(status => status === 409)).toHaveLength(1);
    const current = storage.sql.exec("SELECT status FROM space_coordination_publication_proposals").toArray()[0] as { status: string };
    if (current.status === "approved") {
      const archived = await space.fetch(new Request("http://space/projects/private-project?tenant_id=tenant", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "archived" }),
      }));
      expect(archived.status).toBe(200);
      expect(storage.sql.exec("SELECT status,revision FROM space_coordination_publication_proposals").toArray()).toEqual([{ status: "retired", revision: 3 }]);
      expect(storage.sql.exec("SELECT status,version,revoked_by FROM space_coordination_entries").toArray()).toEqual([
        { status: "revoked", version: 2, revoked_by: "system:source_project_retirement" },
      ]);
      expect(storage.sql.exec("SELECT action,actor_role,status_after FROM space_coordination_audit_events ORDER BY created_at,event_id").toArray())
        .toContainEqual({ action: "source_retired", actor_role: "system", status_after: "revoked" });
      await expect((await review("10000000-0000-4000-8000-000000000001", "approve", 2, adminAudienceDraft)).json())
        .resolves.toMatchObject({ error_code: "coordination_proposal_revision_conflict" });
    } else {
      expect(current.status).toBe("withdrawn");
      expect(storage.sql.exec("SELECT COUNT(*) AS count FROM space_coordination_entries").toArray()).toEqual([{ count: 0 }]);
    }
  });

  it("retires the approved source fact and advances proposal history atomically with project archival", async () => {
    const { space, storage, draft, submit, review } = await setup();
    const adminAudienceDraft = { ...draft, audience: "space_admins" };
    await submit("10000000-0000-4000-8000-000000000002", "manager", "private-project", adminAudienceDraft);
    const approved = await review("10000000-0000-4000-8000-000000000002", "approve", 1, adminAudienceDraft);
    expect(approved.status).toBe(200);
    const archived = await space.fetch(new Request("http://space/projects/private-project?tenant_id=tenant", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "archived" }),
    }));
    expect(archived.status).toBe(200);
    expect(storage.sql.exec("SELECT status,revision FROM space_coordination_publication_proposals").toArray())
      .toEqual([{ status: "retired", revision: 3 }]);
    expect(storage.sql.exec("SELECT status,version,revoked_by FROM space_coordination_entries").toArray()).toEqual([
      { status: "revoked", version: 2, revoked_by: "system:source_project_retirement" },
    ]);
    expect(storage.sql.exec("SELECT action,actor_role,status_after FROM space_coordination_audit_events").toArray())
      .toContainEqual({ action: "source_retired", actor_role: "system", status_after: "revoked" });
    expect(storage.sql.exec("SELECT action,status_after,revision FROM space_coordination_proposal_revisions ORDER BY revision").toArray())
      .toEqual([{ action: "submitted", status_after: "pending", revision: 1 },
        { action: "approved", status_after: "approved", revision: 2 },
        { action: "retired", status_after: "retired", revision: 3 }]);
  });

  it("rejects non-manager submissions and idempotently replays the same request id", async () => {
    const { space, storage, submit } = await setup();
    const denied = await submit("10000000-0000-4000-8000-000000000010", "outsider");
    expect(denied.status).toBe(404);
    const first = await submit();
    expect(first.status).toBe(201);
    const replay = await submit();
    expect(replay.status).toBe(200);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM space_coordination_publication_proposals").toArray()).toEqual([{ count: 1 }]);
  });
});
