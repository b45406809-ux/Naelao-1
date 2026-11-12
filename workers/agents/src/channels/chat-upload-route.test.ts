import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import { app } from "../index.js";

const secret = "chat-upload-route-secret";

function makeEnv(scopeResponses: (request: Request) => Response) {
  const r2Calls: string[] = [];
  const writes: Array<{ key: string; bytes: Uint8Array; contentType?: string }> = [];
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
      async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
        r2Calls.push(`put:${key}`);
        writes.push({ key, bytes: value.slice(), ...(options?.httpMetadata?.contentType ? { contentType: options.httpMetadata.contentType } : {}) });
        return { etag: "etag-1" };
      },
      async head(key: string) {
        r2Calls.push(`head:${key}`);
        return null;
      },
    },
    CONCURRENCY_DO: {
      idFromName: (name: string) => name,
      get: () => ({ async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        if (path === "/locks/acquire") return Response.json({ acquired: true, fencingToken: 1 });
        if (path === "/locks/release") return Response.json({ released: true });
        return Response.json({ error_code: "not_found" }, { status: 404 });
      } }),
    },
    WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ async fetch(request: Request) {
        if (new URL(request.url).pathname === "/v1/migration/status") return Response.json({ migration: null, readPolicy: { mode: "legacy" } });
        return Response.json({ error_code: "not_found" }, { status: 404 });
      } }),
    },
  };
  return { env: env as never, r2Calls, writes };
}

