import { describe, expect, it } from "vitest";
import { lintArtifact, parseArtifactLinters } from "./artifact-linters.js";

describe("structural artifact linters", () => {
  const spec = [{ id: "invoice", path: "/workspace/invoice.json", fields: {
    amount: { type: "number", required: true, min: 1 },
    status: { type: "string", enum: ["draft", "approved"] },
    active: { type: "boolean" },
  } }];

  it("accepts bounded schemas and reports only field names and structural messages", () => {
    const parsed = parseArtifactLinters(spec);
    const diagnostics = lintArtifact("/workspace/invoice.json", JSON.stringify({ amount: 0, status: "secret-value", extra: "private" }), parsed);
    expect(diagnostics.map(({ field, message }) => [field, message])).toEqual([
      ["amount", "Below the structural minimum"],
      ["status", "Outside the allowed values"],
      ["extra", "Unexpected field"],
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret-value");
    expect(JSON.stringify(diagnostics)).not.toContain("private");
  });

  it("rejects invalid rules, prototype fields and paths outside workspace JSON", () => {
    expect(() => parseArtifactLinters([{ id: "x", path: "/etc/passwd.json", fields: {} }])).toThrow();
    expect(() => parseArtifactLinters([{ id: "x", path: "/workspace/x.json", fields: { constructor: { type: "string" } } }])).toThrow();
    expect(() => parseArtifactLinters([{ id: "x", path: "/workspace/x.json", fields: { active: { type: "boolean", min: 0 } } }])).toThrow();
    expect(() => parseArtifactLinters([{ id: "x", path: "/workspace/x.json", fields: { amount: { type: "number", min: 0.5 } } }])).toThrow();
    expect(() => parseArtifactLinters([{ id: "x", path: `/workspace/${"a".repeat(600)}.json`, fields: {} }])).toThrow("invalid_artifact_linter");
    expect(() => parseArtifactLinters([{ id: "x", path: "/workspace/../escape.json", fields: {} }])).toThrow("invalid_artifact_linter");
  });

  it("rejects oversized artifact content before parsing", () => {
    const parsed = parseArtifactLinters(spec);
    const diagnostics = lintArtifact("/workspace/invoice.json", " ".repeat(2 * 1024 * 1024 + 1), parsed);
    expect(diagnostics).toEqual([{ ruleId: "invoice", field: "", message: "Artifact exceeds the structural validation size limit" }]);
  });

  it("caps diagnostics while scanning highly malformed objects", () => {
    const parsed = parseArtifactLinters(spec);
    const content = JSON.stringify(Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`unexpected_${index}`, index])));
    const diagnostics = lintArtifact("/workspace/invoice.json", content, parsed);
    expect(diagnostics).toHaveLength(128);
    expect(diagnostics[0]).toMatchObject({ field: "amount", message: "Required field is missing" });
    expect(diagnostics.slice(1).every(item => item.message === "Unexpected field")).toBe(true);
  });
});
