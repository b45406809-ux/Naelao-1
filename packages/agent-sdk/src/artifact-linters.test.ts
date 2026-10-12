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
  });
});
