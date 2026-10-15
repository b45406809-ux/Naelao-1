import { describe, expect, it, vi } from "vitest";
import { notifications } from "./notifications.js";
import type { PrebuiltOpContext } from "./index.js";

describe("notifications.notify.web_push", () => {
  it("uses the invoking user by default and propagates an honest no-device result", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("x-naelao-tenant-id")).toBe("tenant-a");
      return Response.json({ delivered: false, devices: 0 }, { status: 404 });
    });
    const ctx = {
      env: {
        notificationsWorker: { fetch },
        tenantId: "tenant-a", spaceId: "space-a", humanInvokerId: "user-a",
      },
    } as unknown as PrebuiltOpContext;
    const result = await notifications.operations["notify.web_push"]!({ title: "Update", message: "Ready" }, ctx);
    expect(result).toMatchObject({ delivered: false, devices: 0, channel: "web_push", status: 404 });
    const request = fetch.mock.calls[0]?.[0] as Request;
    expect(await request.json()).toMatchObject({ channel: "web_push", space_id: "space-a", user_id: "user-a", subject: "Update", message: "Ready" });
  });
});
