import { describe, expect, it } from "vitest";
import { PROVENANCE_GENESIS_HASH, provenanceHmac } from "./SpaceDO.js";

describe("provenance hash chain", () => {
  it("links entries and detects tampering", async () => {
    const fields = [PROVENANCE_GENESIS_HASH, "human", "assistant", "executor", "a".repeat(40), "2026-01-01T00:00:00.000Z"];
    const hash = await provenanceHmac("audit-secret", fields);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await provenanceHmac("audit-secret", fields)).toBe(hash);
    expect(await provenanceHmac("audit-secret", [...fields.slice(0, 2), "tampered", ...fields.slice(3)])).not.toBe(hash);
    const next = await provenanceHmac("audit-secret", [hash, ...fields.slice(1)]);
    expect(next).not.toBe(hash);
  });
});
