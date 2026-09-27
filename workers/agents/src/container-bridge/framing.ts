export const FRAME_HEADER_BYTES = 22;
export const FRAME_FLAGS = {
  END: 1,
  ERROR: 2,
  STDOUT: 4,
  STDERR: 8,
  AST_DIFF: 16,
} as const;

export interface BridgeFrame {
  correlationId: Uint8Array;
  flags: number;
  payload: Uint8Array;
}

export function encodeFrame(frame: BridgeFrame): Uint8Array {
  if (frame.correlationId.byteLength !== 16)
    throw new Error("correlation_id_must_be_16_bytes");
  const result = new Uint8Array(FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, frame.payload.byteLength, false);
  result.set(frame.correlationId, 4);
  view.setUint16(20, frame.flags, false);
  result.set(frame.payload, FRAME_HEADER_BYTES);
  return result;
}

/** Incremental decoder: partial and coalesced TCP packets are both supported. */
export class FrameDecoder {
  private buffered = new Uint8Array();

  push(chunk: Uint8Array): BridgeFrame[] {
    const joined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
    joined.set(this.buffered);
    joined.set(chunk, this.buffered.byteLength);
    const frames: BridgeFrame[] = [];
    let offset = 0;
    while (joined.byteLength - offset >= FRAME_HEADER_BYTES) {
      const length = new DataView(
        joined.buffer,
        joined.byteOffset + offset,
        FRAME_HEADER_BYTES
      ).getUint32(0, false);
      if (length > 32 * 1024 * 1024) throw new Error("bridge_frame_too_large");
      if (joined.byteLength - offset < FRAME_HEADER_BYTES + length) break;
      frames.push({
        correlationId: joined.slice(offset + 4, offset + 20),
        flags: new DataView(joined.buffer, joined.byteOffset + offset + 20, 2).getUint16(0, false),
        payload: joined.slice(offset + FRAME_HEADER_BYTES, offset + FRAME_HEADER_BYTES + length),
      });
      offset += FRAME_HEADER_BYTES + length;
    }
    this.buffered = joined.slice(offset);
    return frames;
  }
}

export function correlationKey(id: Uint8Array): string {
  return [...id].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface BinaryTransport {
  write(data: Uint8Array): Promise<void> | void;
  close?(): void;
}

/** Correlates concurrent full-duplex calls and guarantees cleanup on every terminal path. */
export class MultiplexedBridge {
  private readonly pending = new Map<string, {
    resolve: (value: Uint8Array[]) => void;
    reject: (reason: Error) => void;
    chunks: Uint8Array[];
    timer: ReturnType<typeof setTimeout>;
    abort?: () => void;
  }>();

  constructor(private readonly transport: BinaryTransport, private readonly timeoutMs = 30_000) {}

  request(payload: Uint8Array, signal?: AbortSignal): Promise<Uint8Array[]> {
    const id = crypto.getRandomValues(new Uint8Array(16));
    const key = correlationKey(id);
    return new Promise((resolve, reject) => {
      const finishError = (error: Error) => {
        this.cleanup(key);
        reject(error);
      };
      const timer = setTimeout(() => finishError(new Error("bridge_request_timeout")), this.timeoutMs);
      const abort = signal ? () => finishError(new DOMException("Aborted", "AbortError")) : undefined;
      if (signal?.aborted) { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); return; }
      if (abort) signal!.addEventListener("abort", abort, { once: true });
      this.pending.set(key, { resolve, reject, chunks: [], timer, ...(abort ? { abort } : {}) });
      Promise.resolve(this.transport.write(encodeFrame({ correlationId: id, flags: FRAME_FLAGS.END, payload })))
        .catch((error) => finishError(error instanceof Error ? error : new Error(String(error))));
    });
  }

  receive(frame: BridgeFrame): void {
    const key = correlationKey(frame.correlationId);
    const request = this.pending.get(key);
    if (!request) return; // Late/foreign frame can never be delivered to another request.
    request.chunks.push(frame.payload);
    if (frame.flags & FRAME_FLAGS.ERROR) {
      const message = new TextDecoder().decode(frame.payload);
      this.cleanup(key);
      request.reject(new Error(message));
    } else if (frame.flags & FRAME_FLAGS.END) {
      this.cleanup(key);
      request.resolve(request.chunks);
    }
  }

  disconnect(reason = "bridge_disconnected"): void {
    for (const [key, request] of [...this.pending]) {
      this.cleanup(key);
      request.reject(new Error(reason));
    }
  }

  get pendingCount(): number { return this.pending.size; }

  private cleanup(key: string): void {
    const request = this.pending.get(key);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(key);
  }
}
