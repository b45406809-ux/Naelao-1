import { describe, it, expect } from "vitest";
import { verifyHeartbeatSession } from "./heartbeat-scope.js";
const worker = (metadata: unknown) =>
  ({
    fetch: async () => Response.json({ id: "session", metadata }),
  }) as unknown as Fetcher;
describe("heartbeat separation", () => {
  it.each([undefined, "project"])(
    "requires a dedicated persisted heartbeat for scope %s",
    async (project) => {
      await expect(
        verifyHeartbeatSession(
          worker({
            session_kind: "heartbeat",
            ...(project ? { project_id: project } : {}),
          }),
          "secret",
          "tenant",
          "space",
          "session",
          project
        )
      ).resolves.toBeUndefined();
    }
  );
  it("rejects voice/chat sessions and other project heartbeats", async () => {
    await expect(
      verifyHeartbeatSession(
        worker({ session_kind: "conversation" }),
        "secret",
        "tenant",
        "space",
        "session"
      )
    ).rejects.toThrow();
    await expect(
      verifyHeartbeatSession(
        worker({ session_kind: "heartbeat", project_id: "other" }),
        "secret",
        "tenant",
        "space",
        "session",
        "project"
      )
    ).rejects.toThrow();
  });
});
