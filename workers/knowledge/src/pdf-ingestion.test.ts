import { afterEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

const pdfBytes = new TextEncoder().encode("%PDF-1.4\nsource bytes\n");
const docxBytes = zipSync({ "word/document.xml": strToU8(`<w:document xmlns:w="x"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Inventory</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>SKU</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Qty</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>001</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>0007</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`) });
const xlsxBytes = zipSync({
  "xl/workbook.xml": strToU8('<workbook xmlns:r="x"><sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/></sheets></workbook>'),
  "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
  "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>SKU</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c></row><row><c r="A2"><v>001</v></c><c r="B2"><f>SUM(B3:B4)</f><v>7</v></c></row></sheetData></worksheet>'),
});
const pptxBytes = zipSync({
  "ppt/presentation.xml": strToU8("<p:presentation/>"),
  "ppt/slides/slide1.xml": strToU8("<p:sld><a:p><a:r><a:t>Quarterly results</a:t></a:r></a:p><a:p><a:r><a:t>Revenue up 12%</a:t></a:r></a:p></p:sld>"),
});
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
  const documents = new Map<string, Record<string, unknown>>();
  const claims = new Map<string, { request_sha256: string | null; document_id: string; state: "active" | "deleted"; dispatch_state: "claimed" | "dispatching" }>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          calls.push({ sql, args });
          return {
            sql,
            args,
            async first() {
              if (sql.includes("FROM kb_document_idempotency_requests")) return claims.get(JSON.stringify(args.slice(0, 4))) ?? null;
              if (sql.startsWith("SELECT id,tenant_id,space_id,project_id,title,source_url,content_type,status"))
                return documents.get(String(args[0])) ?? null;
              if (sql.includes("SELECT id, space_id, tenant_id, project_id, title, source_url, content_type, status"))
                return documents.get(String(args[0])) ?? null;
              if (sql.includes("JOIN orgs")) return { id: "space-1" };
              if (sql.includes("SELECT config_json FROM spaces")) return { config_json: "{}" };
              if (sql.includes("FROM project_access")) return projectAuthorized ? { visibility: "private", role_rank: 50 } : null;
              if (sql.includes("SELECT plan_tier FROM orgs")) return { plan_tier: "free" };
              if (sql.includes("COUNT(*) as count FROM kb_documents")) return { count: 0 };
              if (sql.includes("FROM spaces")) return { id: "space-1" };
              return null;
            },
            async all() { return { results: [] }; },
            async run() {
              if (sql.includes("SET status = 'indexed'")) {
                const document = documents.get(String(args[3]));
                if (document) documents.set(String(args[3]), { ...document, status: "indexed", chunk_count: args[0] });
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(statements: Array<{ sql: string; args: unknown[] }>) {
      if (statements[0]?.sql.includes("INSERT INTO kb_document_idempotency_requests")) {
        const claimArgs = statements[0].args;
        const key = JSON.stringify(claimArgs.slice(0, 4));
        if (claims.has(key)) return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }];
        const values = statements[1]?.args ?? [];
        const id = String(values[0]);
        claims.set(key, { request_sha256: String(claimArgs[4]), document_id: id, state: "active", dispatch_state: "claimed" });
        documents.set(id, { id, space_id: values[1], tenant_id: values[2], project_id: values[3], title: values[4],
          source_url: values[5], content_type: values[6], status: "processing", chunk_count: 0,
          created_at: values[14], updated_at: values[15] });
        return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
      }
      return [];
    },
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
      head: vi.fn(async (key: string) => objects.has(key) ? { key } : null),
      delete: vi.fn(async (key: string | string[]) => { for (const item of Array.isArray(key) ? key : [key]) objects.delete(item); }),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    },
    KB_VECTORS: vectors,
    EVENTS_QUEUE: { send: vi.fn(async () => undefined) },
    AI: { run: vi.fn(async (_model: string, input: { text: string | string[] }) => ({
      data: (Array.isArray(input.text) ? input.text : [input.text]).map(() => [0.1, 0.2]),
    })) },
  } as never;
  return { env, calls, objects, vectors, documents, claims };
}