async function postUpload(env: never, projectId?: string, addFile = false, mimeType = "text/plain", filename = "brief.txt") {
  const form = new FormData();
  if (projectId) form.append("project_id", projectId);
  if (addFile)
    form.append(
      "files",
      new Blob(["safe attachment"], { type: mimeType }),
      filename
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

async function postFiles(env: never, filenames: string[]) {
  const form = new FormData();
  for (const filename of filenames) {
    form.append("files", new Blob(["safe attachment"], { type: "text/plain" }), filename);
  }
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

function makeUnifiedEnv(scopeResponses: (request: Request) => Response) {
  const files = new Map<string, { bytes: Uint8Array; sha256: string; contentType: string }>();
  const legacyWrites: string[] = [];
  let revision = 1;
  let staged: Array<{ path: string; expectedHash: string | null; contentBase64: string | null; contentType?: string }> = [];
  const coordinator = {
    async fetch(request: Request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/head") return Response.json({ head: { branch: "main", revision } });
      if (url.pathname === "/v1/read") {
        const exact = url.searchParams.get("path");
        const prefix = url.searchParams.get("prefix");
        const entries = [...files].filter(([path]) => exact ? path === exact : prefix ? path.startsWith(prefix + "/") : true)
          .map(([path, file]) => ({ path, sha256: file.sha256, size: file.bytes.byteLength, executable: false, contentType: file.contentType, objectKey: `workspace-v1/${file.sha256}` }));
        return Response.json({ head: { branch: "main", revision, updatedAt: "2026-11-08T00:00:00.000Z" }, entries });
      }
      if (url.pathname === "/v1/open") return Response.json({ session: { id: "ws_00000000-0000-4000-8000-000000000001", fence: 0 }, head: { revision } });
      if (url.pathname === "/v1/stage") {
        const body = await request.json() as { changes: typeof staged };
        staged = body.changes;
        return Response.json({ status: "staged" });
      }
      if (url.pathname === "/v1/checkpoint") {
        const change = staged[0]!;
        const current = files.get(change.path);
        if ((current?.sha256 ?? null) !== change.expectedHash) return Response.json({ error_code: "conflicted" }, { status: 409 });
        if (change.contentBase64 === null) files.delete(change.path);
        else {
          const bytes = Uint8Array.from(atob(change.contentBase64), value => value.charCodeAt(0));
          const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
          files.set(change.path, { bytes, sha256, contentType: change.contentType ?? "application/octet-stream" });
        }
        revision++;
        return Response.json({ publication: { status: "published", revision } });
      }
      if (url.pathname === "/v1/close") return Response.json({ closed: true });
      return Response.json({ error_code: "not_found" }, { status: 404 });
    },
  };
  const env = {
    PLATFORM_SECRET: secret,
    UNIFIED_WORKSPACE_ENABLED: "true",
    SPACES_WORKER: {
      async fetch(request: Request) { return scopeResponses(request); },
    },
    WORKSPACE_COORDINATOR: {
      idFromName(name: string) { return name; },
      get() { return coordinator; },
    },
    SCRIPTS_R2: {
      async put(key: string) { legacyWrites.push(key); return { etag: "legacy" }; },
      async get() { return null; },
      async head() { return null; },
      async list() { return { objects: [], truncated: false }; },
      async delete() {},
    },
  };
  return { env: env as never, files, legacyWrites, get staged() { return staged; }, get revision() { return revision; } };
}

async function requestUploads(env: never, method: "GET" | "DELETE", suffix = "") {
  return app.request(
    `/spaces/space-a/sessions/session-a/uploads${suffix}`,
    { method, headers: {
      "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a", "x-naelao-role": "product_end_user",
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
    } },
    env,
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

  it("infers a known MIME type when a browser omits the multipart file type", async () => {
    const state = makeEnv((request) =>
      new URL(request.url).pathname.endsWith("compact-scope")
        ? Response.json({ project_id: null, owned_by_caller: true, private_scratchpad: false })
        : new Response(null, { status: 404 })
    );
    const response = await postUpload(state.env, undefined, true, "", "invoice.pdf");
    expect(response.status).toBe(201);
    expect(state.writes[0]).toMatchObject({ contentType: "application/pdf" });
  });

  it("rejects more than six files before writing any of them", async () => {
    const state = makeEnv((request) =>
      new URL(request.url).pathname.endsWith("compact-scope")
        ? Response.json({ project_id: null, owned_by_caller: true, private_scratchpad: false })
        : new Response(null, { status: 404 })
    );
    const response = await postFiles(state.env, Array.from({ length: 7 }, (_, index) => `file-${index}.txt`));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error_code: "too_many_files" });
    expect(state.r2Calls).toEqual([]);
  });

  it("strips traversal components from uploaded filenames before creating R2 keys", async () => {
    const state = makeEnv((request) =>
      new URL(request.url).pathname.endsWith("compact-scope")
        ? Response.json({ project_id: null, owned_by_caller: true, private_scratchpad: false })
        : new Response(null, { status: 404 })
    );
    const response = await postFiles(state.env, ["../../brief.txt"]);
    expect(response.status).toBe(201);
    expect(state.writes[0]?.key).toBe("spaces/space-a/workspace/uploads/session-a/brief.txt");
    expect(state.writes[0]?.key).not.toContain("..");
  });

  it("routes project uploads, listing, and deletion through checked coordinator revisions when enabled", async () => {
    const state = makeUnifiedEnv((request) =>
      new URL(request.url).pathname.endsWith("compact-scope")
        ? Response.json({ project_id: "project-canonical", owned_by_caller: true, private_scratchpad: false })
        : Response.json({ id: "project-canonical" })
    );
    const uploaded = await postUpload(state.env, undefined, true, "application/pdf", "invoice.pdf");
    expect(uploaded.status).toBe(201);
    await expect(uploaded.json()).resolves.toMatchObject({ uploaded: [{ content_type: "application/pdf", branch: "main", revision: 2 }] });
    expect(state.files.get("uploads/session-a/invoice.pdf")).toMatchObject({ contentType: "application/pdf" });
    expect(state.staged[0]).toMatchObject({ path: "uploads/session-a/invoice.pdf", contentType: "application/pdf" });
    expect(state.legacyWrites).toEqual([]);

    const listed = await requestUploads(state.env, "GET");
    expect(await listed.json()).toMatchObject({ branch: "main", revision: 2, files: [{ name: "invoice.pdf", content_type: "application/pdf" }] });
    const deleted = await requestUploads(state.env, "DELETE", "/invoice.pdf");
    expect(await deleted.json()).toMatchObject({ deleted: true, branch: "main", revision: 3 });
    expect(state.files.size).toBe(0);
    expect(state.legacyWrites).toEqual([]);
  });
});
