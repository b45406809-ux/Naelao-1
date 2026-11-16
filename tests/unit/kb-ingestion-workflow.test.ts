import { describe, expect, it, vi } from "vitest";
import { chunkTextWithOffsets } from "@naelao/rag";
import { KbIngestionWorkflow } from "../../workers/workflows/src/workflows/KbIngestionWorkflow.js";

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

function setup(object: { size: number; etag?: string; text: () => Promise<string> } | null) {
  const steps: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const deleted: string[] = [];
  const env = {
    PLATFORM_SECRET: "secret",
    KB_BUCKET: {
      get: vi.fn(async () => object),
      delete: vi.fn(async (key: string) => { deleted.push(key); }),
    },
    KNOWLEDGE_WORKER: {
      fetch: vi.fn(async (url: string | URL, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return Response.json({ ok: true });
      }),
    },
  };
  const step = {
    do: async (name: string, optionsOrCallback: unknown, maybeCallback?: () => Promise<unknown>) => {
      steps.push(name);
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      if (!callback) throw new Error(`missing step callback: ${name}`);
      return callback();
    },
  };
  const workflow = new KbIngestionWorkflow({} as never, env as never);
  const event = {
    payload: {
      docId: "doc-1",
      spaceId: "space-1",
      tenantId: "tenant-1",
      projectId: "project-1",
      r2Key: "staging/tenant-1/space-1/project-1/doc-1/original",
      title: "Guide",
      contentType: "text/plain",
    },
  };
  return { workflow, event, step, env, steps, requests, deleted };
}

