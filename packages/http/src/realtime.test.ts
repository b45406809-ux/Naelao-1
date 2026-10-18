import { describe, expect, it, vi } from "vitest";
import { broadcastSpaceEvent } from "./realtime.js";

describe("best-effort realtime broadcasts", () => {
  it("sends scoped event data to the gateway and ignores HTTP failures", async () => {
    const fetch = vi.fn(
      async (_input: Request | string, _init?: RequestInit) =>
        new Response("unavailable", { status: 503 })
    );
    await expect(
      broadcastSpaceEvent(
        { WS_GATEWAY: { fetch }, PLATFORM_SECRET: "platform-secret" },
        "tenant-1",
        "space-1",
        "project.updated",
        { projectId: "project-1" }
      )
    ).resolves.toBeUndefined();
    const [request] = fetch.mock.calls[0] ?? [];
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).headers.get("x-naelao-tenant-id")).toBe(
      "tenant-1"
    );
    expect((request as Request).headers.get("x-naelao-platform-secret")).toBe(
      "platform-secret"
    );
    await expect((request as Request).json()).resolves.toEqual({
      spaceId: "space-1",
      event: "project.updated",
      data: { projectId: "project-1" },
    });
  });

  it("no-ops without a binding or scope and swallows network errors", async () => {
    const fetch = vi.fn(
      async (_input: Request | string, _init?: RequestInit) => {
        throw new Error("network failure");
      }
    );
    await broadcastSpaceEvent(
      { PLATFORM_SECRET: "secret" },
      "tenant-1",
      "space-1",
      "x",
      {}
    );
    await broadcastSpaceEvent(
      { WS_GATEWAY: { fetch }, PLATFORM_SECRET: "secret" },
      "",
      "space-1",
      "x",
      {}
    );
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      broadcastSpaceEvent(
        { WS_GATEWAY: { fetch }, PLATFORM_SECRET: "secret" },
        "tenant-1",
        "space-1",
        "x",
        {}
      )
    ).resolves.toBeUndefined();
  });
});
