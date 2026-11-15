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
        validationCommand: "pnpm test",
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
      validation_command: "pnpm test",
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

  it("sends a binary version choice by side and hashes without sending file bytes", async () => {
    const fetch = vi.fn(async () => Response.json({ resolution: { path: "assets/icon.png", status: "published" } }));
    vi.stubGlobal("fetch", fetch);
    await resolveWorkerWorkspaceConflict("space one", "worker/1", {
      sessionToken: "session-token", endUserId: "reviewer",
    }, {
      sessionId: "conversation-1", projectId: "project-1", path: "assets/icon.png",
      expectedTargetHash: "a".repeat(64), expectedSourceHash: "b".repeat(64), content: null, copyFrom: "worker",
      idempotencyKey: "retry-binary-1", validationCommand: "pnpm test",
    });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      path: "assets/icon.png", expected_target_hash: "a".repeat(64), expected_source_hash: "b".repeat(64),
      content: null, copy_from: "worker", idempotency_key: "retry-binary-1",
    });
    expect(String(init.body)).not.toContain("base64");
  });
});
