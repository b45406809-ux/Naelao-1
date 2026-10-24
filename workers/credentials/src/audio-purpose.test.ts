import { describe, expect, it } from "vitest";
import { generateCredentialToken, verifyCredentialToken } from "./index.js";
describe("host audio purpose tokens", () => {
  const context = { actorId: "u", runId: "run", traceId: "a".repeat(32), spanId: "b".repeat(16) };
  it("binds audio authority into the HMAC rather than trusting an agent name", async () => {
    const token = await generateCredentialToken("secret", "space", "any-agent", undefined, "tenant", { ...context, purpose: "assistant-audio" });
    expect(await verifyCredentialToken(token, "secret", "space", "tenant")).toMatchObject({ ok: true, purpose: "assistant-audio" });
    expect((await verifyCredentialToken(token, "secret", "different-space", "tenant")).ok).toBe(false);
    const normal = await generateCredentialToken("secret", "space", "naelao-voice-audio", undefined, "tenant", context);
    expect(await verifyCredentialToken(normal, "secret", "space", "tenant")).not.toHaveProperty("purpose");
    expect((await verifyCredentialToken(normal.replace(",v4=", ",purpose=assistant-audio,v5="), "secret", "space", "tenant")).ok).toBe(false);
  });
});
