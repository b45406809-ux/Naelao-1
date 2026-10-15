import { describe, expect, it } from "vitest";
import { mintOwnerVoiceTicket, verifyOwnerVoiceTicket } from "./voice-ticket.js";

describe("owner voice tickets", () => {
  const ticket = {
    tenantId: "tenant-1", spaceId: "space-1", sessionId: "session-1", userId: "user-1", role: "owner", callerRole: "owner",
    agentName: "voice-1", projectId: "project-1", expiresAt: 1_100, nonce: "12345678-1234-1234-1234-123456789abc",
  } as const;

  it("binds a short-lived signed ticket to a specific voice Agent name", async () => {
    const token = await mintOwnerVoiceTicket(ticket, "test-secret");
    await expect(verifyOwnerVoiceTicket(token, "test-secret", "voice-1", 1_000)).resolves.toEqual(ticket);
    await expect(verifyOwnerVoiceTicket(token, "wrong-secret", "voice-1", 1_000)).resolves.toBeNull();
    await expect(verifyOwnerVoiceTicket(token, "test-secret", "voice-2", 1_000)).resolves.toBeNull();
    await expect(verifyOwnerVoiceTicket(token, "test-secret", "voice-1", 1_101)).resolves.toBeNull();
  });

  it("rejects a viewer ticket and tickets with expiry beyond the five-minute ceiling", async () => {
    const viewer = await mintOwnerVoiceTicket({ ...ticket, role: "viewer" }, "test-secret");
    const tooLong = await mintOwnerVoiceTicket({ ...ticket, expiresAt: 1_301 }, "test-secret");
    await expect(verifyOwnerVoiceTicket(viewer, "test-secret", "voice-1", 1_000)).resolves.toBeNull();
    await expect(verifyOwnerVoiceTicket(tooLong, "test-secret", "voice-1", 1_000)).resolves.toBeNull();
  });
});
