import { describe, expect, it } from "vitest";
import type { PrebuiltOpContext } from "./index.js";
import { commerce } from "./commerce.js";

describe("commerce.seat_checkout identity", () => {
  it("defaults to the host-resolved signed-in Naelao user id", async () => {
    let sent: Request | undefined;
    const ctx = {
      env: {
        tenantId: "tenant-1",
        spaceId: "space-1",
        userId: "user-verified-1",
        platformSecret: "platform-secret",
        billingWorker: {
          fetch: async (request: Request) => { sent = request; return Response.json({ checkout_url: "https://checkout.example/seat" }); },
        },
      },
    } as unknown as PrebuiltOpContext;

    await commerce.operations["commerce.seat_checkout"]!({}, ctx);
    expect(sent?.url).toBe("http://billing-worker/internal/seats/checkout");
    expect(await sent!.json()).toMatchObject({ space_id: "space-1", user_id: "user-verified-1" });
  });

  it("uses an explicitly provided Naelao user id when supplied", async () => {
    let sent: Request | undefined;
    const ctx = {
      env: {
        tenantId: "tenant-1", spaceId: "space-1", userId: "user-current", platformSecret: "platform-secret",
        billingWorker: { fetch: async (request: Request) => { sent = request; return Response.json({ checkout_url: "https://checkout.example/seat" }); } },
      },
    } as unknown as PrebuiltOpContext;
    await commerce.operations["commerce.seat_checkout"]!({ user_id: "user-gift-recipient" }, ctx);
    expect(await sent!.json()).toMatchObject({ user_id: "user-gift-recipient" });
  });
});
