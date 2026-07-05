import { describe, it, expect } from "vitest";
import { broadcastSpaceEvent } from "@naelao/http";

// §A1.17 Phase V: broadcastSpaceEvent is the one shared helper every natural mutation point
// (project created/updated, thread lock transitions, agent run lifecycle,
// approval.requested/resolved) calls to fan a live event out to WsHubDO's connected clients.
// Best-effort by design — must never throw, regardless of what goes wrong.

function fetcherOf(handler: (req: Request) => Promise<Response> | Response): { fetch: (input: Request | string, init?: RequestInit) => Promise<Response> } {
  return { fetch: async (input: Request | string, init?: RequestInit) => {
    const req = typeof input === "string" ? new Request(input, init) : input;
    return handler(req);
  } };
}

describe("broadcastSpaceEvent", () => {
  it("POSTs to /broadcast with the tenant header, platform secret header, and the event payload", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: unknown = null;
    const env = {
      WS_GATEWAY: fetcherOf(async (req) => {
        seenUrl = req.url;
        req.headers.forEach((v, k) => { seenHeaders[k] = v; });
        seenBody = await req.json();
        return Response.json({ ok: true, sent: 1 });
      }),
      PLATFORM_SECRET: "test-secret",
    };

    await broadcastSpaceEvent(env, "tenant-1", "space-1", "project.created", { project_id: "p1" });

    expect(seenUrl).toBe("http://ws-gateway/broadcast");
    expect(seenHeaders["x-naelao-tenant-id"]).toBe("tenant-1");
    expect(seenHeaders["x-naelao-platform-secret"]).toBe("test-secret");
    expect(seenBody).toEqual({ spaceId: "space-1", event: "project.created", data: { project_id: "p1" } });
  });

  it("is a silent no-op when WS_GATEWAY isn't bound", async () => {
    const env = { PLATFORM_SECRET: "s" };
    await expect(broadcastSpaceEvent(env, "tenant-1", "space-1", "project.created", {})).resolves.toBeUndefined();
  });

  it("is a silent no-op when tenantId or spaceId is empty", async () => {
    let called = false;
    const env = { WS_GATEWAY: fetcherOf(() => { called = true; return Response.json({ ok: true }); }), PLATFORM_SECRET: "s" };
    await broadcastSpaceEvent(env, "", "space-1", "x", {});
    await broadcastSpaceEvent(env, "tenant-1", "", "x", {});
    expect(called).toBe(false);
  });

  it("never throws even when the WS_GATEWAY call fails", async () => {
    const env = { WS_GATEWAY: fetcherOf(() => { throw new Error("network down"); }), PLATFORM_SECRET: "s" };
    await expect(broadcastSpaceEvent(env, "tenant-1", "space-1", "x", {})).resolves.toBeUndefined();
  });

  it("never throws even when the WS_GATEWAY call returns a non-ok response", async () => {
    const env = { WS_GATEWAY: fetcherOf(() => new Response(null, { status: 500 })), PLATFORM_SECRET: "s" };
    await expect(broadcastSpaceEvent(env, "tenant-1", "space-1", "x", {})).resolves.toBeUndefined();
  });
});
