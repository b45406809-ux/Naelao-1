import { describe, expect, it } from "vitest";
import { decodeWorkerCheckpoint, encodeWorkerCheckpoint } from "./worker-checkpoint.js";

describe("durable worker checkpoint envelope", () => {
  it("writes version and attempt metadata while preserving the payload", () => {
    const raw = encodeWorkerCheckpoint({ next: "verify workspace" }, { attempt: 3, savedAt: 1234 });
    expect(JSON.parse(raw)).toMatchObject({ schema_version: 1, format: "naelao.worker-checkpoint", attempt: 3, saved_at: 1234 });
    expect(decodeWorkerCheckpoint(raw)).toEqual({ schemaVersion: 1, payload: { next: "verify workspace" }, savedAt: 1234, attempt: 3 });
  });

  it("continues to read historical raw JSON checkpoint values", () => {
    expect(decodeWorkerCheckpoint('{"progress":"legacy"}')).toEqual({ schemaVersion: 0, payload: { progress: "legacy" } });
  });

  it("bounds oversized checkpoints with an explicit truncated versioned receipt", () => {
    const raw = encodeWorkerCheckpoint("x".repeat(80_000), { attempt: 2, savedAt: 42 });
    expect(raw.length).toBeLessThanOrEqual(64_512);
    expect(decodeWorkerCheckpoint(raw)).toMatchObject({ schemaVersion: 1, savedAt: 42, attempt: 2, truncated: true,
      payload: { truncated: true, original_chars: expect.any(Number), preview: expect.any(String) } });
  });

  it("rejects malformed versioned envelopes and oversized stored values", () => {
    expect(decodeWorkerCheckpoint('{"schema_version":1,"format":"naelao.worker-checkpoint","saved_at":-1,"payload":{}}')).toBeNull();
    expect(decodeWorkerCheckpoint("x".repeat(65_000))).toBeNull();
  });
});
