import { describe, it, expect, vi } from "vitest";
import { verifyVoiceSession } from "./session-scope.js";
const scope = {
  tenantId: "tenant",
  spaceId: "space",
  userId: "user",
  role: "product_end_user",
  projectId: "project",
};
function worker(...responses: Response[]) {
  return { fetch: vi.fn(async () => responses.shift()!) } as unknown as Fetcher;
}
describe("voice conversation scope", () => {
  it("resolves project ownership through the actual conversation thread", async () => {
    const w = worker(
      Response.json({ id: "session", thread_id: "thread" }),
      Response.json({ project_id: "project", session_id: "session" })
    );
    await expect(
      verifyVoiceSession(w, "secret", scope, "session")
    ).resolves.toBeUndefined();
  });
  it("rejects other projects, inaccessible conversations and mismatched thread links", async () => {
    await expect(
      verifyVoiceSession(
        worker(Response.json({ id: "session", project_id: "other" })),
        "secret",
        scope,
        "session"
      )
    ).rejects.toThrow("voice_session_project_mismatch");
    await expect(
      verifyVoiceSession(
        worker(new Response(null, { status: 404 })),
        "secret",
        scope,
        "session"
      )
    ).rejects.toThrow("voice_session_unavailable");
    await expect(
      verifyVoiceSession(
        worker(
          Response.json({ id: "session", thread_id: "thread" }),
          Response.json({ project_id: "project", session_id: "other" })
        ),
        "secret",
        scope,
        "session"
      )
    ).rejects.toThrow("voice_session_mismatch");
  });
  it("does not let a Space assistant silently inherit a Project's tool scope", async () => {
    const { projectId, ...space } = scope;
    await expect(
      verifyVoiceSession(
        worker(Response.json({ id: "session", project_id: projectId })),
        "secret",
        space,
        "session"
      )
    ).rejects.toThrow("voice_session_project_mismatch");
  });
});
