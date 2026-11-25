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
    storage.sql.exec("INSERT INTO spaces(id,parent_id,name,space_type,tenancy_mode,depth,status,settings,created_at) VALUES(?,?,'Sales','launchpad','team',1,'active','{}',?),(?,?,'Research','launchpad','team',1,'active','{}',?),(?,?,'Other','launchpad','team',1,'active','{}',?)",
      "dept-a", "root", now, "dept-b", "root", now, "other-dept", "other-root", now);
    storage.sql.exec("INSERT INTO space_members(space_id,user_id,role) VALUES('root','root-owner','owner'),('dept-a','sales-editor','editor'),('dept-b','research-member','member'),('dept-b','research-viewer','viewer')");
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

    const question = await space.fetch(new Request("https://space/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=sales-editor", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ route_id: "route-sales-research", id: "q1", kind: "question", text: "Can you verify the cohort?" }),
    }));
    expect(question.status).toBe(201);
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
    const { space } = await fixture();
    const routeRequest = () => new Request("https://space/subspace-blackboard/routes?root_space_id=root&actor_id=root-owner", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "route-sales-research", source_subspace_id: "dept-a", target_subspace_id: "dept-b", allowed_kinds: ["question"], allow_reply: false }),
    });
    expect((await space.fetch(routeRequest())).status).toBe(201);
    expect((await space.fetch(new Request("https://space/subspace-blackboard/routes?root_space_id=root&actor_id=root-owner", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "route-not-sibling", source_subspace_id: "dept-a", target_subspace_id: "other-dept", allowed_kinds: ["question"], allow_reply: false }),
    }))).status).toBe(404);

    const viewerSend = await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=research-viewer", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ route_id: "route-sales-research", id: "viewer", kind: "question", text: "No" }),
    }));
    expect(viewerSend.status).toBe(404);
    const strangerRead = await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=stranger&route_id=route-sales-research"));
    expect(strangerRead.status).toBe(404);

    const revoked = await space.fetch(new Request("https://space/subspace-blackboard/routes/route-sales-research/revoke?root_space_id=root&actor_id=root-owner", { method: "POST" }));
    expect(revoked.status).toBe(200);
    const afterRevoke = await space.fetch(new Request("https://space/sub-spaces/dept-b/blackboard?root_space_id=root&actor_id=research-member&route_id=route-sales-research"));
    expect(afterRevoke.status).toBe(404);
  });
});
