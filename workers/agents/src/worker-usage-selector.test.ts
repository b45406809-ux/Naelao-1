import { describe, expect, it } from "vitest";
import { isValidWorkerUsageSelector } from "./worker-usage-selector.js";

describe("worker usage selectors", () => {
  it("accepts stable namespaced goal worker IDs", () => {
    expect(isValidWorkerUsageSelector(`${"a".repeat(64)}:task_1`)).toBe(true);
    expect(isValidWorkerUsageSelector("worker-a.b_2")).toBe(true);
  });

  it("rejects path/query metacharacters and oversized IDs", () => {
    expect(isValidWorkerUsageSelector("worker%2Ftask")).toBe(false);
    expect(isValidWorkerUsageSelector("worker/task")).toBe(false);
    expect(isValidWorkerUsageSelector("a".repeat(161))).toBe(false);
  });
});