async function request(path: string, body: unknown): Promise<Request> {
  const token = await mintInternalToken("secret", "tenant-1");
  const requestBody = path === "/spaces/space-1/kb/documents" && body !== null && typeof body === "object"
    && !Array.isArray(body) && !("idempotency_key" in body)
    ? { ...body, idempotency_key: "test-pdf-request-key-0001" }
    : body;
  return new Request(`https://knowledge${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1",
      "x-naelao-internal-token": token, "x-naelao-user-id": "user-1", "x-naelao-role": "owner" },
    body: JSON.stringify(requestBody),
  });
}

function stubParser(markdown = "# Parsed guide\n\nOriginal extracted content.") {
  const parse = vi.fn(async () => new Response(JSON.stringify({ markdown }), { status: 200 }));
  vi.stubGlobal("fetch", parse);
  return parse;
}

afterEach(() => vi.unstubAllGlobals());

describe("Knowledge PDF preview and approved ingestion", () => {
  it("previews and ingests DOCX through bounded local extraction with signed source lineage", async () => {
    const f = fixture();
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const previewResponse = await worker.fetch(await request("/spaces/space-1/kb/documents/preview", {
      content: base64(docxBytes), source_file_name: "inventory.docx", project_id: "project-1",
    }), f.env, {} as ExecutionContext);
    expect(previewResponse.status).toBe(200);
    const { preview } = await previewResponse.json() as { preview: {
      content: string; extraction_sha256: string; preview_token: string; source_sha256: string; parser_version: string;
    } };
    expect(preview).toMatchObject({ content: "# Inventory\nSKU\tQty\n001\t0007", parser_version: "naelao:docx-main-body-v1" });
    expect(network).not.toHaveBeenCalled();

    const saved = await worker.fetch(await request("/spaces/space-1/kb/documents", {
      title: "Inventory", content: base64(docxBytes), content_type: "docx", source_file_name: "inventory.docx",
      preview_content: preview.content, preview_token: preview.preview_token,
      preview_extraction_sha256: preview.extraction_sha256, project_id: "project-1",
      idempotency_key: "docx-approved-request-key-001",
    }), f.env, {} as ExecutionContext);
    expect(saved.status).toBe(201);
    const record = f.calls.find(({ sql }) => sql.includes("INSERT INTO kb_documents"));
    expect(record?.args).toContain("docx");
    expect(record?.args).toContain("naelao:docx-main-body-v1");
    expect(record?.args).toContain(preview.source_sha256);
    expect([...f.objects.entries()].some(([key, bytes]) => key.endsWith("/original") && bytes.length === docxBytes.length)).toBe(true);
  });

  it("previews and ingests XLSX as editable first-sheet text with source lineage", async () => {
    const f = fixture();
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const previewResponse = await worker.fetch(await request("/spaces/space-1/kb/documents/preview", {
      content: base64(xlsxBytes), source_file_name: "inventory.xlsx", project_id: "project-1",
    }), f.env, {} as ExecutionContext);
    expect(previewResponse.status).toBe(200);
    const { preview } = await previewResponse.json() as { preview: {
      content: string; extraction_sha256: string; preview_token: string; source_sha256: string; parser_version: string;
    } };
    expect(preview).toMatchObject({ content: "SKU\tQty\n001\t=SUM(B3:B4)", parser_version: "naelao:xlsx-first-sheet-v1" });
    expect(network).not.toHaveBeenCalled();

    const saved = await worker.fetch(await request("/spaces/space-1/kb/documents", {
      title: "Inventory", content: base64(xlsxBytes), content_type: "xlsx", source_file_name: "inventory.xlsx",
      preview_content: preview.content, preview_token: preview.preview_token,
      preview_extraction_sha256: preview.extraction_sha256, project_id: "project-1",
      idempotency_key: "xlsx-approved-request-key-001",
    }), f.env, {} as ExecutionContext);
    expect(saved.status).toBe(201);
    const record = f.calls.find(({ sql }) => sql.includes("INSERT INTO kb_documents"));
    expect(record?.args).toContain("xlsx");
    expect(record?.args).toContain("naelao:xlsx-first-sheet-v1");
    expect(record?.args).toContain(preview.source_sha256);
    expect([...f.objects.entries()].some(([key, bytes]) => key.endsWith("/original") && bytes.length === xlsxBytes.length)).toBe(true);
  });

  it("previews and ingests PPTX slide text through signed source lineage", async () => {
    const f = fixture();
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const previewResponse = await worker.fetch(await request("/spaces/space-1/kb/documents/preview", {
      content: base64(pptxBytes), source_file_name: "quarterly.pptx", project_id: "project-1",
    }), f.env, {} as ExecutionContext);
    expect(previewResponse.status).toBe(200);
    const { preview } = await previewResponse.json() as { preview: {
      content: string; extraction_sha256: string; preview_token: string; source_sha256: string; parser_version: string; extraction_warnings: string[];
    } };
    expect(preview).toMatchObject({ content: "## Slide 1\nQuarterly results\nRevenue up 12%", parser_version: "naelao:pptx-slide-text-v1" });
    expect(preview.extraction_warnings[0]).toContain("PPTX preview extracts text");
    expect(network).not.toHaveBeenCalled();

    const saved = await worker.fetch(await request("/spaces/space-1/kb/documents", {
      title: "Quarterly results", content: base64(pptxBytes), content_type: "pptx", source_file_name: "quarterly.pptx",
      preview_content: preview.content, preview_token: preview.preview_token,
      preview_extraction_sha256: preview.extraction_sha256, project_id: "project-1",
      idempotency_key: "pptx-approved-request-key-001",
    }), f.env, {} as ExecutionContext);
    expect(saved.status).toBe(201);
    const record = f.calls.find(({ sql }) => sql.includes("INSERT INTO kb_documents"));
    expect(record?.args).toContain("pptx");
    expect(record?.args).toContain("naelao:pptx-slide-text-v1");
    expect(record?.args).toContain(preview.source_sha256);
    expect([...f.objects.entries()].some(([key, bytes]) => key.endsWith("/original") && bytes.length === pptxBytes.length)).toBe(true);
  });

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
    const createBody = {
      title: "Reviewed guide", content: base64(pdfBytes), content_type: "pdf", source_file_name: "guide.pdf",
      preview_content: "# Corrected heading\n\nApproved content after human review.",
      preview_token: preview.preview_token, preview_extraction_sha256: preview.extraction_sha256,
      idempotency_key: "reviewed-pdf-request-key-0001",
    };
    const createResponse = await worker.fetch(await request("/spaces/space-1/kb/documents", createBody), f.env, {} as ExecutionContext);

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { id: string };
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
    const writeCount = f.objects.size;
    const idempotentRetry = await worker.fetch(await request("/spaces/space-1/kb/documents", {
      ...createBody, preview_token: "expired-preview-token",
    }), f.env, {} as ExecutionContext);
    expect(idempotentRetry.status).toBe(200);
    expect(await idempotentRetry.json()).toMatchObject({ id: created.id, status: "indexed" });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(f.vectors.upsert).toHaveBeenCalledTimes(1);
    expect(f.objects.size).toBe(writeCount);
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
