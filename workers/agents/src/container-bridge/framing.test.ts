import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, FRAME_FLAGS, MultiplexedBridge } from "./framing.js";

describe("multiplexed binary bridge", () => {
  it("decodes partial frames and keeps concurrent correlations isolated", async () => {
    const writes: Uint8Array[] = [];
    const bridge = new MultiplexedBridge({ write: (data) => writes.push(data) }, 100);
    const a = bridge.request(new TextEncoder().encode("a"));
    const b = bridge.request(new TextEncoder().encode("b"));
    const decoder = new FrameDecoder();
    const requestFrames = writes.flatMap((wire) => decoder.push(wire));
    bridge.receive({ ...requestFrames[1]!, flags: FRAME_FLAGS.END, payload: new TextEncoder().encode("B") });
    bridge.receive({ ...requestFrames[0]!, flags: FRAME_FLAGS.STDOUT, payload: new TextEncoder().encode("A1") });
    bridge.receive({ ...requestFrames[0]!, flags: FRAME_FLAGS.END, payload: new TextEncoder().encode("A2") });
    expect((await b).map((v) => new TextDecoder().decode(v))).toEqual(["B"]);
    expect((await a).map((v) => new TextDecoder().decode(v))).toEqual(["A1", "A2"]);
    expect(bridge.pendingCount).toBe(0);
  });

  it("cleans timed-out and aborted correlations", async () => {
    const bridge = new MultiplexedBridge({ write: () => undefined }, 5);
    await expect(bridge.request(new Uint8Array())).rejects.toThrow("bridge_request_timeout");
    const controller = new AbortController();
    const pending = bridge.request(new Uint8Array(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(bridge.pendingCount).toBe(0);
  });

  it("round trips the specified 4+16+2 byte header", () => {
    const encoded = encodeFrame({ correlationId: new Uint8Array(16).fill(7), flags: 9, payload: new Uint8Array([1, 2]) });
    expect(encoded.byteLength).toBe(24);
    expect(new FrameDecoder().push(encoded)[0]).toMatchObject({ flags: 9, payload: new Uint8Array([1, 2]) });
  });
});
