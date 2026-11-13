import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import { app } from "../index.js";
import { CHANNEL_MEDIA_CAPABILITIES } from "./channel-media-capabilities.js";

describe("channel media capability discovery", () => {
  it("serves the shared versioned contract to a verified tenant without caching it", async () => {
    const response = await app.request("/spaces/space-a/assistant/channel-capabilities", {
      headers: {
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-role": "owner",
        "x-naelao-internal-token": await mintInternalToken("platform-secret", "tenant-a"),
      },
    }, { PLATFORM_SECRET: "platform-secret" } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(CHANNEL_MEDIA_CAPABILITIES);
  });

  it("rejects an unverified direct request", async () => {
    const response = await app.request("/spaces/space-a/assistant/channel-capabilities", {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-role": "owner" },
    }, { PLATFORM_SECRET: "platform-secret" } as never);
    expect(response.status).toBe(401);
  });
});
