import { describe, expect, it } from "vitest";
import { MAX_KNOWLEDGE_IMAGE_BYTES, MAX_KNOWLEDGE_IMAGE_PIXELS, validateKnowledgeRasterImage } from "./image-preview.js";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a], 0);
  bytes.set([0x49,0x48,0x44,0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

describe("bounded Knowledge image preview", () => {
  it("accepts only bounded PNG headers and rejects excess pixels or bytes", () => {
    expect(validateKnowledgeRasterImage("image/png", png(1000, 1000))).toEqual({ width: 1000, height: 1000 });
    expect(() => validateKnowledgeRasterImage("image/png", png(MAX_KNOWLEDGE_IMAGE_PIXELS + 1, 1)))
      .toThrow("knowledge_image_pixels_exceeded");
    expect(() => validateKnowledgeRasterImage("image/png", new Uint8Array(MAX_KNOWLEDGE_IMAGE_BYTES + 1)))
      .toThrow("knowledge_image_size_invalid");
    expect(() => validateKnowledgeRasterImage("image/jpeg", png(10, 10))).toThrow("knowledge_image_header_invalid");
  });

  it("finds JPEG dimensions without decoding the raster", () => {
    const bytes = new Uint8Array([0xff,0xd8, 0xff,0xc0,0x00,0x08,0x08,0x00,0x20,0x00,0x30,0x01,0xff,0xd9]);
    expect(validateKnowledgeRasterImage("image/jpeg", bytes)).toEqual({ width: 48, height: 32 });
  });
});
