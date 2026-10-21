import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { EMAIL_OCR_ADMISSION_SQL, EMAIL_OCR_MAX_ATTEMPTS_PER_SPACE_PER_DAY, EMAIL_OCR_MAX_BYTES, EMAIL_OCR_MAX_TEXT_CHARS, EMAIL_OCR_MODEL, EmailOcrError, extractEmailImageOcr, rasterImageDimensions, reserveEmailOcrAttempt } from "./email-ocr.js";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

describe("explicit email image OCR", () => {
  it("bounds image dimensions and sends a data URI to the documented OCR model", async () => {
    const ai = { run: vi.fn(async () => ({ answer: "Invoice 104\nTotal $25.00" })) };
    const result = await extractEmailImageOcr(ai, "image/png", png(1200, 1600));
    expect(result).toEqual({ width: 1200, height: 1600, text: "Invoice 104\nTotal $25.00" });
    expect(ai.run).toHaveBeenCalledWith(EMAIL_OCR_MODEL, expect.objectContaining({
      image: expect.stringMatching(/^data:image\/png;base64,/),
      task: "query",
      max_tokens: 1024,
      reasoning: false,
      temperature: 0,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("parses JPEG dimensions without decoding image pixels", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0xff, 0xda]);
    expect(rasterImageDimensions("image/jpeg", jpeg)).toEqual({ width: 3, height: 2 });
  });

  it("rejects unsupported/malformed, oversized, and pixel-bomb image data before inference", async () => {
    const ai = { run: vi.fn(async () => ({ answer: "should not run" })) };
    await expect(extractEmailImageOcr(ai, "image/gif", png(2, 2))).rejects.toBeInstanceOf(EmailOcrError);
    await expect(extractEmailImageOcr(ai, "image/png", png(6000, 4000))).rejects.toMatchObject({ code: "attachment_ocr_pixels_limit" });
    await expect(extractEmailImageOcr(ai, "image/png", new Uint8Array(EMAIL_OCR_MAX_BYTES + 1))).rejects.toBeInstanceOf(EmailOcrError);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("returns only bounded, explicit OCR text and fails when the model gives no text", async () => {
    const ai = { run: vi.fn(async () => ({ answer: " " })) };
    await expect(extractEmailImageOcr(ai, "image/png", png(2, 2))).rejects.toMatchObject({ code: "attachment_ocr_no_text" });
  });

  it("truncates an unexpectedly large provider answer to the output contract", async () => {
    const ai = { run: vi.fn(async () => ({ answer: "x".repeat(EMAIL_OCR_MAX_TEXT_CHARS + 1) })) };
    const result = await extractEmailImageOcr(ai, "image/png", png(2, 2));
    expect(result.text).toHaveLength(EMAIL_OCR_MAX_TEXT_CHARS);
  });

  it("atomically enforces a rolling per-Space daily OCR call limit in SQLite", async () => {
    const storage = createDOStorage();
    storage.sql.exec(readFileSync(join(__dirname, "../../../../infra/migrations/0100_email_attachment_ocr_usage.sql"), "utf8"));
    const db = {
      prepare(sql: string) {
        expect(sql).toBe(EMAIL_OCR_ADMISSION_SQL);
        return { bind(...values: unknown[]) {
          return { run: async () => ({ meta: { changes: storage.sql.exec(sql, ...values).rowsWritten } }) };
        } };
      },
    };
    const now = new Date("2026-10-15T12:00:00.000Z");
    for (let attempt = 0; attempt < EMAIL_OCR_MAX_ATTEMPTS_PER_SPACE_PER_DAY; attempt++) {
      await expect(reserveEmailOcrAttempt(db as never, {
        id: `attempt-${attempt}`, tenantId: "tenant-1", spaceId: "space-1", now,
      })).resolves.toBe(true);
    }
    await expect(reserveEmailOcrAttempt(db as never, {
      id: "attempt-limit", tenantId: "tenant-1", spaceId: "space-1", now,
    })).resolves.toBe(false);
    await expect(reserveEmailOcrAttempt(db as never, {
      id: "other-space", tenantId: "tenant-1", spaceId: "space-2", now,
    })).resolves.toBe(true);
  });
});
