import { describe, it, expect } from "vitest";
import {
  fixture,
  scope,
  incoming,
} from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity } from "./core.js";
import { hashEmailAddress } from "../channels/cloudflare-email.js";
import { receiveAssistantEmail } from "./inbound.js";
import { consumeVerification } from "./verification.js";
import type { BrowserRuntimeScope } from "@naelao/agent-sdk";
const browser: BrowserRuntimeScope = {
  tenantId: "tenant",
  spaceId: "space",
  actorId: "user",
  agentId: "worker",
  runId: "run",
  sessionId: "session",
  connectionId: "connection",
  expiresAt: Date.now() + 60000,
  maxTier: 5,
  authorizedOrigins: ["https://example.com"],
  authorizedActions: ["type"],
};
async function waiting(kind = "code") {
  const f = fixture(),
    identity = await ensureIdentity(f.env, scope),
    address = identity.email_address!.replace("@", "+v-account@");
  await f.db
    .prepare(
      "INSERT INTO assistant_verification_waits(id,identity_id,tenant_id,space_id,actor_id,run_id,connection_id,kind,address_hash,sender_hosts_json,origins_json,expires_at) VALUES('wait',?,'tenant','space','user','run','connection',?,?,?, ?,?)"
    )
    .bind(
      identity.id,
      kind,
      await hashEmailAddress(address),
      '["example.com"]',
      '["https://example.com"]',
      new Date(Date.now() + 60000).toISOString()
    )
    .run();
  return { ...f, identity, address };
}
describe("private website verification", () => {
  it("redacts codes from inbox bodies and consumes them exactly once for the correct browser", async () => {
    const f = await waiting();
    await receiveAssistantEmail(
      incoming(
        f.address,
        "123456 is your verification code",
        "verify-1",
        "Code: 123456"
      ),
      f.env
    );
    expect([...f.objects.values()].join("")).not.toContain("123456");
    expect(
      (
        await f.db
          .prepare("SELECT subject FROM assistant_communication_messages")
          .first<{ subject: string }>()
      )?.subject
    ).toBe("[Website verification]");
    await expect(
      consumeVerification(
        f.env,
        { ...browser, actorId: "other" },
        "wait",
        "action",
        "code"
      )
    ).rejects.toThrow();
    expect(
      await consumeVerification(f.env, browser, "wait", "action", "code")
    ).toBe("123456");
    await expect(
      consumeVerification(f.env, browser, "wait", "other-action", "code")
    ).rejects.toThrow();
  });
  it("requires the expected sender and refuses ambiguous codes", async () => {
    const f = await waiting();
    await f.db
      .prepare(
        "UPDATE assistant_verification_waits SET sender_hosts_json='[\"different.example\"]'"
      )
      .bind()
      .run();
    const message = incoming(
      f.address,
      "Verification",
      "verify-2",
      "Code: 123456"
    );
    await receiveAssistantEmail(message, f.env);
    expect(message.setReject).toHaveBeenCalled();
    await f.db
      .prepare(
        "UPDATE assistant_verification_waits SET sender_hosts_json='[\"example.com\"]'"
      )
      .bind()
      .run();
    await receiveAssistantEmail(
      incoming(
        f.address,
        "Verification",
        "verify-3",
        "Codes: 123456 and 987654"
      ),
      f.env
    );
    expect(
      (
        await f.db
          .prepare("SELECT status FROM assistant_verification_waits")
          .first<{ status: string }>()
      )?.status
    ).toBe("ambiguous");
  });
  it("does not redeem links outside authorized origins or as a code", async () => {
    const f = await waiting("link");
    await receiveAssistantEmail(
      incoming(
        f.address,
        "Verify",
        "verify-4",
        "https://attacker.example/confirm?token=secret"
      ),
      f.env
    );
    await expect(
      consumeVerification(f.env, browser, "wait", "action", "link")
    ).rejects.toThrow();
  });
  it("privately redeems a matching confirmation link", async () => {
    const f = await waiting("link");
    const link = "https://example.com/confirm?token=private-secret";
    await receiveAssistantEmail(
      incoming(f.address, "Verify", "verify-5", link),
      f.env
    );
    await expect(
      consumeVerification(f.env, browser, "wait", "action", "code")
    ).rejects.toThrow();
    expect(
      await consumeVerification(f.env, browser, "wait", "action", "link")
    ).toBe(link);
  });
});