describe("KB ingestion workflow bounds and side effects", () => {
  it("ingests, marks indexed, and deletes the raw object only after success", async () => {
    const ctx = setup({ size: 17, text: async () => "alpha beta gamma" });
    await ctx.workflow.run(ctx.event as never, ctx.step as never);

    expect(ctx.steps).toEqual([
      "fetch-content",
      "update-status-processing",
      "count-chunks",
      "set-total-chunks",
      "chunk-and-embed-0",
      "update-status-indexed",
      "cleanup-raw",
    ]);
    expect(ctx.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/spaces/space-1/kb/documents/doc-1/status",
      "/internal/spaces/space-1/kb/documents/doc-1/status",
      "/internal/spaces/space-1/kb/documents/doc-1/ingest-chunks",
      "/internal/spaces/space-1/kb/documents/doc-1/status",
    ]);
    expect(ctx.requests.every((request) => request.init?.headers &&
      (request.init.headers as Record<string, string>)["X-Naelao-Internal-Token"])).toBe(true);
    expect(JSON.parse(String(ctx.requests[2]?.init?.body))).toMatchObject({
      chunks: ["alpha beta gamma"],
      chunkCoordinates: [{ byteStart: 0, byteEnd: 16, lineStart: 1, lineEnd: 1 }],
      projectId: "project-1",
      chunkOffset: 0,
      byteOffset: 0,
      lineOffset: 1,
    });
    expect(ctx.deleted).toEqual(["staging/tenant-1/space-1/project-1/doc-1/original"]);
  });

  it("rejects an oversized R2 object before reading or ingesting it", async () => {
    const read = vi.fn(async () => "should not be read");
    const ctx = setup({ size: MAX_CONTENT_BYTES + 1, text: read });

    await expect(ctx.workflow.run(ctx.event as never, ctx.step as never)).rejects.toThrow(/exceeds 5MB/);
    expect(read).not.toHaveBeenCalled();
    expect(ctx.requests).toHaveLength(1);
    expect(JSON.parse(String(ctx.requests[0]?.init?.body)).status).toBe("failed");
    expect(ctx.deleted).toEqual([]);
  });

  it("checks actual UTF-8 bytes even when R2 metadata understates the body", async () => {
    const text = "é".repeat(Math.floor(MAX_CONTENT_BYTES / 2) + 1);
    const ctx = setup({ size: 1, text: async () => text });

    await expect(ctx.workflow.run(ctx.event as never, ctx.step as never)).rejects.toThrow(/content exceeds 5MB/);
    expect(ctx.requests).toHaveLength(1);
    expect(JSON.parse(String(ctx.requests[0]?.init?.body)).status).toBe("failed");
    expect(ctx.deleted).toEqual([]);
  });

  it("marks a missing object failed and does not start ingestion", async () => {
    const ctx = setup(null);
    await expect(ctx.workflow.run(ctx.event as never, ctx.step as never)).rejects.toThrow(/R2 object not found/);
    expect(ctx.requests).toHaveLength(1);
    expect(JSON.parse(String(ctx.requests[0]?.init?.body)).status).toBe("failed");
    expect(ctx.deleted).toEqual([]);
  });

  it("does not ingest content that changed in R2 after the validation step", async () => {
    const ctx = setup({ size: 4, etag: "version-a", text: async () => "same" });
    ctx.env.KB_BUCKET.get
      .mockResolvedValueOnce({ size: 4, etag: "version-a", text: async () => "same" })
      .mockResolvedValueOnce({ size: 4, etag: "version-b", text: async () => "evil" });
    await expect(ctx.workflow.run(ctx.event as never, ctx.step as never)).rejects.toThrow(/changed between workflow steps/);
    expect(ctx.requests.some(({ url }) => url.endsWith("/ingest-chunks"))).toBe(false);
    expect(ctx.deleted).toEqual([]);
  });

  it("sends long documents in bounded batches without dropping non-whitespace boundary characters", async () => {
    const content = "a".repeat(10 * 1024 * 55);
    const expectedChunks = chunkTextWithOffsets(content);
    const ctx = setup({ size: new TextEncoder().encode(content).byteLength, text: async () => content });
    await ctx.workflow.run(ctx.event as never, ctx.step as never);
    const requests = ctx.requests.filter(({ url }) => url.endsWith("/ingest-chunks"));
    expect(requests).toHaveLength(Math.ceil(expectedChunks.length / 50));
    const bodies = requests.map(({ init }) => JSON.parse(String(init?.body)) as {
      chunks: string[]; chunkOffset: number;
      chunkCoordinates: Array<{ byteStart: number; byteEnd: number; lineStart: number; lineEnd: number }>;
    });
    expect(bodies.map(({ chunkOffset, chunks }) => [chunkOffset, chunks.length])).toEqual(
      Array.from({ length: Math.ceil(expectedChunks.length / 50) }, (_, index) => [index * 50, Math.min(50, expectedChunks.length - index * 50)]),
    );
    expect(bodies.flatMap(({ chunks }) => chunks)).toEqual(expectedChunks.map(({ content: chunk }) => chunk));
    expect(bodies.flatMap(({ chunkCoordinates }) => chunkCoordinates)).toEqual(expectedChunks.map((chunk) => ({
      byteStart: chunk.charOffset, byteEnd: chunk.charEnd, lineStart: 1, lineEnd: 1,
    })));
    expect(expectedChunks.at(-1)?.charEnd).toBe(content.length);
    expect(expectedChunks.every((chunk) => chunk.content.length <= 2_048)).toBe(true);
  });

  it("reports UTF-8 byte and line coordinates for Unicode text with CRLF newlines", async () => {
    const content = "first 😀 line\r\nsecond line";
    const ctx = setup({ size: new TextEncoder().encode(content).byteLength, text: async () => content });
    await ctx.workflow.run(ctx.event as never, ctx.step as never);
    const body = JSON.parse(String(ctx.requests.find(({ url }) => url.endsWith("/ingest-chunks"))?.init?.body)) as {
      chunkCoordinates: Array<{ byteStart: number; byteEnd: number; lineStart: number; lineEnd: number }>;
    };
    expect(body.chunkCoordinates).toEqual([{ byteStart: 0, byteEnd: new TextEncoder().encode(content).byteLength, lineStart: 1, lineEnd: 2 }]);
  });

  it("rejects non-staging R2 keys before reading or deleting bucket data", async () => {
    const ctx = setup({ size: 4, text: async () => "secret" });
    ctx.event.payload.r2Key = "kb/space-1/project-1/doc-1/original";
    await expect(ctx.workflow.run(ctx.event as never, ctx.step as never)).rejects.toThrow(/Invalid KB ingestion workflow parameters/);
    expect(ctx.env.KB_BUCKET.get).not.toHaveBeenCalled();
    expect(ctx.deleted).toEqual([]);
  });
});
