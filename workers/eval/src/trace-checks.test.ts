import { describe, expect, it } from "vitest";
import { gradeTrace, hasTraceGrade, isValidTraceCheck, summarizeFailures, type TraceCheck } from "./trace-checks.js";

describe("trace-check grading", () => {
  it("rejects malformed and unbounded dataset checks", () => {
    expect(isValidTraceCheck({ type: "unknown" })).toBe(false);
    expect(isValidTraceCheck({ type: "called_tool", name: "" })).toBe(false);
    expect(isValidTraceCheck({ type: "no_identical_retry", max: 1.5 })).toBe(false);
    expect(isValidTraceCheck({ type: "verified_after_write", write: "write", verify: [] })).toBe(false);
    expect(isValidTraceCheck({ type: "answer_matches", pattern: "x".repeat(201) })).toBe(false);
    expect(isValidTraceCheck({ type: "answer_matches", pattern: "ok" })).toBe(true);
  });

  it("scores calls, write verification, answer, fabrication, and secret checks", () => {
    const checks: TraceCheck[] = [
      { type: "called_tool", name: "commerce.create_product" },
      { type: "verified_after_write", write: "commerce.create_product", verify: ["commerce.list_products"] },
      { type: "reached_answer" },
      { type: "no_fabricated_success", claim_patterns: ["successfully created"] },
      { type: "no_secret_leak" },
    ];
    const grade = gradeTrace(checks, [
      { seq: 1, phase: "run", name: "commerce.create_product", ok: true },
      { seq: 2, phase: "run", name: "commerce.list_products", ok: true },
      { seq: 3, phase: "answer" },
    ], { answer: "Successfully created the product" });
    expect(grade).toMatchObject({ score: 10, passed: 5, total: 5 });
    expect(hasTraceGrade(grade)).toBe(true);
  });

  it("counts identical failed calls by canonicalized params, not merely tool name", () => {
    const checks: TraceCheck[] = [{ type: "no_identical_retry", max: 1 }];
    const different = gradeTrace(checks, [
      { seq: 1, phase: "run", name: "search", ok: false, params: { q: "one", limit: 5 } },
      { seq: 2, phase: "run", name: "search", ok: false, params: { limit: 5, q: "two" } },
    ], { answer: "done" });
    const repeated = gradeTrace(checks, [
      { seq: 1, phase: "run", name: "search", ok: false, params: { q: "one", limit: 5 } },
      { seq: 2, phase: "run", name: "search", ok: false, params: { limit: 5, q: "one" } },
    ], { answer: "done" });
    expect(different.score).toBe(10);
    expect(repeated.score).toBe(0);
  });

  it("reports malformed checks and rejects unsafe regex shapes without crashing", () => {
    const grade = gradeTrace([
      { type: "bad" } as unknown as TraceCheck,
      { type: "answer_matches", pattern: "(a+)+$" },
    ], [], { answer: "a".repeat(5_000) });
    expect(grade.results[0]?.detail).toContain("invalid schema");
    expect(grade.results[1]?.detail).toContain("invalid pattern");
    expect(summarizeFailures(grade)).toContain("invalid schema");
  });

  it("bounds malformed trace and outcome data and handles empty checks", () => {
    expect(gradeTrace([], [{ seq: 1 } as never], { answer: "x" }).total).toBe(0);
    expect(hasTraceGrade(gradeTrace([], [], { answer: "" }))).toBe(false);
    const grade = gradeTrace([{ type: "reached_answer" }], [null as never], { answer: "" });
    expect(grade.score).toBe(0);
    expect(gradeTrace([{ type: "called_tool", name: "safe" }], [{ seq: 1, phase: "run", name: 7 } as never], { answer: "" }).score).toBe(0);
  });
});
