import { afterEach, describe, expect, it, vi } from "vitest";
import { queue } from "./index.js";

function env(apnsHost?: string) {
  return {
    ENVIRONMENT: "test",
    RESEND_API_KEY: "resend",
    WEBHOOK_SIGNING_SECRET: "secret",
    APNS_KEY_ID: "key-id",
    APNS_TEAM_ID: "team-id",
    APNS_PRIVATE_KEY_BASE64: "not-used-for-rejected-input",
    APNS_BUNDLE_ID: "com.example.app",
    ...(apnsHost ? { APNS_HOST: apnsHost } : {}),
    PLATFORM_DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ status: "active" }) }) }),
    },
  } as never;
}

describe("APNs destination boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["path injection", "A".repeat(64) + "?host=attacker.example", undefined],
    ["unapproved host", "A".repeat(64), "attacker.example"],
  ])("rejects APNs %s configuration and retries without network access", async (_name, deviceToken, host) => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const ack = vi.fn();
    const retry = vi.fn();

    await queue({ messages: [{
      id: "push-boundary",
      body: { type: "push", tenantId: "tenant-a", deviceToken, title: "Alert", body: "Hello" },
      ack,
      retry,
    }] } as never, env(host));

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
    expect(outbound).not.toHaveBeenCalled();
  });
});
