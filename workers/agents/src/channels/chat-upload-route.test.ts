import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import { app } from "../index.js";

const secret = "chat-upload-route-secret";

function makeEnv(scopeResponses: (request: Request) => Response) {
  const r2Calls: string[] = [];
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
      async put(key: string) {
        r2Calls.push(`put:${key}`);
        return {};
      },
      async head(key: string) {
        r2Calls.push(`head:${key}`);
        return null;
      },
    },
  };
  return { env: env as never, r2Calls };
}

async function postUpload(env: never, projectId?: string) {
  const form = new FormData();
  if (projectId) form.append("project_id", projectId);
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
});
