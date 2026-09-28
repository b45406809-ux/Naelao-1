import { describe, expect, it } from "vitest";
import { validateGeneratedWidget } from "./widgets.js";
describe("generated widget security", () => {
  it("accepts declarative inputs", () => expect(validateGeneratedWidget({ type: "range", id: "budget", label: "Budget", min: 1, max: 10 })).toMatchObject({ type: "range", max: 10 }));
  it("rejects scripts and inline HTML at any depth", () => {
    expect(() => validateGeneratedWidget({ type: "action_card", id: "x", title: "<script>alert(1)</script>", action: "approve" })).toThrow(/forbidden/);
    expect(() => validateGeneratedWidget({ type: "multi_select", id: "x", label: "Tags", options: ["<img onerror=x>"] })).toThrow(/forbidden/);
  });
});
