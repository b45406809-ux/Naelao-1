/** A small R2 mock with the byte, metadata, and conditional-write behavior used in production. */
export function makeR2Bucket(initial: Record<string, string> = {}): R2Bucket {
  const objects = new Map<string, { bytes: Uint8Array; etag: string; customMetadata?: Record<string, string> }>();
  let revision = 0;
  for (const [key, value] of Object.entries(initial)) {
    objects.set(key, { bytes: new TextEncoder().encode(value), etag: `e${++revision}` });
  }
  return {
    async put(key: string, value: unknown, options?: R2PutOptions) {
      const current = objects.get(key);
      const condition = options?.onlyIf as { etagMatches?: string; etagDoesNotMatch?: string } | undefined;
      if (condition?.etagMatches !== undefined && current?.etag !== condition.etagMatches) return null;
      if (condition?.etagDoesNotMatch === "*" && current) return null;
      const bytes = value instanceof Uint8Array ? value.slice()
        : value instanceof ArrayBuffer ? new Uint8Array(value.slice(0))
          : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
            : new TextEncoder().encode(typeof value === "string" ? value : String(value));
      const etag = `e${++revision}`;
      objects.set(key, { bytes, etag, customMetadata: options?.customMetadata });
      return { key, etag, size: bytes.byteLength } as R2Object;
    },
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const object = objects.get(key);
      if (!object) return null;
      const fullBytes = object.bytes.slice();
      const range = options?.range;
      const bytes = range ? fullBytes.slice(range.offset, range.offset + range.length) : fullBytes;
      return {
        key, size: fullBytes.byteLength, etag: object.etag, customMetadata: object.customMetadata,
        uploaded: new Date(),
        async arrayBuffer() { return bytes.slice().buffer; },
        async text() { return new TextDecoder().decode(bytes); },
        get body() {
          return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } });
        },
      } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const object = objects.get(key);
      return object ? { key, size: object.bytes.byteLength, etag: object.etag, customMetadata: object.customMetadata, uploaded: new Date() } as R2Object : null;
    },
    async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? "";
      const listed = [...objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, object]) => ({
        key, size: object.bytes.byteLength, etag: object.etag, customMetadata: object.customMetadata, uploaded: new Date(),
      }));
      return { objects: listed, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}
