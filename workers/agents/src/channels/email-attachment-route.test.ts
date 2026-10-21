import { describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { mintInternalToken } from "@naelao/http";
import { app } from "../index.js";

const secret = "attachment-test-secret";
const owned = {
  tenant: "tenant-1", space: "space-1", task: "task-1", key: "spaces/space-1/email-inbound/task-1/a/invoice.pdf",
};

function onePagePdf(): Uint8Array {
  const stream = "BT /F1 12 Tf 72 720 Td (Scoped attachment text) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts = ["%PDF-1.4\n% route fixture\n"];
  const offsets = [0];
  let size = new TextEncoder().encode(parts[0]).length;
  objects.forEach((object, index) => {
    offsets.push(size);
    const part = `${index + 1} 0 obj\n${object}\nendobj\n`;
    parts.push(part);
    size += new TextEncoder().encode(part).length;
  });
  const xref = size;
  parts.push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new TextEncoder().encode(parts.join(""));
}

function makeEnv(options: { matchingTask?: boolean; active?: boolean; bytes?: Uint8Array; mime?: string } = {}) {
  let r2Reads = 0;
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: {
      prepare(sql: string) {
        return { bind(...values: unknown[]) {
          return { async first() {
            if (sql.includes("SELECT s.id FROM spaces s WHERE")) return options.active === false ? null : { id: owned.space };
            expect(sql).toContain("WHERE object_key = ? AND tenant_id = ? AND space_id = ? AND task_id = ? AND expires_at > ?");
            expect(values).toEqual([owned.key, owned.tenant, owned.space, owned.task, expect.any(String)]);
            return options.matchingTask === false ? null : { object_key: owned.key };
          } };
        } };
      },
    },
    SCRIPTS_R2: {
      async get(key: string) {
        r2Reads++;
        expect(key).toBe(owned.key);
        const bytes = options.bytes ?? onePagePdf();
        return { size: bytes.byteLength, httpMetadata: { contentType: options.mime ?? "application/pdf" }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      },
    },
  };
  return { env: env as never, r2Reads: () => r2Reads };
}

function smallPng(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, 5);
  new DataView(bytes.buffer).setUint32(20, 5);
  return bytes;
}

function makeOcrEnv(options: { matchingTask?: boolean; enabled?: boolean; airGapped?: boolean; active?: boolean; mime?: string; attemptAllowed?: boolean; bytes?: Uint8Array; oversizedRenderResponse?: boolean } = {}) {
  let r2Reads = 0;
  let documentSandboxCalls = 0;
  const ai = { run: vi.fn(async () => ({ answer: "Invoice 42\nTotal $10.00" })) };
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: {
      prepare(sql: string) {
        return { bind(...values: unknown[]) {
          return { async first() {
            if (sql.includes("SELECT s.id FROM spaces s WHERE")) return options.active === false ? null : { id: owned.space };
            if (sql.includes("SELECT status,config_json FROM spaces")) return {
              status: "active",
              config_json: JSON.stringify({ productConfig: { attachmentOcr: { enabled: options.enabled ?? true }, compliance: { airGappedOnly: options.airGapped ?? false } } }),
            };
            if (sql.includes("SELECT config_json FROM spaces")) return {
              config_json: JSON.stringify({ productConfig: { compliance: { airGappedOnly: options.airGapped ?? false } } }),
            };
            if (sql.includes("email_inbound_attachments")) {
              expect(values).toEqual([owned.key, owned.tenant, owned.space, owned.task, expect.any(String)]);
              return options.matchingTask === false ? null : { object_key: owned.key };
            }
            throw new Error(`unexpected SQL: ${sql}`);
          }, async run() {
            if (sql.includes("email_attachment_ocr_usage")) return { meta: { changes: options.attemptAllowed === false ? 0 : 1 } };
            throw new Error(`unexpected SQL run: ${sql}`);
          } };
        } };
      },
    },
    SCRIPTS_R2: {
      async get(key: string) {
        r2Reads++;
        expect(key).toBe(owned.key);
        const bytes = options.bytes ?? smallPng();
        return { size: bytes.byteLength, httpMetadata: { contentType: options.mime ?? "image/png" }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      },
    },
    DOCUMENT_SANDBOX: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        async fetch(request: Request) {
          documentSandboxCalls++;
          expect(id).toBe("sandbox:space-1:_assistant");
          expect(request.url).toBe("http://document-sandbox/pdf/render");
          expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
          expect(JSON.parse(request.headers.get("x-naelao-container-scope") ?? "{}")).toMatchObject({
            tenantId: "tenant-1", spaceId: "space-1", actorId: "attachment-reader", runId: "task-1", timeoutMs: 45_000,
          });
          const input = await request.json() as { firstPage: number; lastPage: number; pdfBase64: string };
          expect(input).toMatchObject({ firstPage: 1, lastPage: 5 });
          expect(input.pdfBase64).toBeTruthy();
          if (options.oversizedRenderResponse) {
            let chunks = 0;
            return new Response(new ReadableStream<Uint8Array>({
              pull(controller) {
                chunks++;
                if (chunks <= 3) controller.enqueue(new Uint8Array(3 * 1024 * 1024));
                else controller.close();
              },
            }));
          }
          return Response.json({ pages: [{ page: 1, width: 5, height: 5, pngBase64: btoa(String.fromCharCode(...smallPng())) }], output_bytes: 24 });
        },
      }),
    },
    AI: ai,
  };
  return { env: env as never, r2Reads: () => r2Reads, ai, documentSandboxCalls: () => documentSandboxCalls };
}

