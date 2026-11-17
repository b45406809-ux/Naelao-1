export const KNOWLEDGE_IMAGE_PARSER_VERSION = "cohere:parse-v5.0-image-ocr-v1";
export const MAX_KNOWLEDGE_IMAGE_BYTES = 1_048_576;
export const MAX_KNOWLEDGE_IMAGE_PIXELS = 20_000_000;

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! * 0x1000000) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!) >>> 0;
}

/** Inspect only the bounded image header; never decompress untrusted pixels in the Worker. */
export function validateKnowledgeRasterImage(mimeType: string, bytes: Uint8Array): { width: number; height: number } {
  if (!bytes.length || bytes.length > MAX_KNOWLEDGE_IMAGE_BYTES) throw new Error("knowledge_image_size_invalid");
  let width = 0;
  let height = 0;
  if (mimeType === "image/png" && bytes.length >= 24
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) {
    width = u32(bytes, 16);
    height = u32(bytes, 20);
  } else if (mimeType === "image/jpeg" && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    let offset = 2;
    const end = Math.min(bytes.length - 2, 128 * 1024);
    while (offset + 4 <= end) {
      if (bytes[offset] !== 0xff) throw new Error("knowledge_image_header_invalid");
      while (offset < end && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
      if (offset + 2 > end) break;
      const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
      if (length < 2 || offset + length > end) throw new Error("knowledge_image_header_invalid");
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 7) throw new Error("knowledge_image_header_invalid");
        height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
        width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
        break;
      }
      offset += length;
    }
  }
  if (!width || !height) throw new Error("knowledge_image_header_invalid");
  if (width * height > MAX_KNOWLEDGE_IMAGE_PIXELS) throw new Error("knowledge_image_pixels_exceeded");
  return { width, height };
}
