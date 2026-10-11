import { describe, expect, it, vi } from "vitest";
import { applyDurableObjectJurisdiction, jurisdictionalNamespace, parseDataJurisdiction } from "./data-residency.js";

describe("data residency", () => {
  it("preserves the global namespace when no jurisdiction is configured", () => {
    const namespace = { jurisdiction: vi.fn() } as unknown as DurableObjectNamespace;
    expect(jurisdictionalNamespace(namespace, undefined)).toBe(namespace);
    expect(namespace.jurisdiction).not.toHaveBeenCalled();
  });

  it("scopes every configured binding to the EU jurisdiction", () => {
    const scoped = {} as DurableObjectNamespace;
    const namespace = { jurisdiction: vi.fn(() => scoped) } as unknown as DurableObjectNamespace;
    const env = { A: namespace, OPTIONAL: undefined };
    applyDurableObjectJurisdiction(env, "eu", ["A", "OPTIONAL"] as const);
    applyDurableObjectJurisdiction(env, "eu", ["A", "OPTIONAL"] as const);
    expect(namespace.jurisdiction).toHaveBeenCalledWith("eu");
    expect(namespace.jurisdiction).toHaveBeenCalledTimes(1);
    expect(env.A).toBe(scoped);
  });

  it("fails closed for an unknown configured jurisdiction", () => {
    expect(() => parseDataJurisdiction("europe")).toThrow(/Unsupported DATA_JURISDICTION/);
  });
});
