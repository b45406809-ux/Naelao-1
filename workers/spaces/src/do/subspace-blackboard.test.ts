import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SpaceDO } from "./SpaceDO.js";

describe("SpaceDO directed subspace blackboard", () => {
  async function fixture() {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "subspace-blackboard-test" } as never);
    await space.fetch(new Request("https://space/subspace-blackboard/routes", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    const now = new Date().toISOString();
    storage.sql.exec("INSERT INTO spaces(id,parent_id,name,space_type,tenancy_mode,depth,status,settings,created_at) VALUES(?,NULL,?,'launchpad','team',0,'active','{}',?),(?,NULL,?,'launchpad','team',0,'active','{}',?)",
      "root", "Company", now, "other-root", "Other Company", now);
    storage.sql.exec("INSERT INTO spaces(id,parent_id,name,space_type,tenancy_mode,depth,status,settings,created_at) VALUES(?,?,'Sales','launchpad','team',1,'active','{}',?),(?,?,'Research','launchpad','team',1,'active','{}',?),(?,?,'Finance','launchpad','team',1,'active','{}',?),(?,?,'Legal','launchpad','team',1,'active','{}',?),(?,?,'Other','launchpad','team',1,'active','{}',?)",
      "dept-a", "root", now, "dept-b", "root", now, "dept-c", "root", now, "dept-d", "root", now, "other-dept", "other-root", now);
    storage.sql.exec("INSERT INTO space_members(space_id,user_id,role) VALUES('root','root-owner','owner'),('dept-a','sales-editor','editor'),('dept-b','research-member','member'),('dept-b','research-viewer','viewer'),('dept-c','finance-member','member'),('dept-d','legal-member','member')");
    storage.sql.exec(`INSERT INTO space_assistants(space_id,assistant_actor_id,parent_assistant_actor_id,hierarchy_role)
      VALUES('root','assistant:space:root',NULL,'DIRECTOR'),('dept-a','assistant:space:dept-a','assistant:space:root','DEPARTMENT_LEAD'),
      ('dept-b','assistant:space:dept-b','assistant:space:root','DEPARTMENT_LEAD'),('dept-c','assistant:space:dept-c','assistant:space:root','DEPARTMENT_LEAD'),
      ('dept-d','assistant:space:dept-d','assistant:space:root','DEPARTMENT_LEAD')`);
    return { space, storage };
  }

  it("authorizes a sibling grant, sends to both boards and permits only a linked reply", async () => {
    const { space } = await fixture();
    const route = await space.fetch(new Request("https://space/subspace-blackboard/routes?root_space_id=root&actor_id=root-owner", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "route-sales-research", source_subspace_id: "dept-a", target_subspace_id: "dept-b", allowed_kinds: ["question", "completion"], allow_reply: true }),
    }));
    expect(route.status).toBe(201);
    const duplicateRoute = await space.fetch(new Request("https://space/subspace-blackboard/routes?root_space_id=root&actor_id=root-owner", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "route-sales-research", source_subspace_id: "dept-a", target_subspace_id: "dept-b", allowed_kinds: ["question", "completion"], allow_reply: true }),
    }));
    expect(await duplicateRoute.json()).toMatchObject({ route_id: "route-sales-research", deduplicated: true });
    const conflictingRouteId = await space.fetch(new Request("https://space/subspace-blackboard/routes?root_space_id=root&actor_id=root-owner", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "route-sales-research", source_subspace_id: "dept-a", target_subspace_id: "dept-c", allowed_kinds: ["question", "completion"], allow_reply: true }),
    }));
    expect(conflictingRouteId.status).toBe(409);
    const listedRoutes = await space.fetch(new Request("https://space/subspace-blackboard/routes?root_space_id=root&subspace_id=dept-a&actor_id=root-owner"));
    expect(await listedRoutes.json()).toMatchObject({ routes: [{ route_id: "route-sales-research", can_manage: true }] });

    const question = await space.fetch(new Request("https://space/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=sales-editor", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ route_id: "route-sales-research", id: "q1", kind: "question", text: "Can you verify the cohort?", private_record_id: "must-not-cross" }),
    }));
    expect(question.status).toBe(201);
    const questionBody = await question.json();
    expect(questionBody).toMatchObject({ message: { id: "q1", text: "Can you verify the cohort?" } });
    expect(questionBody).not.toHaveProperty("message.private_record_id");
    const duplicateQuestion = await space.fetch(new Request("https://space/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=sales-editor", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ route_id: "route-sales-research", id: "q1", kind: "question", text: "Can you verify the cohort?" }),
    }));
    expect(await duplicateQuestion.json()).toMatchObject({ deduplicated: true, message: { id: "q1" } });
    const conflictingQuestion = await space.fetch(new Request("https://space/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=sales-editor", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ route_id: "route-sales-research", id: "q1", kind: "question", text: "Changed payload" }),
    }));
    expect(conflictingQuestion.status).toBe(409);
    const received = await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=research-member&route_id=route-sales-research"));
    expect(await received.json()).toMatchObject({ messages: [{ id: "q1", senderSubspaceId: "dept-a" }] });

    const reply = await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=research-member", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ route_id: "route-sales-research", id: "r1", kind: "completion", text: "Verified", reply_to: "q1" }),
    }));
    expect(reply.status).toBe(201);
    const sent = await space.fetch(new Request("https://space/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=sales-editor&route_id=route-sales-research"));
    expect(await sent.json()).toMatchObject({ messages: [{ id: "r1", replyTo: "q1" }, { id: "q1" }] });
  });

  it("hides boards from nonmembers and non-siblings, denies viewers and revokes live access", async () => {
    const { space, storage } = await fixture();
    const routeRequest = () => new Request("https://space/subspace-blackboard/routes?root_space_id=root&actor_id=root-owner", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "route-sales-research", source_subspace_id: "dept-a", target_subspace_id: "dept-b", allowed_kinds: ["question"], allow_reply: false }),
    });
    expect((await space.fetch(routeRequest())).status).toBe(201);
    expect((await space.fetch(new Request("https://space/subspace-blackboard/routes?root_space_id=root&actor_id=root-owner", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "route-not-sibling", source_subspace_id: "dept-a", target_subspace_id: "other-dept", allowed_kinds: ["question"], allow_reply: false }),
    }))).status).toBe(404);

    for (let index = 0; index < 101; index++) storage.sql.exec(
      `INSERT INTO subspace_blackboard_routes(id,source_subspace_id,target_subspace_id,allowed_kinds_json,allow_reply,status,route_revision,created_by,created_at,updated_at)
       VALUES(?, 'dept-a', 'other-dept', '["question"]', 0, 'active', 1, 'legacy', '9999-12-31T00:00:00.000Z', '9999-12-31T00:00:00.000Z')`,
      `stale-route-${String(index).padStart(3, "0")}`);
    const participantRoutes = await space.fetch(new Request("https://space/subspace-blackboard/routes?root_space_id=root&subspace_id=dept-a&actor_id=sales-editor"));
    expect(await participantRoutes.json()).toEqual({ routes: [{ route_id: "route-sales-research", source_subspace_id: "dept-a",
      target_subspace_id: "dept-b", allow_reply: false, route_revision: 1, can_manage: false }], truncated: false });

    const viewerSend = await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=research-viewer", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ route_id: "route-sales-research", id: "viewer", kind: "question", text: "No" }),
    }));
    expect(viewerSend.status).toBe(404);
    const strangerRead = await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=stranger&route_id=route-sales-research"));
    expect(strangerRead.status).toBe(404);

    const forbiddenKind = await space.fetch(new Request("https://space/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=sales-editor", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ route_id: "route-sales-research", id: "forbidden-kind", kind: "secret", text: "Not declared" }),
    }));
    expect(forbiddenKind.status).toBe(404);
    const unrelatedRoutes = await space.fetch(new Request("https://space/subspace-blackboard/routes?root_space_id=root&subspace_id=dept-d&actor_id=legal-member"));
    expect(await unrelatedRoutes.json()).toEqual({ routes: [], truncated: false });
    const unrelatedBoard = await space.fetch(new Request("https://space/sub-spaces/dept-d/blackboard?root_space_id=root&actor_id=legal-member&route_id=route-sales-research"));
    expect(unrelatedBoard.status).toBe(404);

    storage.sql.exec("DELETE FROM space_members WHERE space_id='dept-b' AND user_id='research-member'");
    const removedMemberRead = await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=research-member&route_id=route-sales-research"));
    expect(removedMemberRead.status).toBe(404);

    const revoked = await space.fetch(new Request("https://space/subspace-blackboard/routes/route-sales-research/revoke?root_space_id=root&actor_id=root-owner", { method: "POST" }));
    expect(revoked.status).toBe(200);
    const afterRevoke = await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=research-member&route_id=route-sales-research"));
    expect(afterRevoke.status).toBe(404);
  });

  it("binds assistant reads and publishes to the exact active subspace assistant identity", async () => {
    const { space } = await fixture();
    const route = await space.fetch(new Request("https://space/subspace-blackboard/routes?root_space_id=root&actor_id=root-owner", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "route-assistant", source_subspace_id: "dept-a", target_subspace_id: "dept-b", allowed_kinds: ["question", "completion"], allow_reply: true }),
    }));
    expect(route.status).toBe(201);
    const read = await space.fetch(new Request("https://space/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=assistant:space:dept-a&route_id=route-assistant"));
    expect(read.status).toBe(200);
    const wrongIdentity = await space.fetch(new Request("https://space/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=assistant:space:dept-b&route_id=route-assistant"));
    expect(wrongIdentity.status).toBe(404);
    const publish = await space.fetch(new Request("https://space/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=assistant:space:dept-a", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ route_id: "route-assistant", id: "assistant-question", kind: "question", text: "Please verify this" }),
    }));
    expect(publish.status).toBe(201);
    const reply = await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=assistant:space:dept-b", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ route_id: "route-assistant", id: "assistant-reply", kind: "completion", text: "Verified", reply_to: "assistant-question" }),
    }));
    expect(reply.status).toBe(201);
    const revoked = await space.fetch(new Request("https://space/subspace-blackboard/routes/route-assistant/revoke?root_space_id=root&actor_id=root-owner", { method: "POST" }));
    expect(revoked.status).toBe(200);
    const afterRevoke = await space.fetch(new Request("https://space/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=assistant:space:dept-a&route_id=route-assistant"));
    expect(afterRevoke.status).toBe(404);
  });

  it("validates multi-recipient routes before atomically storing isolated retry-safe copies", async () => {
    const { space } = await fixture();
    const createRoute = (id: string, target: string, kinds: string[]) => space.fetch(new Request("https://space/subspace-blackboard/routes?root_space_id=root&actor_id=root-owner", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, source_subspace_id: "dept-a", target_subspace_id: target, allowed_kinds: kinds, allow_reply: false }),
    }));
    expect((await createRoute("route-sales-research", "dept-b", ["finding"])).status).toBe(201);
    expect((await createRoute("route-sales-research-alt", "dept-b", ["finding"])).status).toBe(201);
    expect((await createRoute("route-sales-finance", "dept-c", ["finding"])).status).toBe(201);
    expect((await createRoute("route-sales-legal", "dept-d", ["finding"])).status).toBe(201);
    expect((await createRoute("route-sales-outsider", "other-dept", ["finding"])).status).toBe(404);

    const send = (routeIds: string[], kind = "finding", id = "broadcast-1", text = "Share the verified cohort total") => space.fetch(new Request(
      "https://space/sub-spaces/dept-a/blackboard/broadcast?root_space_id=root&actor_id=sales-editor", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, route_ids: routeIds, kind, text }),
      }));
    const invalid = await send(["route-sales-research", "route-sales-outsider"]);
    expect(invalid.status).toBe(404);
    const incompatible = await send(["route-sales-research", "route-sales-finance"], "question");
    expect(incompatible.status).toBe(404);
    expect((await send(["route-sales-research", "route-sales-research-alt"])).status).toBe(400);
    for (const routeId of ["route-sales-research", "route-sales-finance"]) {
      const board = await space.fetch(new Request(`https://space/sub-spaces/${routeId.endsWith("finance") ? "dept-c" : "dept-b"}/blackboard?root_space_id=root&actor_id=${routeId.endsWith("finance") ? "finance-member" : "research-member"}&route_id=${routeId}`));
      expect(await board.json()).toMatchObject({ messages: [] });
    }

    const sent = await send(["route-sales-finance", "route-sales-research"]);
    expect(sent.status).toBe(201);
    expect(await sent.json()).toMatchObject({ messages: [
      { id: "broadcast-1", routeId: "route-sales-finance", targetSubspaceId: "dept-c" },
      { id: "broadcast-1", routeId: "route-sales-research", targetSubspaceId: "dept-b" },
    ] });
    expect(await (await send(["route-sales-research", "route-sales-finance"])).json()).toMatchObject({ deduplicated: true });
    for (const [departmentId, actorId, routeId] of [
      ["dept-b", "research-member", "route-sales-research"], ["dept-c", "finance-member", "route-sales-finance"],
    ]) {
      const board = await space.fetch(new Request(`https://space/sub-spaces/${departmentId}/blackboard?root_space_id=root&actor_id=${actorId}&route_id=${routeId}`));
      expect(await board.json()).toMatchObject({ messages: [{ id: "broadcast-1", text: "Share the verified cohort total" }] });
    }
    expect((await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=research-member&route_id=route-sales-finance"))).status).toBe(404);
    expect((await space.fetch(new Request("https://space/sub-spaces/dept-c/blackboard?root_space_id=root&actor_id=finance-member&route_id=route-sales-research"))).status).toBe(404);
    expect((await send(["route-sales-research"], "finding")).status).toBe(400);
    expect((await send(["route-sales-finance", "route-sales-legal"], "finding", "broadcast-1")).status).toBe(409);
    expect((await send(["route-sales-finance", "route-sales-research"], "finding", "broadcast-1", "Changed payload")).status).toBe(409);

    const revokeOneRecipient = await space.fetch(new Request("https://space/subspace-blackboard/routes/route-sales-finance/revoke?root_space_id=root&actor_id=root-owner", { method: "POST" }));
    expect(revokeOneRecipient.status).toBe(200);
    const hiddenRecipient = await space.fetch(new Request("https://space/sub-spaces/dept-c/blackboard?root_space_id=root&actor_id=finance-member&route_id=route-sales-finance"));
    expect(hiddenRecipient.status).toBe(404);
    const otherRecipient = await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=research-member&route_id=route-sales-research"));
    expect(await otherRecipient.json()).toMatchObject({ messages: [{ id: "broadcast-1" }] });
    expect((await send(["route-sales-finance", "route-sales-research"])).status).toBe(404);
  });

  it("bounds active routes per participant subspace", async () => {
    const { space, storage } = await fixture();
    const now = new Date().toISOString();
    for (let index = 0; index < 100; index++) storage.sql.exec(
      `INSERT INTO subspace_blackboard_routes(id,source_subspace_id,target_subspace_id,allowed_kinds_json,allow_reply,status,route_revision,created_by,created_at,updated_at)
       VALUES(?, 'dept-a', 'dept-b', '["question"]', 0, 'active', 1, 'root-owner', ?, ?)`,
      `route-limit-${String(index).padStart(3, "0")}`, now, now);
    const response = await space.fetch(new Request("https://space/subspace-blackboard/routes?root_space_id=root&actor_id=root-owner", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "route-over-limit", source_subspace_id: "dept-a", target_subspace_id: "dept-c", allowed_kinds: ["question"], allow_reply: false }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "subspace_route_capacity_exceeded" });
  });

  describe("resource references", () => {
    const ref = { type: "knowledge_document", target_space_id: "dept-a", document_id: "doc-1" };
    async function withRoutes() {
      const { space, storage } = await fixture();
      for (const [id, target] of [["route-sales-research", "dept-b"], ["route-sales-finance", "dept-c"]])
        expect((await space.fetch(new Request("https://space/subspace-blackboard/routes?root_space_id=root&actor_id=root-owner", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, source_subspace_id: "dept-a", target_subspace_id: target, allowed_kinds: ["artifact", "finding"], allow_reply: false }),
        }))).status).toBe(201);
      const publish = (body: Record<string, unknown>, links = true) => space.fetch(new Request(
        `https://space/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=sales-editor${links ? "&resource_links=true" : ""}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ route_id: "route-sales-research", id: "a1", kind: "artifact", text: "See doc", ...body }),
        }));
      const broadcast = (body: Record<string, unknown>, links = true) => space.fetch(new Request(
        `https://space/sub-spaces/dept-a/blackboard/broadcast?root_space_id=root&actor_id=sales-editor${links ? "&resource_links=true" : ""}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "b1", route_ids: ["route-sales-research", "route-sales-finance"], kind: "artifact", text: "See doc", ...body }),
        }));
      return { space, storage, publish, broadcast };
    }

    it("accepts a reference on artifact messages when enabled and returns only the reference", async () => {
      const { space, publish } = await withRoutes();
      const created = await publish({ resource_ref: { ...ref } });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ message: { id: "a1", resource_ref: ref } });
      const read = await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=research-member&route_id=route-sales-research"));
      const body = await read.json() as { messages: Array<Record<string, unknown>> };
      expect(body.messages[0]!.resource_ref).toEqual(ref);
      expect(Object.keys(body.messages[0]!.resource_ref as object).sort()).toEqual(["document_id", "target_space_id", "type"]);
      expect(body.messages[0]).not.toHaveProperty("resourceRefJson");
    });

    it("rejects references on non-artifact kinds, malformed refs, foreign hierarchy and when the flag is off", async () => {
      const { publish } = await withRoutes();
      expect((await publish({ kind: "finding", resource_ref: ref })).status).toBe(400);
      expect((await publish({ resource_ref: { ...ref, type: "file" } })).status).toBe(400);
      expect((await publish({ resource_ref: { ...ref, extra: "x" } })).status).toBe(400);
      expect((await publish({ resource_ref: { ...ref, document_id: "bad id!" } })).status).toBe(400);
      expect((await publish({ resource_ref: { ...ref, target_space_id: "other-dept" } })).status).toBe(400);
      const off = await publish({ resource_ref: ref }, false);
      expect(off.status).toBe(400);
      expect(await off.json()).toEqual({ error_code: "resource_links_disabled" });
      expect((await publish({})).status).toBe(201);
    });

    it("treats a changed reference on replay as a conflict and an identical replay as a duplicate", async () => {
      const { publish } = await withRoutes();
      expect((await publish({ resource_ref: ref })).status).toBe(201);
      const same = await publish({ resource_ref: ref });
      expect(await same.json()).toMatchObject({ deduplicated: true, message: { id: "a1", resource_ref: ref } });
      expect((await publish({ resource_ref: { ...ref, document_id: "doc-2" } })).status).toBe(409);
      expect((await publish({})).status).toBe(409);
    });

    it("copies the reference to every broadcast recipient and compares it on replay", async () => {
      const { space, broadcast } = await withRoutes();
      const created = await broadcast({ resource_ref: ref });
      expect(created.status).toBe(201);
      const body = await created.json() as { messages: Array<{ resource_ref?: unknown }> };
      expect(body.messages.map(message => message.resource_ref)).toEqual([ref, ref]);
      for (const [dept, actor, route] of [["dept-b", "research-member", "route-sales-research"], ["dept-c", "finance-member", "route-sales-finance"]]) {
        const read = await space.fetch(new Request(`https://space/sub-spaces/${dept}/blackboard?root_space_id=root&actor_id=${actor}&route_id=${route}`));
        expect(await read.json()).toMatchObject({ messages: [{ id: "b1", resource_ref: ref }] });
      }
      expect(await (await broadcast({ resource_ref: ref })).json()).toMatchObject({ deduplicated: true, messages: [{ resource_ref: ref }, { resource_ref: ref }] });
      expect((await broadcast({ resource_ref: { ...ref, document_id: "doc-2" } })).status).toBe(409);
      expect((await broadcast({ id: "b2", kind: "finding", resource_ref: ref })).status).toBe(400);
      expect((await broadcast({ id: "b3", resource_ref: ref }, false)).status).toBe(400);
    });
  });
});
