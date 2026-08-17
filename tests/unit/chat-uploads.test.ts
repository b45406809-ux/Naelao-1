import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// Chat uploads — files attached in the input bar, read directly by the agent from its own
// workspace (spaces/{id}[/projects/{id}]/workspace/uploads/{sessionId}/...), NOT knowledge-base
// ingestion. Same business-membership gate as every other end-user-reachable space route.

const SECRET = "test-platform-secret";

function makeSpacesWorkerStub(businessRoleOk: boolean): Fetcher {
  return {
    fetch: async (input: RequestInfo) => {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      if (url.pathname === "/internal/business-role") {
        return businessRoleOk ? Response.json({ role: "member" }) : Response.json({ error_code: "forbidden" }, { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
}

function makeR2Stub() {
  const store = new Map<string, { body: ArrayBuffer; contentType: string; size: number; uploaded: Date }>();
  const bucket: Partial<R2Bucket> = {
    async put(key: unknown, value: unknown, opts?: unknown) {
      const k = key as string;
      const buf = value as ArrayBuffer;
      const contentType = (opts as { httpMetadata?: { contentType?: string } } | undefined)?.httpMetadata?.contentType ?? "application/octet-stream";
      store.set(k, { body: buf, contentType, size: buf.byteLength, uploaded: new Date() });
      return {} as R2Object;
    },
    async list(opts: unknown) {
      const prefix = (opts as { prefix?: string } | undefined)?.prefix ?? "";
      const objects = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, v]) => ({ key, size: v.size, uploaded: v.uploaded, httpMetadata: { contentType: v.contentType } }));
      return { objects, truncated: false } as unknown as R2Objects;
    },
    async delete(key: unknown) {
      store.delete(key as string);
    },
  };
  return { bucket: bucket as R2Bucket, store };
}

function makeEnv(opts: { spacesOk: boolean; withR2?: boolean }) {
  const { bucket, store } = makeR2Stub();
  const env: AgentsEnv & { __store: typeof store } = {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PLATFORM_SECRET: SECRET,
    SPACES_WORKER: makeSpacesWorkerStub(opts.spacesOk),
    PLATFORM_DB: {} as unknown as D1Database,
    ...(opts.withR2 !== false ? { SCRIPTS_R2: bucket } : {}),
    ANALYTICS: { writeDataPoint() {} },
    __store: store,
  } as unknown as AgentsEnv & { __store: typeof store };
  return env;
}

async function authedHeaders(tenantId: string, role = "product_end_user"): Promise<Record<string, string>> {
  return {
    "x-naelao-tenant-id": tenantId,
    "x-naelao-role": role,
    "x-naelao-user-id": "user-1",
    "x-naelao-internal-token": await mintInternalToken(SECRET, tenantId),
  };
}

function makeUploadRequest(path: string, files: Array<{ name: string; content: string; type?: string }>, headers: Record<string, string>): Request {
  const form = new FormData();
  for (const f of files) {
    form.append("files", new File([f.content], f.name, { type: f.type ?? "text/plain" }));
  }
  return new Request(`https://agents.naelao.com${path}`, { method: "POST", headers, body: form });
}

describe("chat uploads — POST /spaces/:spaceId/sessions/:sessionId/uploads", () => {
  it("denies a product_end_user who isn't a member of the business", async () => {
    const env = makeEnv({ spacesOk: false });
    const headers = await authedHeaders("tenant-1");
    const res = await app.fetch(makeUploadRequest("/spaces/space1/sessions/sess1/uploads", [{ name: "a.txt", content: "hi" }], headers), env);
    expect(res.status).toBe(403);
  });

  it("stores an uploaded file under the session's own uploads prefix", async () => {
    const env = makeEnv({ spacesOk: true });
    const headers = await authedHeaders("tenant-1");
    const res = await app.fetch(makeUploadRequest("/spaces/space1/sessions/sess1/uploads", [{ name: "photo.png", content: "binarydata", type: "image/png" }], headers), env);
    expect(res.status).toBe(201);
    const body = await res.json() as { uploaded: Array<{ name: string; key: string }> };
    expect(body.uploaded).toHaveLength(1);
    expect(body.uploaded[0]?.key).toBe("spaces/space1/workspace/uploads/sess1/photo.png");
    expect(env.__store.has("spaces/space1/workspace/uploads/sess1/photo.png")).toBe(true);
  });

  it("scopes to the project workspace when project_id is given, matching workspacePrefix()", async () => {
    const env = makeEnv({ spacesOk: true });
    const headers = await authedHeaders("tenant-1");
    const form = new FormData();
    form.append("files", new File(["x"], "notes.txt"));
    form.append("project_id", "proj1");
    const req = new Request("https://agents.naelao.com/spaces/space1/sessions/sess1/uploads", { method: "POST", headers, body: form });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(201);
    expect(env.__store.has("spaces/space1/projects/proj1/workspace/uploads/sess1/notes.txt")).toBe(true);
  });

  it("rejects more than 6 files in one call", async () => {
    const env = makeEnv({ spacesOk: true });
    const headers = await authedHeaders("tenant-1");
    const files = Array.from({ length: 7 }, (_, i) => ({ name: `f${i}.txt`, content: "x" }));
    const res = await app.fetch(makeUploadRequest("/spaces/space1/sessions/sess1/uploads", files, headers), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("too_many_files");
  });

  it("rejects a file over the size cap", async () => {
    const env = makeEnv({ spacesOk: true });
    const headers = await authedHeaders("tenant-1");
    const big = "x".repeat(21 * 1024 * 1024);
    const res = await app.fetch(makeUploadRequest("/spaces/space1/sessions/sess1/uploads", [{ name: "huge.bin", content: big }], headers), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("file_too_large");
  });

  it("strips path traversal from a supplied filename", async () => {
    const env = makeEnv({ spacesOk: true });
    const headers = await authedHeaders("tenant-1");
    const res = await app.fetch(makeUploadRequest("/spaces/space1/sessions/sess1/uploads", [{ name: "../../etc/passwd", content: "x" }], headers), env);
    expect(res.status).toBe(201);
    const body = await res.json() as { uploaded: Array<{ key: string }> };
    expect(body.uploaded[0]?.key).toBe("spaces/space1/workspace/uploads/sess1/passwd");
  });

  it("degrades honestly when R2 isn't bound", async () => {
    const env = makeEnv({ spacesOk: true, withR2: false });
    const headers = await authedHeaders("tenant-1");
    const res = await app.fetch(makeUploadRequest("/spaces/space1/sessions/sess1/uploads", [{ name: "a.txt", content: "hi" }], headers), env);
    expect(res.status).toBe(503);
  });
});

describe("chat uploads — GET/DELETE", () => {
  it("lists files under the session's uploads prefix, not another session's", async () => {
    const env = makeEnv({ spacesOk: true });
    const headers = await authedHeaders("tenant-1");
    await app.fetch(makeUploadRequest("/spaces/space1/sessions/sess1/uploads", [{ name: "mine.txt", content: "a" }], headers), env);
    await app.fetch(makeUploadRequest("/spaces/space1/sessions/sess2/uploads", [{ name: "other.txt", content: "b" }], headers), env);

    const listReq = new Request("https://agents.naelao.com/spaces/space1/sessions/sess1/uploads", { headers });
    const res = await app.fetch(listReq, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { files: Array<{ name: string }> };
    expect(body.files.map((f) => f.name)).toEqual(["mine.txt"]);
  });

  it("deletes an uploaded file", async () => {
    const env = makeEnv({ spacesOk: true });
    const headers = await authedHeaders("tenant-1");
    await app.fetch(makeUploadRequest("/spaces/space1/sessions/sess1/uploads", [{ name: "gone.txt", content: "a" }], headers), env);
    const delReq = new Request("https://agents.naelao.com/spaces/space1/sessions/sess1/uploads/gone.txt", { method: "DELETE", headers });
    const res = await app.fetch(delReq, env);
    expect(res.status).toBe(200);
    expect(env.__store.has("spaces/space1/workspace/uploads/sess1/gone.txt")).toBe(false);
  });
});