async function readAttachment(env: never, overrides: Partial<typeof owned> = {}) {
  const tenantId = overrides.tenant ?? owned.tenant;
  return app.request("/internal/business-email/attachment/read-text", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(secret, tenantId),
    },
    body: JSON.stringify({
      tenantId,
      spaceId: overrides.space ?? owned.space,
      taskId: overrides.task ?? owned.task,
      key: overrides.key ?? owned.key,
    }),
  }, env);
}

async function ocrAttachment(env: never, overrides: Partial<typeof owned> = {}) {
  const tenantId = overrides.tenant ?? owned.tenant;
  return app.request("/internal/business-email/attachment/ocr", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(secret, tenantId),
    },
    body: JSON.stringify({ tenantId, spaceId: overrides.space ?? owned.space, taskId: overrides.task ?? owned.task, key: overrides.key ?? owned.key }),
  }, env);
}

describe("task-scoped email PDF attachment endpoint", () => {
  it("does not read an attachment after its tenant or Space is suspended", async () => {
    const state = makeEnv({ active: false });
    const response = await readAttachment(state.env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect(state.r2Reads()).toBe(0);
  });

  it("parses a PDF only after matching tenant, Space, task, key, and expiry authorization", async () => {
    const state = makeEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const response = await readAttachment(state.env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        attachment_id: null,
        mime_type: "application/pdf",
        pages: 1,
        text: expect.stringContaining("Scoped attachment text"),
      });
      expect(state.r2Reads()).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not read R2 when the attachment belongs to another task", async () => {
    const state = makeEnv({ matchingTask: false });
    const response = await readAttachment(state.env);
    expect(response.status).toBe(404);
    expect(state.r2Reads()).toBe(0);
  });

  it("keeps archives and HTML unsupported", async () => {
    for (const mime of ["application/zip", "text/html"]) {
      const state = makeEnv({ mime });
      const response = await readAttachment(state.env);
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ error_code: "attachment_not_text", mime_type: mime });
    }
  });

  it("extracts bounded DOCX text only after the same task-scoped authorization", async () => {
    const bytes = zipSync({
      "[Content_Types].xml": new TextEncoder().encode("<Types/>"),
      "word/document.xml": new TextEncoder().encode("<w:document><w:body><w:p><w:r><w:t>Task-scoped Word text</w:t></w:r></w:p></w:body></w:document>"),
      "word/media/image.png": new TextEncoder().encode("ignored"),
    });
    const state = makeEnv({ bytes, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const response = await readAttachment(state.env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        attachment_id: null,
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        text: expect.stringContaining("Task-scoped Word text"),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("explicit task-scoped email image OCR endpoint", () => {
  it("does not read or analyze attachments after their tenant or Space is suspended", async () => {
    const state = makeOcrEnv({ active: false });
    const response = await ocrAttachment(state.env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect(state.r2Reads()).toBe(0);
    expect(state.documentSandboxCalls()).toBe(0);
    expect(state.ai.run).not.toHaveBeenCalled();
  });

  it("invokes hosted OCR only after owner opt-in, egress permission, and task ownership checks", async () => {
    const state = makeOcrEnv();
    const response = await ocrAttachment(state.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mime_type: "image/png", model: "@cf/moondream/moondream3.1-9B-A2B", width: 5, height: 5,
      text: expect.stringContaining("Invoice 42"),
    });
    expect(state.r2Reads()).toBe(1);
    expect(state.ai.run).toHaveBeenCalledTimes(1);
  });

  it("does not read attachment bytes when owner opt-in is off or the Space is air-gapped", async () => {
    const disabled = makeOcrEnv({ enabled: false });
    expect((await ocrAttachment(disabled.env)).status).toBe(403);
    expect(disabled.r2Reads()).toBe(0);
    expect(disabled.ai.run).not.toHaveBeenCalled();
    const privateSpace = makeOcrEnv({ airGapped: true });
    expect((await ocrAttachment(privateSpace.env)).status).toBe(403);
    expect(privateSpace.r2Reads()).toBe(0);
    expect(privateSpace.ai.run).not.toHaveBeenCalled();
  });

  it("does not read or invoke OCR for another task or an unsupported file type", async () => {
    const wrongTask = makeOcrEnv({ matchingTask: false });
    expect((await ocrAttachment(wrongTask.env)).status).toBe(404);
    expect(wrongTask.r2Reads()).toBe(0);
    const unsupported = makeOcrEnv({ mime: "application/zip" });
    expect((await ocrAttachment(unsupported.env)).status).toBe(415);
    expect(unsupported.ai.run).not.toHaveBeenCalled();
  });

  it("renders scanned PDF pages in the isolated document sandbox before bounded OCR", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\nfixture");
    const state = makeOcrEnv({ mime: "application/pdf", bytes: pdf });
    const response = await ocrAttachment(state.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mime_type: "application/pdf", pages: [{ page: 1, text: "Invoice 42\nTotal $10.00" }],
      text: expect.stringContaining("[UNTRUSTED OCR FROM SCANNED PDF"),
    });
    expect(state.ai.run).toHaveBeenCalledTimes(1);
  });

  it("does not invoke OCR after the per-Space daily attempt limit is reached", async () => {
    const exhausted = makeOcrEnv({ attemptAllowed: false });
    const response = await ocrAttachment(exhausted.env);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error_code: "attachment_ocr_daily_limit_reached", max_attempts_per_day: 20 });
    expect(exhausted.ai.run).not.toHaveBeenCalled();
  });

  it("checks the PDF OCR daily limit before rendering pages in the document sandbox", async () => {
    const exhausted = makeOcrEnv({ attemptAllowed: false, mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4\nfixture") });
    const response = await ocrAttachment(exhausted.env);
    expect(response.status).toBe(429);
    expect(exhausted.documentSandboxCalls()).toBe(0);
    expect(exhausted.ai.run).not.toHaveBeenCalled();
  });

  it("rejects an oversized document sandbox response before parsing or OCR", async () => {
    const state = makeOcrEnv({ mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4\nfixture"), oversizedRenderResponse: true });
    const response = await ocrAttachment(state.env);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error_code: "pdf_render_output_limit" });
    expect(state.ai.run).not.toHaveBeenCalled();
  });
});
