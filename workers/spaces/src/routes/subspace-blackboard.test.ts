import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import spacesWorker from "../index.js";

describe("subspace blackboard routes", () => {
  function environment() {
    const forwarded: Request[] = [];
    const stub = { fetch: vi.fn(async (request: Request) => {
      forwarded.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/hierarchy-authorize") return Response.json({ permitted: true, role: "owner" });
      return Response.json({ ok: true });
    }) };
    const secret = "subspace-blackboard-route-test";
    const env = {
      PLATFORM_SECRET: secret,
      SPACE_DO: { idFromName: (name: string) => name, get: () => stub },
    } as never;
    return { env, forwarded, secret };
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
});
