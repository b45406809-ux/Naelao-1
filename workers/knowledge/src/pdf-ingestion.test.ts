import { afterEach, describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

const pdfBytes = new TextEncoder().encode("%PDF-1.4\nsource bytes\n");
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fixture(projectAuthorized = true) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const objects = new Map<string, Uint8Array>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          calls.push({ sql, args });
          return {
            async first() {
              if (sql.includes("JOIN orgs")) return { id: "space-1" };
              if (sql.includes("SELECT config_json FROM spaces")) return { config_json: "{}" };
              if (sql.includes("FROM project_access")) return projectAuthorized ? { visibility: "private", role_rank: 50 } : null;
              if (sql.includes("SELECT plan_tier FROM orgs")) return { plan_tier: "free" };
              if (sql.includes("COUNT(*) as count FROM kb_documents")) return { count: 0 };
              if (sql.includes("FROM spaces")) return { id: "space-1" };
              return null;
            },
            async all() { return { results: [] }; },
            async run() { return { meta: { changes: 1 } }; },
          };
        },
      };
    },
    async batch() { return []; },
  };
  const vectors = {
    getByIds: vi.fn(async () => []),
    deleteByIds: vi.fn(async () => undefined),
    upsert: vi.fn(async (batch: VectorizeVector[]) => ({ count: batch.length })),
  };
  const env = {
    ENVIRONMENT: "test", PLATFORM_SECRET: "secret", COHERE_API_KEY: "cohere-test", PLATFORM_DB: db,
    KB_BUCKET: {
      put: vi.fn(async (key: string, value: Uint8Array) => { objects.set(key, new Uint8Array(value)); }),
      delete: vi.fn(async (key: string | string[]) => { for (const item of Array.isArray(key) ? key : [key]) objects.delete(item); }),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    },
    KB_VECTORS: vectors,
    EVENTS_QUEUE: { send: vi.fn(async () => undefined) },
    AI: { run: vi.fn(async (_model: string, input: { text: string | string[] }) => ({
      data: (Array.isArray(input.text) ? input.text : [input.text]).map(() => [0.1, 0.2]),
    })) },
  } as never;
  return { env, calls, objects, vectors };
}

