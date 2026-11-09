import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "../index.js";

const secret = "attachment-copy-secret";
const attachment = { object_key: "spaces/space-a/email-inbound/private.pdf", filename: "private.pdf", mime_type: "application/pdf", size_bytes: 4 };

function makeEnv(options: { owned?: boolean; claimAllowed?: boolean; destinationExists?: boolean; sourceSize?: number; unified?: boolean } = {}) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let sourceRead = 0;
  let sourceBytesRead = 0;
  const destinationWrites: Array<{ key: string; bytes: ArrayBuffer }> = [];
  const coordinatorCalls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const sessionId = `ws_${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`;
  const env = {
    PLATFORM_SECRET: secret,
    ...(options.unified ? { UNIFIED_WORKSPACE_ENABLED: "true", WORKSPACE_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ async fetch(request: Request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() as Record<string, unknown> : undefined;
      coordinatorCalls.push({ path: url.pathname, body });
      if (url.pathname === "/v1/head") return Response.json({ head: { revision: 5 } });
      if (url.pathname === "/v1/open") return Response.json({ session: { id: sessionId, fence: 0 }, head: { revision: 5 } });
      if (url.pathname === "/v1/checkpoint") return Response.json({ publication: { status: "published", revision: 6 } });
      return Response.json({ ok: true });
    } }) } } : {}),
    PLATFORM_DB: {
      prepare(sql: string) {
        return { bind(...values: unknown[]) {
          queries.push({ sql, values });
          return {
            async first() {
              if (sql.includes("FROM channel_attachments")) return options.owned === false ? null : attachment;
              if (sql.includes("FROM spaces")) return { status: "active" };
              return null;
            },
            async run() { return { meta: { changes: options.claimAllowed === false ? 0 : 1 } }; },
          };
        } };
      },
    },
    SCRIPTS_R2: {
      async head() { return options.destinationExists ? {} : null; },
      async get(key: string) { sourceRead++; expect(key).toBe(attachment.object_key); return { size: options.sourceSize ?? attachment.size_bytes, arrayBuffer: async () => { sourceBytesRead++; return new Uint8Array([1, 2, 3, 4]).buffer; } }; },
      async put(key: string, bytes: Uint8Array) { destinationWrites.push({ key, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }); return { etag: "created" }; },
    },
  };
  return { env: env as never, queries, sourceRead: () => sourceRead, sourceBytesRead: () => sourceBytesRead, destinationWrites, coordinatorCalls };
}

async function copy(env: never, body: Record<string, unknown>) {
  return app.request("/internal/attachments/copy", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
    body: JSON.stringify({ tenantId: "tenant-a", spaceId: "space-a", taskId: "task-a", id: "opaque-a", path: "inbox/private.pdf", projectId: null, extensionId: null, workspaceBranch: null,
      destinationKey: "spaces/space-a/workspace/inbox/private.pdf", ...body }),
  }, env);
}

describe("storage-only attachment copy", () => {
  it("copies original bytes into the current Space workspace without reading them into model context", async () => {
    const state = makeEnv();
    const response = await copy(state.env, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ copied: true, path: "inbox/private.pdf", size_bytes: 4 });
    expect(state.destinationWrites).toHaveLength(1);
    expect(state.destinationWrites[0]?.key).toBe("spaces/space-a/workspace/inbox/private.pdf");
    expect(state.sourceRead()).toBe(1);
  });

  it("rejects traversal, wrong destination prefixes, foreign task handles, collisions, and existing files", async () => {
    const traversal = makeEnv();
    expect((await copy(traversal.env, { path: "../outside.pdf" })).status).toBe(400);
    expect(traversal.queries).toHaveLength(0);

    const prefix = makeEnv();
    expect((await copy(prefix.env, { destinationKey: "spaces/space-b/workspace/outside.pdf" })).status).toBe(403);
    expect(prefix.sourceRead()).toBe(0);

    const foreign = makeEnv({ owned: false });
    expect((await copy(foreign.env, {})).status).toBe(404);
    expect(foreign.sourceRead()).toBe(0);

    const claim = makeEnv({ claimAllowed: false });
    expect((await copy(claim.env, {})).status).toBe(409);
    expect(claim.sourceRead()).toBe(0);

    const exists = makeEnv({ destinationExists: true });
    expect((await copy(exists.env, {})).status).toBe(409);
    expect(exists.sourceRead()).toBe(0);
  });

  it("rejects inconsistent R2 size metadata before reading or copying the object", async () => {
    const state = makeEnv({ sourceSize: attachment.size_bytes + 1 });
    const response = await copy(state.env, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "attachment_copy_size_mismatch" });
    expect(state.sourceBytesRead()).toBe(0);
    expect(state.destinationWrites).toHaveLength(0);
  });

  it("publishes project attachment copies through a checked coordinator checkpoint", async () => {
    const state = makeEnv({ unified: true });
    const response = await copy(state.env, { projectId: "project-a", workspaceBranch: "workers/task-a",
      destinationKey: "spaces/space-a/projects/project-a/workspace/branches/workers/task-a/inbox/private.pdf" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ copied: true, path: "inbox/private.pdf", mime_type: "application/pdf" });
    expect(state.destinationWrites).toHaveLength(0);
    expect(state.coordinatorCalls.map(call => call.path)).toEqual(["/v1/head", "/v1/open", "/v1/stage", "/v1/checkpoint", "/v1/close"]);
    expect(state.coordinatorCalls.find(call => call.path === "/v1/stage")?.body).toMatchObject({ changes: [{
      path: "inbox/private.pdf", expectedHash: null, contentType: "application/pdf",
    }] });
    expect(state.coordinatorCalls.find(call => call.path === "/v1/checkpoint")?.body).toMatchObject({ baseRevision: 5, idempotencyKey: expect.stringMatching(/^attachment-/) });
  });
});
