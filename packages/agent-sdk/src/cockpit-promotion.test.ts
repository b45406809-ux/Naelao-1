import { describe, expect, it } from "vitest";
import { promoteCockpit } from "./cockpit-promotion.js";

describe("solo cockpit promotion", () => {
  it("promotes once without changing existing conversation or artifact identities", () => {
    const state = {
      mode: "solo_cockpit" as const,
      promotionVersion: 0,
      promotedAt: null,
      promotedBy: null,
    };
    const existing = {
      threadIds: ["chat-1", "task-1"],
      messageIds: ["message-1", "message-2"],
      artifactIds: ["artifact-1"],
    };
    const promoted = promoteCockpit(state, "user-1", "2026-10-08T10:00:00.000Z");
    const repeated = promoteCockpit(promoted, "user-2", "2026-10-08T11:00:00.000Z");

    expect(promoted).toEqual({
      mode: "multiplayer_office",
      promotionVersion: 1,
      promotedAt: "2026-10-08T10:00:00.000Z",
      promotedBy: "user-1",
    });
    expect(repeated).toEqual(promoted);
    expect(existing).toEqual({
      threadIds: ["chat-1", "task-1"],
      messageIds: ["message-1", "message-2"],
      artifactIds: ["artifact-1"],
    });
  });
});
