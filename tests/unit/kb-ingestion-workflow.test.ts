import { describe, expect, it, vi } from "vitest";
import { KbIngestionWorkflow } from "../../workers/workflows/src/workflows/KbIngestionWorkflow.js";

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

function setup(object: { size: number; text: () => Promise<string> } | null) {
  const steps: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const deleted: string[] = [];
  const env = {
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
      r2Key: "staging/doc-1",
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
      "chunk-and-embed",
      "update-status-indexed",
      "cleanup-raw",
    ]);
    expect(ctx.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/docs/doc-1/status",
      "/internal/docs/doc-1/ingest-chunks",
      "/internal/docs/doc-1/status",
    ]);
    expect(JSON.parse(String(ctx.requests[1]?.init?.body))).toMatchObject({
      chunks: ["alpha beta gamma"],
      spaceId: "space-1",
      tenantId: "tenant-1",
      projectId: "project-1",
    });
    expect(ctx.deleted).toEqual(["staging/doc-1"]);
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
});
