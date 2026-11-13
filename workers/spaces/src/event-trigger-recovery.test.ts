import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import spacesWorker from "./index.js";

describe("event trigger restore recovery control", () => {
  it("requires an admin Space role and project-management access before re-enabling a trigger", async () => {
    let memberRole = "member";
    const forwarded: Request[] = [];
    const spaceStub = { fetch: vi.fn(async (request: Request) => {
      forwarded.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/event-triggers") return Response.json({ data: [{ id: "trigger-1", project_id: "project-1", enabled: false }] });
      if (url.pathname === "/projects/project-1/automation-access") return Response.json({ allowed: true });
      if (url.pathname === "/event-triggers/trigger-1") return Response.json({ id: "trigger-1", enabled: true, updated_by: "admin-1" });
      return Response.json({ error_code: "not_found" }, { status: 404 });
    }) };
    const env = {
      PLATFORM_SECRET: "trigger-recovery-secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ role: memberRole }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name, get: () => spaceStub },
    } as never;
    const token = await mintInternalToken("trigger-recovery-secret", "tenant-1");
    const request = () => new Request("https://spaces.test/spaces/space-1/event-triggers/trigger-1", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-1",
        "x-naelao-user-id": "admin-1",
        "x-naelao-role": "product_end_user",
        "x-naelao-internal-token": token,
      },
      body: JSON.stringify({ enabled: true }),
    });

    const member = await spacesWorker.fetch(request(), env);
    expect(member.status).toBe(403);
    expect(spaceStub.fetch).not.toHaveBeenCalled();

    memberRole = "admin";
    const admin = await spacesWorker.fetch(request(), env);
    expect(admin.status).toBe(200);
    expect(forwarded.map(item => new URL(item.url).pathname)).toEqual([
      "/event-triggers",
      "/projects/project-1/automation-access",
      "/event-triggers/trigger-1",
    ]);
    expect(JSON.parse(await forwarded[2]!.text())).toEqual({ enabled: true, actor_id: "admin-1" });
  });
});
