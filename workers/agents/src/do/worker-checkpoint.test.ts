import { describe, expect, it } from "vitest";
import { decodeWorkerCheckpoint, encodeWorkerCheckpoint } from "./worker-checkpoint.js";

describe("durable worker checkpoint envelope", () => {
  it("writes version and attempt metadata while preserving the payload", () => {
    const raw = encodeWorkerCheckpoint({ next: "verify workspace" }, { attempt: 3, savedAt: 1234 });
    expect(JSON.parse(raw)).toMatchObject({ schema_version: 2, format: "naelao.worker-checkpoint", attempt: 3, saved_at: 1234,
      workspace_pin_status: "not_applicable", lineage: [] });
    expect(decodeWorkerCheckpoint(raw)).toEqual({ schemaVersion: 2, payload: { next: "verify workspace" }, savedAt: 1234, attempt: 3,
      workspacePinStatus: "not_applicable", lineage: [] });
  });

  it("pins checkpoints to an exact workspace head and keeps a bounded metadata lineage", () => {
    const pin = { branch: "workers/task-1", revision: 7, manifestHash: "a".repeat(64) };
    const raw = encodeWorkerCheckpoint({ next: "inspect" }, { attempt: 2, savedAt: 1234, workspacePin: pin,
      lineage: Array.from({ length: 10 }, (_, index) => ({ savedAt: index + 1, attempt: index + 1 })) });
    expect(JSON.parse(raw).lineage).toHaveLength(8);
    const decoded = decodeWorkerCheckpoint(raw);
    expect(decoded).toMatchObject({ schemaVersion: 2, workspacePin: pin, workspacePinStatus: "pinned" });
    expect(decoded?.lineage).toHaveLength(8);
    expect(decoded?.lineage?.slice(0, 2)).toEqual([{ savedAt: 3, attempt: 3 }, { savedAt: 4, attempt: 4 }]);
  });

  it("continues to read historical raw JSON checkpoint values", () => {
    expect(decodeWorkerCheckpoint('{"progress":"legacy"}')).toEqual({ schemaVersion: 0, payload: { progress: "legacy" } });
  });

  it("continues to read v1 envelopes without claiming workspace verification", () => {
    const raw = JSON.stringify({ schema_version: 1, format: "naelao.worker-checkpoint", saved_at: 1234, attempt: 1, payload: { p: 1 } });
    expect(decodeWorkerCheckpoint(raw)).toEqual({ schemaVersion: 1, payload: { p: 1 }, savedAt: 1234, attempt: 1 });
  });

  it("bounds oversized checkpoints with an explicit truncated versioned receipt", () => {
    const raw = encodeWorkerCheckpoint("x".repeat(80_000), { attempt: 2, savedAt: 42 });
    expect(raw.length).toBeLessThanOrEqual(64_512);
    expect(decodeWorkerCheckpoint(raw)).toMatchObject({ schemaVersion: 2, savedAt: 42, attempt: 2, truncated: true,
      payload: { truncated: true, original_chars: expect.any(Number), preview: expect.any(String) } });
  });

  it("rejects malformed versioned envelopes and oversized stored values", () => {
    expect(decodeWorkerCheckpoint('{"schema_version":1,"format":"naelao.worker-checkpoint","saved_at":-1,"payload":{}}')).toBeNull();
    expect(decodeWorkerCheckpoint("x".repeat(65_000))).toBeNull();
  });
});
