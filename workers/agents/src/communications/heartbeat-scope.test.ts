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
      ).resolves.toEqual({});
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
  it("binds a scheduled wake to its persisted service identity and job revision", async () => {
    const identity = { id: "scheduled_job:job-1", authorizationRevision: "2026-11-17T12:00:00.000Z" };
    await expect(verifyHeartbeatSession(worker({ session_kind: "heartbeat", project_id: "project",
      service_identity_id: identity.id, authorization_revision: identity.authorizationRevision }),
      "secret", "tenant", "space", "session", "project", identity)).resolves.toEqual({ serviceIdentity: identity });
    await expect(verifyHeartbeatSession(worker({ session_kind: "heartbeat", project_id: "project",
      service_identity_id: "scheduled_job:other", authorization_revision: identity.authorizationRevision }),
      "secret", "tenant", "space", "session", "project", identity)).rejects.toThrow();
  });
  it("rejects malformed persisted service identity metadata rather than resuming as a user run", async () => {
    await expect(verifyHeartbeatSession(worker({ session_kind: "heartbeat", project_id: "project",
      service_identity_id: "unknown-service", authorization_revision: "revision" }),
      "secret", "tenant", "space", "session", "project")).rejects.toThrow("heartbeat_session_service_identity_invalid");
  });
});
