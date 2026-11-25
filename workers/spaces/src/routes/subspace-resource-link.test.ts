import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { issueCapabilityToken } from "@naelao/security";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SpaceDO } from "../do/SpaceDO.js";
import spacesWorker from "../index.js";

const SECRET = "subspace-resource-link-test";
const BASE = "https://spaces.test/spaces/root/subspace-blackboard/resource?route_id=route-ab&message_id=m1";

async function fixture(flag: string | null = "true") {
  const storage = createDOStorage();
  const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: SECRET } as never);
  await space.fetch(new Request("https://space/subspace-blackboard/routes", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  const now = new Date().toISOString();
  storage.sql.exec("INSERT INTO spaces(id,parent_id,name,space_type,tenancy_mode,depth,status,settings,created_at) VALUES('root',NULL,'Company','launchpad','team',0,'active','{}',?)", now);
  for (const id of ["dept-a", "dept-b", "dept-c"]) {
    storage.sql.exec("INSERT INTO spaces(id,parent_id,name,space_type,tenancy_mode,depth,status,settings,created_at) VALUES(?,?,?,'launchpad','team',1,'active','{}',?)", id, "root", id, now);
  }
  storage.sql.exec("INSERT INTO space_members(space_id,user_id,role) VALUES('root','root-owner','owner'),('dept-a','sales-editor','editor'),('dept-b','research-member','member'),('dept-b','other-member','member')");
  storage.sql.exec(`INSERT INTO space_assistants(space_id,assistant_actor_id,parent_assistant_actor_id,hierarchy_role) VALUES
    ('root','assistant:space:root',NULL,'DIRECTOR'),('dept-a','assistant:space:dept-a','assistant:space:root','DEPARTMENT_LEAD'),
    ('dept-b','assistant:space:dept-b','assistant:space:root','DEPARTMENT_LEAD'),('dept-c','assistant:space:dept-c','assistant:space:root','DEPARTMENT_LEAD')`);
  const call = (path: string, method: string, body?: unknown) => space.fetch(new Request(`https://space${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  expect((await call("/subspace-blackboard/routes?root_space_id=root&actor_id=root-owner", "POST",
    { id: "route-ab", source_subspace_id: "dept-a", target_subspace_id: "dept-b", allowed_kinds: ["artifact", "question"], allow_reply: true })).status).toBe(201);
  const publish = await call("/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=sales-editor&resource_links=true", "POST",
    { route_id: "route-ab", id: "m1", kind: "artifact", text: "See the playbook",
      resource_ref: { type: "knowledge_document", target_space_id: "dept-c", document_id: "doc-1" } });
  expect(publish.status).toBe(201);
  expect((await call("/sub-spaces/dept-a/blackboard?root_space_id=root&actor_id=sales-editor", "POST",
    { route_id: "route-ab", id: "m2", kind: "question", text: "No link here" })).status).toBe(201);

  const expiresAt = Date.now() + 3_600_000;
  storage.sql.exec(`INSERT INTO cross_space_grants(id,grantee_space_id,target_space_id,resource_id,granted_by,created_at,expires_at)
    VALUES('grant-1','dept-b','dept-c','knowledge-document:doc-1','root-owner',?,?)`, now, new Date(expiresAt).toISOString());
  const token = await issueCapabilityToken({ granteeSpaceId: "dept-b", targetSpaceId: "dept-c", resourceId: "knowledge-document:doc-1",
    permissions: ["read"], exp: expiresAt, nonce: "grant-1" }, SECRET);
  const accept = (actor: string) => storage.sql.exec(`INSERT INTO accepted_cross_space_documents(id,grantee_space_id,target_space_id,document_id,accepted_by,capability_token,expires_at,accepted_at,revoked_at)
    VALUES(?,?,?,?,?,?,?,?,NULL)`, `acc-${actor}`, "dept-b", "dept-c", "doc-1", actor, token, new Date(expiresAt).toISOString(), now);

  const knowledge = vi.fn(async () => Response.json({ document: { id: "doc-1", title: "Playbook", source_url: null, content: "Secret plan", chunk_count: 1 } }));
  const env = {
    PLATFORM_SECRET: SECRET,
    ...(flag === null ? {} : { SUBSPACE_RESOURCE_LINKS_ENABLED: flag }),
    KNOWLEDGE_WORKER: { fetch: (request: Request) => knowledge(request) },
    SPACE_DO: { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => space.fetch(request) }) },
  } as never;
  const get = async (headers: Record<string, string>, url = BASE) => spacesWorker.fetch(new Request(url, { headers }), env);
  const userHeaders = async (user: string, tenant = "tenant-a", tokenTenant = tenant) => ({
    "x-naelao-tenant-id": tenant, "x-naelao-user-id": user, "x-naelao-role": "member", "x-naelao-internal-token": await mintInternalToken(SECRET, tokenTenant) });
  const assistantHeaders = async (agent: string) => ({
    "x-naelao-tenant-id": "tenant-a", "x-naelao-agent-id": agent, "x-naelao-internal-token": await mintInternalToken(SECRET, "tenant-a") });
  const audits = () => storage.sql.exec<{ actor_id: string; action: string; resource_id: string }>("SELECT actor_id,action,resource_id FROM cross_space_access_audit").toArray();
  return { storage, call, accept, knowledge, get, userHeaders, assistantHeaders, audits };
}

const gone = async (response: Response) => {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error_code: "resource_unavailable" });
};

describe("subspace blackboard resource resolver", () => {
  it("returns the document to the recipient with their own accepted capability and writes an audit row", async () => {
    const f = await fixture();
    f.accept("research-member");
    const response = await f.get(await f.userHeaders("research-member"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ document: { id: "doc-1", title: "Playbook", source_url: null, content: "Secret plan" } });
    expect(f.audits()).toEqual([{ actor_id: "research-member", action: "read_via_message", resource_id: "knowledge-document:doc-1" }]);
    const request = f.knowledge.mock.calls[0]![0] as Request;
    expect(new URL(request.url).pathname).toBe("/internal/spaces/dept-c/kb/documents/doc-1/shared");
    expect(request.headers.get("x-naelao-tenant-id")).toBe("tenant-a");
  });

  it("lets the recipient subspace assistant resolve with its own accepted row", async () => {
    const f = await fixture();
    f.accept("assistant:space:dept-b");
    const response = await f.get(await f.assistantHeaders("assistant:space:dept-b"));
    expect(response.status).toBe(200);
    expect(f.audits()[0]).toMatchObject({ actor_id: "assistant:space:dept-b", action: "read_via_message" });
  });

  it("returns 404 when the flag is off", async () => {
    for (const flag of [null, "false"]) {
      const f = await fixture(flag);
      f.accept("research-member");
      await gone(await f.get(await f.userHeaders("research-member")));
      expect(f.knowledge).not.toHaveBeenCalled();
    }
  });

  it("returns 404 to the sender, who is not the recipient", async () => {
    const f = await fixture();
    f.accept("research-member");
    f.accept("sales-editor");
    await gone(await f.get(await f.userHeaders("sales-editor")));
    expect(f.knowledge).not.toHaveBeenCalled();
  });

  it("returns 404 to a recipient without an accepted row even though route membership exists", async () => {
    const f = await fixture();
    f.accept("research-member");
    await gone(await f.get(await f.userHeaders("other-member")));
    expect(f.knowledge).not.toHaveBeenCalled();
  });

  it("returns 404 for a message without a resource reference or an unknown message", async () => {
    const f = await fixture();
    f.accept("research-member");
    const headers = await f.userHeaders("research-member");
    await gone(await f.get(headers, BASE.replace("message_id=m1", "message_id=m2")));
    await gone(await f.get(headers, BASE.replace("message_id=m1", "message_id=missing")));
  });

  it("returns 404 on the next fetch after the cross-space grant is revoked", async () => {
    const f = await fixture();
    f.accept("research-member");
    const headers = await f.userHeaders("research-member");
    expect((await f.get(headers)).status).toBe(200);
    f.storage.sql.exec("UPDATE cross_space_grants SET revoked_at=? WHERE id='grant-1'", new Date().toISOString());
    await gone(await f.get(headers));
    expect(f.audits()).toHaveLength(1);
  });

  it("returns 404 when the grant has expired", async () => {
    const f = await fixture();
    f.accept("research-member");
    f.storage.sql.exec("UPDATE cross_space_grants SET expires_at=? WHERE id='grant-1'", new Date(Date.now() - 1000).toISOString());
    await gone(await f.get(await f.userHeaders("research-member")));
    f.storage.sql.exec("UPDATE accepted_cross_space_documents SET expires_at=?", new Date(Date.now() - 1000).toISOString());
    await gone(await f.get(await f.userHeaders("research-member")));
    expect(f.knowledge).not.toHaveBeenCalled();
  });

  it("returns 404 once the route is revoked", async () => {
    const f = await fixture();
    f.accept("research-member");
    expect((await f.call("/subspace-blackboard/routes/route-ab/revoke?root_space_id=root&actor_id=root-owner", "POST", {})).status).toBe(200);
    await gone(await f.get(await f.userHeaders("research-member")));
  });

  it("returns 404 for another tenant's HMAC", async () => {
    const f = await fixture();
    f.accept("research-member");
    await gone(await f.get(await f.userHeaders("research-member", "tenant-a", "tenant-b")));
    expect(f.knowledge).not.toHaveBeenCalled();
  });

  it("returns 404 for an assistant identity belonging to the wrong subspace", async () => {
    const f = await fixture();
    f.accept("research-member");
    f.accept("assistant:space:dept-a");
    await gone(await f.get(await f.assistantHeaders("assistant:space:dept-a")));
    await gone(await f.get(await f.assistantHeaders("assistant:space:dept-c")));
    expect(f.knowledge).not.toHaveBeenCalled();
  });

  it("passes a Knowledge 413 through and hides every other Knowledge failure", async () => {
    const f = await fixture();
    f.accept("research-member");
    f.knowledge.mockResolvedValueOnce(Response.json({ error_code: "document_share_size_limit" }, { status: 413 }));
    const tooLarge = await f.get(await f.userHeaders("research-member"));
    expect(tooLarge.status).toBe(413);
    f.knowledge.mockResolvedValueOnce(Response.json({ error: "nope" }, { status: 404 }));
    await gone(await f.get(await f.userHeaders("research-member")));
    expect(f.audits()).toHaveLength(0);
  });
});
