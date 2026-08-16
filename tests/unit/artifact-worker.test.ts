import { describe, it, expect } from "vitest";
import artifactWorker from "../../workers/artifact/src/index.js";
import type { ArtifactEnv } from "../../workers/artifact/src/index.js";
import { mintInternalToken } from "@naelao/http";

// Phase 5: this worker had NO test coverage at all before this pass — and, per its own rewritten
// header comment, it had NO real auth (every identity header trusted as-is) and routes that could
// never have matched once actually wired through the router (/v1 prefix stripped by proxyTo,
// spaceId read from a spoofable header instead of the URL path). This file drives the REAL Hono
// app end to end against a real in-memory R2 fake, proving the rebuilt contract: HMAC-gated,
// spaceId from the path, tenant-scoped, real list/get/delete/create.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeFakeR2(): R2Bucket {
  const store = new Map<string, { bytes: Uint8Array; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; uploaded: Date }>();
  return {
    async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
      store.set(key, { bytes: value, httpMetadata: opts?.httpMetadata, customMetadata: opts?.customMetadata, uploaded: new Date() });
    },
    async get(key: string) {
      const found = store.get(key);
      if (!found) return null;
      return {
        body: found.bytes,
        httpMetadata: found.httpMetadata,
        customMetadata: found.customMetadata,
      };
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, v]) => ({ key, size: v.bytes.byteLength, uploaded: v.uploaded, httpMetadata: v.httpMetadata, customMetadata: v.customMetadata }));
      return { objects, truncated: false, cursor: undefined };
    },
  } as unknown as R2Bucket;
}

function makeEnv(): ArtifactEnv {
  return { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, ARTIFACT_BUCKET: makeFakeR2() };
}