async function request(path: string, body: unknown): Promise<Request> {
  const token = await mintInternalToken("secret", "tenant-1");
  return new Request(`https://knowledge${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1",
      "x-naelao-internal-token": token, "x-naelao-user-id": "user-1", "x-naelao-role": "owner" },
    body: JSON.stringify(body),
  });
}

function stubParser(markdown = "# Parsed guide\n\nOriginal extracted content.") {
  const parse = vi.fn(async () => new Response(JSON.stringify({ markdown }), { status: 200 }));
  vi.stubGlobal("fetch", parse);
  return parse;
}

afterEach(() => vi.unstubAllGlobals());

describe("Knowledge PDF preview and approved ingestion", () => {
  it("previews under the requested project ACL and binds the selected bytes and scope", async () => {
    const parse = stubParser();
    const f = fixture();
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents/preview", {
      content: base64(pdfBytes), source_file_name: "guide.pdf", project_id: "project-1",
    }), f.env, {} as ExecutionContext);

    expect(response.status).toBe(200);
    const { preview } = await response.json() as { preview: Record<string, unknown> };
    expect(preview).toMatchObject({ content: "# Parsed guide\n\nOriginal extracted content.",
      parser_version: "cohere:parse-v5.0", source_file_name: "guide.pdf", source_bytes: pdfBytes.byteLength,
      extraction_warnings: [expect.stringContaining("Review reading order")] });
    expect(preview.source_sha256).toBe("aaff39a141bf4fa571f219eebfda53cff4454b4b3433e78307d48dd004f4fb96");
    expect(parse).toHaveBeenCalledTimes(1);
    expect(f.calls.some(({ sql }) => sql.includes("FROM project_access"))).toBe(true);
    expect(f.objects.size).toBe(0);
  });

  it("fails closed when the project scope is unauthorized or the file exceeds its scope limit", async () => {
    const parse = stubParser();
    const denied = fixture(false);
    const deniedResponse = await worker.fetch(await request("/spaces/space-1/kb/documents/preview", {
      content: base64(pdfBytes), source_file_name: "guide.pdf", project_id: "project-1",
    }), denied.env, {} as ExecutionContext);
    expect(deniedResponse.status).toBe(404);
    expect(parse).not.toHaveBeenCalled();

    const oversized = fixture();
    const bytes = new Uint8Array(1_048_577);
    bytes.set(new TextEncoder().encode("%PDF-"));
    const limited = await worker.fetch(await request("/spaces/space-1/kb/documents/preview", {
      content: base64(bytes), source_file_name: "large.pdf",
    }), oversized.env, {} as ExecutionContext);
    expect(limited.status).toBe(413);
    expect(parse).not.toHaveBeenCalled();
  });

  it("keeps an unavailable parser as an explicit service gate and requires a preview receipt to ingest", async () => {
    const parse = stubParser();
    const f = fixture();
    delete (f.env as unknown as { COHERE_API_KEY?: string }).COHERE_API_KEY;
    const preview = await worker.fetch(await request("/spaces/space-1/kb/documents/preview", {
      content: base64(pdfBytes), source_file_name: "guide.pdf",
    }), f.env, {} as ExecutionContext);
    expect(preview.status).toBe(503);
    expect(parse).not.toHaveBeenCalled();

    const missingReceipt = await worker.fetch(await request("/spaces/space-1/kb/documents", {
      title: "Unreviewed PDF", content: base64(pdfBytes), content_type: "pdf", source_file_name: "guide.pdf",
    }), f.env, {} as ExecutionContext);
    expect(missingReceipt.status).toBe(409);
    expect(f.calls.some(({ sql }) => sql.includes("INSERT INTO kb_documents"))).toBe(false);
    expect(f.objects.size).toBe(0);
  });

  it("ingests corrected approved text once, stores the original PDF, and records parser lineage", async () => {
    const parse = stubParser();
    const f = fixture();
    const previewResponse = await worker.fetch(await request("/spaces/space-1/kb/documents/preview", {
      content: base64(pdfBytes), source_file_name: "guide.pdf",
    }), f.env, {} as ExecutionContext);
    const { preview } = await previewResponse.json() as { preview: {
      extraction_sha256: string; preview_token: string; source_sha256: string;
    } };
    const createResponse = await worker.fetch(await request("/spaces/space-1/kb/documents", {
      title: "Reviewed guide", content: base64(pdfBytes), content_type: "pdf", source_file_name: "guide.pdf",
      preview_content: "# Corrected heading\n\nApproved content after human review.",
      preview_token: preview.preview_token, preview_extraction_sha256: preview.extraction_sha256,
    }), f.env, {} as ExecutionContext);

    expect(createResponse.status).toBe(201);
    expect(parse).toHaveBeenCalledTimes(1); // create trusts the short-lived signed preview, never reparses silently.
    expect([...f.objects.entries()].some(([key, bytes]) => key.endsWith("/original") &&
      new TextDecoder().decode(bytes) === new TextDecoder().decode(pdfBytes))).toBe(true);
    const insert = f.calls.find(({ sql }) => sql.includes("INSERT INTO kb_documents"));
    expect(insert?.args).toContain(preview.source_sha256);
    expect(insert?.args).toContain(preview.extraction_sha256);
    expect(insert?.args).toContain("cohere:parse-v5.0");
    expect(insert?.args).toContain(await sha256("# Corrected heading\n\nApproved content after human review."));
    const chunkWrites = f.calls.filter(({ sql }) => sql.includes("INSERT INTO kb_chunks"));
    expect(chunkWrites.some(({ args }) => args.some((value) => typeof value === "string" && value.includes("Approved content after human review.")))).toBe(true);
  });

  it("rejects a preview receipt replayed with different bytes or a different project scope before persistence", async () => {
    stubParser();
    const f = fixture();
    const previewResponse = await worker.fetch(await request("/spaces/space-1/kb/documents/preview", {
      content: base64(pdfBytes), source_file_name: "guide.pdf",
    }), f.env, {} as ExecutionContext);
    const { preview } = await previewResponse.json() as { preview: { extraction_sha256: string; preview_token: string } };
    const changed = new Uint8Array(pdfBytes);
    changed[changed.length - 2] = 0x78;
    const response = await worker.fetch(await request("/spaces/space-1/kb/documents", {
      title: "Replay", content: base64(changed), content_type: "pdf", source_file_name: "guide.pdf",
      preview_content: "substituted", preview_token: preview.preview_token,
      preview_extraction_sha256: preview.extraction_sha256, project_id: "project-1",
    }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(409);
    expect(f.calls.some(({ sql }) => sql.includes("INSERT INTO kb_documents"))).toBe(false);
    expect(f.objects.size).toBe(0);
  });
});
