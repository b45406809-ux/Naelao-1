import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import spacesWorker from "../index.js";

describe("subspace blackboard routes", () => {
  function environment() {
    const forwarded: Request[] = [];
    const names: string[] = [];
    const stub = { fetch: vi.fn(async (request: Request) => {
      forwarded.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/hierarchy-authorize") return Response.json({ permitted: true, role: "owner" });
      return Response.json({ ok: true });
    }) };
    const secret = "subspace-blackboard-route-test";
    const env = {
      PLATFORM_SECRET: secret,
      SPACE_DO: { idFromName: (name: string) => { names.push(name); return name; }, get: () => stub },
    } as never;
    return { env, forwarded, names, secret };
  }

  const headers = (secret: string) => ({
    "content-type": "application/json",
    "x-naelao-internal-token": "token-placeholder",
    "x-naelao-tenant-id": "tenant-a",
    "x-naelao-user-id": "authenticated-owner",
    "x-naelao-role": "owner",
  });

  it("derives route actor and parent from authenticated path, then checks both memberships", async () => {
    const { env, forwarded, secret } = environment();
    const requestHeaders = { ...headers(secret), "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/root/subspace-blackboard/routes", {
      method: "POST", headers: requestHeaders,
      body: JSON.stringify({ id: "route-1", source_subspace_id: "dept-a", target_subspace_id: "dept-b", allowed_kinds: ["question"], allow_reply: true, actor_id: "forged" }),
    }), env);
    expect(response.status).toBe(200);
    expect(forwarded.filter(request => new URL(request.url).pathname === "/hierarchy-authorize")).toHaveLength(2);
    const write = forwarded.find(request => new URL(request.url).pathname === "/subspace-blackboard/routes")!;
    expect(new URL(write.url).searchParams.get("root_space_id")).toBe("root");
    expect(new URL(write.url).searchParams.get("actor_id")).toBe("authenticated-owner");
    expect(await write.json()).toMatchObject({ id: "route-1", source_subspace_id: "dept-a", target_subspace_id: "dept-b" });
  });

  it("does not forward grant or board requests when hierarchy membership is denied", async () => {
    const { env, forwarded, secret } = environment();
    const stub = (env as { SPACE_DO: { get: () => { fetch: (request: Request) => Promise<Response> } } }).SPACE_DO.get();
    stub.fetch = vi.fn(async request => {
      forwarded.push(request);
      return Response.json({ permitted: new URL(request.url).searchParams.get("target_space_id") !== "dept-b", role: "member" });
    });
    const requestHeaders = { ...headers(secret), "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const grant = await spacesWorker.fetch(new Request("https://spaces.test/spaces/root/subspace-blackboard/routes", {
      method: "POST", headers: requestHeaders,
      body: JSON.stringify({ id: "route-1", source_subspace_id: "dept-a", target_subspace_id: "dept-b", allowed_kinds: ["question"], allow_reply: false }),
    }), env);
    expect(grant.status).toBe(404);
    expect(forwarded.some(request => new URL(request.url).pathname === "/subspace-blackboard/routes")).toBe(false);

    const board = await spacesWorker.fetch(new Request("https://spaces.test/spaces/root/sub-spaces/dept-b/blackboard?route_id=route-1", { headers: requestHeaders }), env);
    expect(board.status).toBe(404);
    expect(forwarded.some(request => new URL(request.url).pathname === "/sub-spaces/dept-b/blackboard")).toBe(false);
  });

  it("lists routes only after checking the authenticated member on that subspace", async () => {
    const { env, forwarded, secret } = environment();
    const requestHeaders = { ...headers(secret), "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/root/subspace-blackboard/routes?subspace_id=dept-a", { headers: requestHeaders }), env);
    expect(response.status).toBe(200);
    const request = forwarded.find(item => new URL(item.url).pathname === "/subspace-blackboard/routes")!;
    expect(new URL(request.url).searchParams.get("subspace_id")).toBe("dept-a");
    expect(new URL(request.url).searchParams.get("actor_id")).toBe("authenticated-owner");
  });

  it("requires an internal token for assistant calls and forwards only the host actor identity", async () => {
    const { env, forwarded, secret } = environment();
    const base = "https://spaces.test/internal/spaces/root/sub-spaces/dept-a/blackboard";
    const denied = await spacesWorker.fetch(new Request(`${base}?route_id=route-1`, {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-agent-id": "assistant:space:dept-a" },
    }), env);
    expect(denied.status).toBe(403);
    expect(forwarded).toHaveLength(0);

    const token = await mintInternalToken(secret, "tenant-a");
    const crossTenant = await spacesWorker.fetch(new Request(`${base}?route_id=route-1`, {
      headers: { "x-naelao-tenant-id": "tenant-b", "x-naelao-agent-id": "assistant:space:dept-a", "x-naelao-internal-token": token },
    }), env);
    expect(crossTenant.status).toBe(403);
    const response = await spacesWorker.fetch(new Request(`${base}?route_id=route-1`, {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-agent-id": "assistant:space:dept-a", "x-naelao-internal-token": token },
    }), env);
    expect(response.status).toBe(200);
    const read = forwarded[0]!;
    expect(new URL(read.url).searchParams.get("actor_id")).toBe("assistant:space:dept-a");

    const publish = await spacesWorker.fetch(new Request(base, {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a",
        "x-naelao-agent-id": "assistant:space:dept-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ route_id: "route-1", id: "msg-1", kind: "question", text: "Please check" }),
    }), env);
    expect(publish.status).toBe(200);
    expect(new URL(forwarded[1]!.url).searchParams.get("actor_id")).toBe("assistant:space:dept-a");
    expect(await forwarded[1]!.json()).toMatchObject({ id: "msg-1", route_id: "route-1" });
  });

  it("forwards bounded fan-out only after user membership or internal assistant authentication", async () => {
    const { env, forwarded, secret } = environment();
    const userHeaders = { ...headers(secret), "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const userResponse = await spacesWorker.fetch(new Request("https://spaces.test/spaces/root/sub-spaces/dept-a/blackboard/broadcast", {
      method: "POST", headers: userHeaders,
      body: JSON.stringify({ id: "fanout-1", route_ids: ["r-b", "r-c"], kind: "finding", text: "Ready" }),
    }), env);
    expect(userResponse.status).toBe(200);
    const userWrite = forwarded.find(request => new URL(request.url).pathname === "/sub-spaces/dept-a/blackboard/broadcast")!;
    expect(new URL(userWrite.url).searchParams.get("actor_id")).toBe("authenticated-owner");

    const base = "https://spaces.test/internal/spaces/root/sub-spaces/dept-a/blackboard/broadcast";
    const denied = await spacesWorker.fetch(new Request(base, { method: "POST", headers: {
      "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-agent-id": "assistant:space:dept-a",
    }, body: JSON.stringify({ id: "fanout-2", route_ids: ["r-b", "r-c"], kind: "finding", text: "Ready" }) }), env);
    expect(denied.status).toBe(403);
    const assistant = await spacesWorker.fetch(new Request(base, { method: "POST", headers: {
      "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-agent-id": "assistant:space:dept-a",
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
    }, body: JSON.stringify({ id: "fanout-2", route_ids: ["r-b", "r-c"], kind: "finding", text: "Ready" }) }), env);
    expect(assistant.status).toBe(200);
    const assistantWrite = forwarded.filter(request => new URL(request.url).pathname === "/sub-spaces/dept-a/blackboard/broadcast").at(-1)!;
    expect(new URL(assistantWrite.url).searchParams.get("actor_id")).toBe("assistant:space:dept-a");
    expect(await assistantWrite.json()).toMatchObject({ id: "fanout-2", route_ids: ["r-b", "r-c"] });
  });

  it("keeps identical Space and actor IDs in separate tenant Durable Objects", async () => {
    const { env, names, secret } = environment();
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/root/subspace-blackboard/routes?subspace_id=dept-a", {
        headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-user-id": "same-user",
          "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, tenantId) },
      }), env);
      expect(response.status).toBe(200);
    }
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/:space:root$/);
    expect(names[1]).toMatch(/:space:root$/);
    expect(names[0]).not.toBe(names[1]);
  });

  it("passes the resource-links flag from the worker env, never from the caller", async () => {
    for (const flag of [undefined, "true"]) {
      const { env, forwarded, secret } = environment();
      (env as { SUBSPACE_RESOURCE_LINKS_ENABLED?: string }).SUBSPACE_RESOURCE_LINKS_ENABLED = flag;
      const requestHeaders = { ...headers(secret), "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
      const ref = { type: "knowledge_document", target_space_id: "dept-a", document_id: "doc-1" };
      await spacesWorker.fetch(new Request("https://spaces.test/spaces/root/sub-spaces/dept-a/blackboard?resource_links=true", {
        method: "POST", headers: requestHeaders,
        body: JSON.stringify({ route_id: "r1", id: "m1", kind: "artifact", text: "Doc", resource_ref: ref }),
      }), env);
      const write = forwarded.find(request => new URL(request.url).pathname === "/sub-spaces/dept-a/blackboard")!;
      expect(new URL(write.url).searchParams.get("resource_links")).toBe(flag === "true" ? "true" : "false");
      expect(await write.json()).toMatchObject({ resource_ref: ref });
    }
  });
  it("serves subspace route proposals on static paths and derives actor and parent from the session", async () => {
    const { env, forwarded, secret } = environment();
    const requestHeaders = { ...headers(secret), "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const list = await spacesWorker.fetch(new Request("https://spaces.test/spaces/root/subspace-route-proposals", { headers: requestHeaders }), env);
    expect(list.status).toBe(200);
    const listed = new URL(forwarded.at(-1)!.url);
    expect(listed.pathname).toBe("/subspace-route-proposals");
    expect(listed.searchParams.get("root_space_id")).toBe("root");
    expect(listed.searchParams.get("actor_id")).toBe("authenticated-owner");
    const decide = await spacesWorker.fetch(new Request("https://spaces.test/spaces/root/subspace-route-proposals/decide", {
      method: "POST", headers: requestHeaders, body: JSON.stringify({ id: "srp_1", decision: "approve", route_id: "route-1", actor_id: "forged" }) }), env);
    expect(decide.status).toBe(200);
    const sent = forwarded.at(-1)!;
    expect(new URL(sent.url).searchParams.get("actor_id")).toBe("authenticated-owner");
    expect(await sent.json()).toEqual({ id: "srp_1", decision: "approve", route_id: "route-1" });
    const before = forwarded.length;
    for (const body of [{ id: "srp_1", decision: "maybe" }, { id: "srp_1", decision: "approve" }, { decision: "dismiss" }])
      expect((await spacesWorker.fetch(new Request("https://spaces.test/spaces/root/subspace-route-proposals/decide", { method: "POST", headers: requestHeaders, body: JSON.stringify(body) }), env)).status).toBe(400);
    expect(forwarded.length).toBe(before);
    const anonymous = await spacesWorker.fetch(new Request("https://spaces.test/spaces/root/subspace-route-proposals"), env);
    expect(anonymous.status).toBe(401);
  });
});
