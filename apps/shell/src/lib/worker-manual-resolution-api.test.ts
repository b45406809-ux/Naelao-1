import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readWorkerWorkspaceConflictPreview,
  resolveWorkerWorkspaceConflict,
} from "./api";

describe("worker conflict resolution caller", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends reviewer content and the expected target hash through the authenticated session API", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ resolution: { path: "src/app.ts", status: "published" } })
    );
    vi.stubGlobal("fetch", fetch);
    await resolveWorkerWorkspaceConflict(
      "space one",
      "worker/1",
      {
        sessionToken: "session-token",
        endUserId: "reviewer",
      },
      {
        sessionId: "conversation-1",
        agentId: "planner",
        projectId: "project-1",
        path: "src/app.ts",
        expectedTargetHash: "a".repeat(64),
        expectedSourceHash: "b".repeat(64),
        content: "reviewed source\n",
        idempotencyKey: "retry-stable-1",
      }
    );

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(
      "/v1/spaces/space%20one/assistant/sub-agents/worker%2F1/workspace-conflicts/resolve"
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer session-token"
    );
    expect(JSON.parse(String(init.body))).toEqual({
      session_id: "conversation-1",
      agent_id: "planner",
      project_id: "project-1",
      path: "src/app.ts",
      expected_target_hash: "a".repeat(64),
      expected_source_hash: "b".repeat(64),
      content: "reviewed source\n",
      idempotency_key: "retry-stable-1",
    });
  });

  it("reads current target and retained-worker versions through the same authenticated scope", async () => {
    const preview = {
      path: "src/app.ts",
      target: { hash: "a".repeat(64), content: "target\n" },
      worker: { hash: "b".repeat(64), content: "worker\n" },
      stale: false,
    };
    const fetch = vi.fn(async () => Response.json({ preview }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      readWorkerWorkspaceConflictPreview(
        "space one",
        "worker/1",
        { sessionToken: "session-token", endUserId: "reviewer" },
        {
          sessionId: "conversation-1",
          agentId: "planner",
          projectId: "project-1",
          path: "src/app.ts",
        }
      )
    ).resolves.toEqual({ preview });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/workspace-conflicts/preview?");
    expect(url).toContain("session_id=conversation-1");
    expect(url).toContain("project_id=project-1");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer session-token"
    );
  });
});
