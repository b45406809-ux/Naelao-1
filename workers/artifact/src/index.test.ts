import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker, { type ArtifactEnv } from "./index.js";

const platformSecret = "artifact-list-test-secret";

function object(index: number) {
  return {
    key: `tenant-1/space-1/artifact-${index}/file.txt`,
    size: 10,
    uploaded: new Date("2026-01-01T00:00:00.000Z"),
    customMetadata: { content_type: "text/plain" },
    httpMetadata: {},
  };
}

async function listRequest(query = "") {
  const token = await mintInternalToken(platformSecret, "tenant-1");
  return new Request(`https://artifact.test/spaces/space-1/artifacts${query}`, {
    headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
  });
}

describe("Artifact list pagination", () => {
  it("returns a stable bounded page and an explicit continuation cursor", async () => {
    const list = vi.fn(async (options: R2ListOptions) => options.cursor
      ? { objects: [object(3)], truncated: false }
      : { objects: [object(1), object(2)], truncated: true, cursor: "opaque-next-page" });
    const env = {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: platformSecret,
      ARTIFACT_BUCKET: { list } as unknown as R2Bucket,
    } as ArtifactEnv;

    const first = await worker.fetch(await listRequest("?limit=2"), env, {} as ExecutionContext);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      count: 2,
      has_more: true,
      next_cursor: "opaque-next-page",
      data: [{ artifact_id: "artifact-1" }, { artifact_id: "artifact-2" }],
    });
    expect(list.mock.calls[0]?.[0]).toMatchObject({ prefix: "tenant-1/space-1/", limit: 2 });

    const next = await worker.fetch(await listRequest("?limit=2&cursor=opaque-next-page"), env, {} as ExecutionContext);
    expect(await next.json()).toMatchObject({ count: 1, has_more: false, data: [{ artifact_id: "artifact-3" }] });
    expect(list.mock.calls[1]?.[0].cursor).toBe("opaque-next-page");
  });

  it("rejects malformed limits and oversized cursors before listing R2", async () => {
    const list = vi.fn();
    const env = {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: platformSecret,
      ARTIFACT_BUCKET: { list } as unknown as R2Bucket,
    } as ArtifactEnv;

    const invalidLimit = await worker.fetch(await listRequest("?limit=0"), env, {} as ExecutionContext);
    const invalidCursor = await worker.fetch(await listRequest(`?cursor=${"x".repeat(2049)}`), env, {} as ExecutionContext);
    expect(invalidLimit.status).toBe(400);
    expect(invalidCursor.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("serves potentially active artifacts as isolated, non-cacheable downloads", async () => {
    const stored = {
      ...object(1),
      key: "tenant-1/space-1/artifact-1/caf\u00e9.html",
      body: new Response("<script>parent.postMessage('bad','*')</script>").body,
    };
    const env = {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: platformSecret,
      ARTIFACT_BUCKET: {
        list: async () => ({ objects: [stored], truncated: false }),
        get: async () => stored,
      } as unknown as R2Bucket,
    } as ArtifactEnv;

    const token = await mintInternalToken(platformSecret, "tenant-1");
    const response = await worker.fetch(new Request("https://artifact.test/spaces/space-1/artifacts/artifact-1", {
      headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-artifact-filename")).toBe("caf%C3%A9.html");
  });
});
