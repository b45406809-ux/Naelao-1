import { describe, expect, it } from "vitest";
import { agent37TemplateAllows, parseAgent37TemplateConstraints, validateAgent37TemplateEvidence } from "./agent37-admission.js";

const constraints = { provider: "agent37", region: "us", instanceType: "default", capabilities: ["exec", "files"],
  resources: [{ cpu: 2, memoryMiB: 4096, minDiskGiB: 2, maxDiskGiB: 12 }] };
describe("Agent37 admission evidence", () => {
  it("accepts only a bounded official evidence record and exact supported profile", () => {
    const validUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const result = validateAgent37TemplateEvidence({ digest: `sha256:${"a".repeat(64)}`, constraints,
      evidenceUrls: ["https://www.agent37.com/docs/agents-api/instances/create"], validUntil });
    expect(result.constraints).toMatchObject({ region: "us", instanceType: "default" });
    expect(agent37TemplateAllows(result.constraints, { region: "us", instanceType: "default", resources: { cpu: 2, memoryMiB: 4096, diskGiB: 12 } })).toBe(true);
    expect(agent37TemplateAllows(result.constraints, { region: "us", instanceType: "default", resources: { cpu: 4, memoryMiB: 8192, diskGiB: 12 } })).toBe(false);
  });

  it("rejects unsupported shapes, regions, stale evidence, and non-provider evidence URLs", () => {
    expect(() => parseAgent37TemplateConstraints({ ...constraints, resources: [{ cpu: 3, memoryMiB: 4096, minDiskGiB: 2, maxDiskGiB: 12 }] })).toThrow("unsupported_template_resource_limit");
    expect(() => validateAgent37TemplateEvidence({ digest: "bad", constraints, evidenceUrls: ["https://www.agent37.com/docs/a"], validUntil: new Date(Date.now()+60_000).toISOString() })).toThrow("invalid_template_digest");
    expect(() => validateAgent37TemplateEvidence({ digest: "a".repeat(64), constraints, evidenceUrls: ["https://example.com/docs"], validUntil: new Date(Date.now()+60_000).toISOString() })).toThrow("invalid_template_evidence");
    expect(() => validateAgent37TemplateEvidence({ digest: "a".repeat(64), constraints, evidenceUrls: ["https://www.agent37.com/docs/a"], validUntil: new Date(Date.now()-60_000).toISOString() })).toThrow("template_validity_out_of_range");
  });
});
