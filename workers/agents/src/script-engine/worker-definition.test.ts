import { describe, expect, it } from "vitest";
import { parseWorkerDefinitionV1 } from "./worker-definition";

const eph = () => ({
  schema_version: 1,
  id: "reviewer",
  name: "Reviewer",
  kind: "ephemeral",
  instructions: "Review it.",
  capabilities: ["files.read", "search"],
  max_tokens: 4000,
  evidence_required: true,
});
const long = () => ({
  ...eph(),
  kind: "long_running",
  max_active_minutes: 60,
  max_approval_wait_minutes: 120,
  on_expiry: "fail",
});

describe("parseWorkerDefinitionV1", () => {
  it("accepts a valid ephemeral definition", () => {
    expect(parseWorkerDefinitionV1(eph()).kind).toBe("ephemeral");
  });
  it("accepts a valid long_running definition with a model hint", () => {
    const d = parseWorkerDefinitionV1({ ...long(), model_hint: "claude-sonnet-4-6" });
    expect(d.kind === "long_running" && d.max_active_minutes).toBe(60);
  });
  it("enforces bounds at their edges", () => {
    const ok = (o: object) => parseWorkerDefinitionV1(o);
    expect(() => ok({ ...eph(), max_tokens: 1000 })).not.toThrow();
    expect(() => ok({ ...eph(), max_tokens: 200000 })).not.toThrow();
    expect(() => ok({ ...eph(), max_tokens: 999 })).toThrow();
    expect(() => ok({ ...eph(), max_tokens: 200001 })).toThrow();
    expect(() => ok({ ...eph(), instructions: "x".repeat(8000) })).not.toThrow();
    expect(() => ok({ ...eph(), instructions: "x".repeat(8001) })).toThrow();
    const caps = (n: number) => Array.from({ length: n }, (_, i) => `op${i}`);
    expect(() => ok({ ...eph(), capabilities: caps(64) })).not.toThrow();
    expect(() => ok({ ...eph(), capabilities: caps(65) })).toThrow();
    expect(() => ok({ ...eph(), capabilities: ["Bad Name"] })).toThrow();
    expect(() => ok({ ...long(), max_active_minutes: 1 })).not.toThrow();
    expect(() => ok({ ...long(), max_active_minutes: 1440 })).not.toThrow();
    expect(() => ok({ ...long(), max_active_minutes: 0 })).toThrow();
    expect(() => ok({ ...long(), max_active_minutes: 1441 })).toThrow();
    expect(() => ok({ ...long(), max_approval_wait_minutes: 1 })).not.toThrow();
    expect(() => ok({ ...long(), max_approval_wait_minutes: 10080 })).not.toThrow();
    expect(() => ok({ ...long(), max_approval_wait_minutes: 0 })).toThrow();
    expect(() => ok({ ...long(), max_approval_wait_minutes: 10081 })).toThrow();
    expect(() => ok({ ...long(), on_expiry: "resume" })).toThrow();
  });
  it("rejects a missing long-running duration", () => {
    const { max_active_minutes: _a, ...noActive } = long();
    const { max_approval_wait_minutes: _b, ...noWait } = long();
    const { on_expiry: _c, ...noExpiry } = long();
    expect(() => parseWorkerDefinitionV1(noActive)).toThrow();
    expect(() => parseWorkerDefinitionV1(noWait)).toThrow();
    expect(() => parseWorkerDefinitionV1(noExpiry)).toThrow();
  });
  it("rejects long-running fields on an ephemeral definition", () => {
    expect(() => parseWorkerDefinitionV1({ ...eph(), max_active_minutes: 5 })).toThrow(/unknown/);
  });
  it("rejects unknown fields and unknown models", () => {
    expect(() => parseWorkerDefinitionV1({ ...eph(), extra: 1 })).toThrow(/unknown/);
    expect(() => parseWorkerDefinitionV1({ ...eph(), model_hint: "nope/model" })).toThrow();
  });
  it("rejects duplicate capabilities rather than deduping", () => {
    expect(() => parseWorkerDefinitionV1({ ...eph(), capabilities: ["a", "a"] })).toThrow(/duplicate/);
  });
  it("returns a deep-frozen object", () => {
    const d = parseWorkerDefinitionV1(eph());
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.capabilities)).toBe(true);
  });
});