async function req(path: string, tenantId: string, init?: RequestInit): Promise<Request> {
  const token = await mintInternalToken(SECRET, tenantId);
  return new Request(`https://artifact.naelao.com${path}`, {
    ...init,
    headers: { ...init?.headers, "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token },
  });
}

describe("artifact worker — auth gate", () => {
  it("rejects a request with no internal token at all", async () => {
    const env = makeEnv();
    const res = await artifactWorker.fetch(
      new Request("https://artifact.naelao.com/spaces/space1/artifacts", { headers: { "x-naelao-tenant-id": "tenant-1" } }),
      env,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("rejects a request with a wrong-secret token", async () => {
    const env = makeEnv();
    const badToken = await mintInternalToken("wrong-secret", "tenant-1");
    const res = await artifactWorker.fetch(
      new Request("https://artifact.naelao.com/spaces/space1/artifacts", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": badToken },
      }),
      env,
      execCtx
    );
    expect(res.status).toBe(403);
  });

  it("accepts a request with a real, correctly-minted token", async () => {
    const env = makeEnv();
    const res = await artifactWorker.fetch(await req("/spaces/space1/artifacts", "tenant-1"), env, execCtx);
    expect(res.status).toBe(200);
  });
});

describe("artifact worker — create / list / get / delete", () => {
  it("creates a text artifact via JSON, then lists it", async () => {
    const env = makeEnv();
    const createRes = await artifactWorker.fetch(
      await req("/spaces/space1/artifacts", "tenant-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "report.html", content: "<h1>Q3 Report</h1>", content_type: "text/html" }),
      }),
      env,
      execCtx
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { artifact_id: string; filename: string };
    expect(created.filename).toBe("report.html");

    const listRes = await artifactWorker.fetch(await req("/spaces/space1/artifacts", "tenant-1"), env, execCtx);
    const listed = (await listRes.json()) as { data: Array<{ artifact_id: string; filename: string }>; count: number };
    expect(listed.count).toBe(1);
    expect(listed.data[0]).toMatchObject({ artifact_id: created.artifact_id, filename: "report.html" });
  });

  it("fetches the real content back, with the right content-type", async () => {
    const env = makeEnv();
    const createRes = await artifactWorker.fetch(
      await req("/spaces/space1/artifacts", "tenant-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "notes.md", content: "# hello", content_type: "text/markdown" }),
      }),
      env,
      execCtx
    );
    const { artifact_id } = (await createRes.json()) as { artifact_id: string };

    const getRes = await artifactWorker.fetch(await req(`/spaces/space1/artifacts/${artifact_id}`, "tenant-1"), env, execCtx);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("text/markdown");
    expect(await getRes.text()).toBe("# hello");
  });

  it("deletes an artifact, and it's gone from both list and get afterward", async () => {
    const env = makeEnv();
    const createRes = await artifactWorker.fetch(
      await req("/spaces/space1/artifacts", "tenant-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "temp.txt", content: "scratch" }),
      }),
      env,
      execCtx
    );
    const { artifact_id } = (await createRes.json()) as { artifact_id: string };

    const delRes = await artifactWorker.fetch(await req(`/spaces/space1/artifacts/${artifact_id}`, "tenant-1", { method: "DELETE" }), env, execCtx);
    expect(delRes.status).toBe(200);

    const getRes = await artifactWorker.fetch(await req(`/spaces/space1/artifacts/${artifact_id}`, "tenant-1"), env, execCtx);
    expect(getRes.status).toBe(404);

    const listRes = await artifactWorker.fetch(await req("/spaces/space1/artifacts", "tenant-1"), env, execCtx);
    const listed = (await listRes.json()) as { count: number };
    expect(listed.count).toBe(0);
  });

  it("404s for an artifact id that never existed", async () => {
    const env = makeEnv();
    const res = await artifactWorker.fetch(await req("/spaces/space1/artifacts/nonexistent-id", "tenant-1"), env, execCtx);
    expect(res.status).toBe(404);
  });

  it("rejects an artifact over the 5MB cap", async () => {
    const env = makeEnv();
    const huge = "x".repeat(6 * 1024 * 1024);
    const res = await artifactWorker.fetch(
      await req("/spaces/space1/artifacts", "tenant-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "big.txt", content: huge }),
      }),
      env,
      execCtx
    );
    expect(res.status).toBe(400);
  });

  it("rejects a create with neither content nor data_base64", async () => {
    const env = makeEnv();
    const res = await artifactWorker.fetch(
      await req("/spaces/space1/artifacts", "tenant-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "empty.txt" }),
      }),
      env,
      execCtx
    );
    expect(res.status).toBe(400);
  });

  it("accepts a base64-encoded binary artifact", async () => {
    const env = makeEnv();
    const b64 = btoa("binary-ish content");
    const res = await artifactWorker.fetch(
      await req("/spaces/space1/artifacts", "tenant-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "data.bin", content_type: "application/octet-stream", data_base64: b64 }),
      }),
      env,
      execCtx
    );
    expect(res.status).toBe(201);
    const { artifact_id } = (await res.json()) as { artifact_id: string };
    const getRes = await artifactWorker.fetch(await req(`/spaces/space1/artifacts/${artifact_id}`, "tenant-1"), env, execCtx);
    expect(await getRes.text()).toBe("binary-ish content");
  });
});

describe("artifact worker — tenant isolation", () => {
  it("CRITICAL: tenant B cannot read tenant A's artifact by guessing the same id/space", async () => {
    const env = makeEnv();
    const createRes = await artifactWorker.fetch(
      await req("/spaces/space1/artifacts", "tenant-a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "secret.txt", content: "tenant A's own data" }),
      }),
      env,
      execCtx
    );
    const { artifact_id } = (await createRes.json()) as { artifact_id: string };

    // Same spaceId, same artifactId — but a DIFFERENT tenant. The R2 key is prefixed by tenantId,
    // so this must 404, not leak tenant A's content.
    const res = await artifactWorker.fetch(await req(`/spaces/space1/artifacts/${artifact_id}`, "tenant-b"), env, execCtx);
    expect(res.status).toBe(404);
  });

  it("tenant B's list of the same space is empty even though tenant A has artifacts there", async () => {
    const env = makeEnv();
    await artifactWorker.fetch(
      await req("/spaces/space1/artifacts", "tenant-a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "a.txt", content: "x" }),
      }),
      env,
      execCtx
    );
    const listRes = await artifactWorker.fetch(await req("/spaces/space1/artifacts", "tenant-b"), env, execCtx);
    const listed = (await listRes.json()) as { count: number };
    expect(listed.count).toBe(0);
  });
});
