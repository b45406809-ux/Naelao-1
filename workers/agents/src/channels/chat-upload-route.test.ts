import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import { app } from "../index.js";

const secret = "chat-upload-route-secret";

function makeEnv(scopeResponses: (request: Request) => Response) {
  const r2Calls: string[] = [];
  const writes: Array<{ key: string; bytes: Uint8Array }> = [];
  const env = {
    PLATFORM_SECRET: secret,
    SPACES_WORKER: {
      async fetch(request: Request) {
        return scopeResponses(request);
      },
    },
    SCRIPTS_R2: {
      async get(key: string) {
        r2Calls.push(`get:${key}`);
        return null;
      },
      async put(key: string, value: Uint8Array) {
        r2Calls.push(`put:${key}`);
        writes.push({ key, bytes: value.slice() });
        return { etag: "etag-1" };
      },
      async head(key: string) {
        r2Calls.push(`head:${key}`);
        return null;
      },
    },
  };
  return { env: env as never, r2Calls, writes };
}

async function postUpload(env: never, projectId?: string, addFile = false) {
  const form = new FormData();
  if (projectId) form.append("project_id", projectId);
  if (addFile)
    form.append(
      "files",
      new Blob(["safe attachment"], { type: "text/plain" }),
      "brief.txt"
    );
  return app.request(
    "/spaces/space-a/sessions/session-a/uploads",
    {
      method: "POST",
      headers: {
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-user-id": "user-a",
        "x-naelao-role": "product_end_user",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
      },
      body: form,
    },
    env
  );
}

describe("chat upload route scope enforcement", () => {
  it("rejects an inaccessible session before touching R2", async () => {
    const state = makeEnv(() => new Response(null, { status: 404 }));
    const response = await postUpload(state.env);
    expect(response.status).toBe(404);
    expect(state.r2Calls).toEqual([]);
  });

  it("rejects a multipart project prefix that conflicts with the linked session", async () => {
    const state = makeEnv((request) =>
      new URL(request.url).pathname.endsWith("compact-scope")
        ? Response.json({
            project_id: "project-canonical",
            owned_by_caller: true,
            private_scratchpad: false,
          })
        : Response.json({ id: "project-canonical" })
    );
    const response = await postUpload(state.env, "project-other");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "session_upload_project_scope_mismatch",
    });
    expect(state.r2Calls).toEqual([]);
  });

  it("writes a valid upload only to the SpaceDO-linked project prefix", async () => {
    const state = makeEnv((request) =>
      new URL(request.url).pathname.endsWith("compact-scope")
        ? Response.json({
            project_id: "project-canonical",
            owned_by_caller: true,
            private_scratchpad: false,
          })
        : Response.json({ id: "project-canonical" })
    );
    const response = await postUpload(state.env, undefined, true);
    expect(response.status).toBe(201);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]?.key).toBe(
      "spaces/space-a/projects/project-canonical/workspace/uploads/session-a/brief.txt"
    );
    expect(new TextDecoder().decode(state.writes[0]?.bytes)).toBe(
      "safe attachment"
    );
  });
});
