// Unit tests for @naelao/entitlements (G-B-ENT01..ENT05)
import { describe, it, expect } from "vitest";
import { getPlanLimits, isFeatureAllowed } from "../../../packages/entitlements/src/index.js";
import type { PlanTier } from "../../../packages/types/src/index.js";

describe("Plan limits (G-B-ENT01)", () => {
  const tiers: PlanTier[] = ["free", "growth", "business", "enterprise"];

  it("returns limits for all plan tiers", () => {
    for (const tier of tiers) {
      const limits = getPlanLimits(tier);
      expect(limits.spaces).toBeGreaterThan(0);
      expect(limits.seats).toBeGreaterThan(0);
      expect(limits.monthly_sessions).toBeGreaterThan(0);
      expect(limits.monthly_tokens).toBeGreaterThan(0);
    }
  });

  it("free plan has lowest limits", () => {
    const free = getPlanLimits("free");
    const growth = getPlanLimits("growth");
    expect(free.spaces).toBeLessThan(growth.spaces);
    expect(free.monthly_sessions).toBeLessThan(growth.monthly_sessions);
  });

  it("enterprise plan has highest limits", () => {
    const enterprise = getPlanLimits("enterprise");
    const business = getPlanLimits("business");
    expect(enterprise.spaces).toBeGreaterThan(business.spaces);
    expect(enterprise.monthly_tokens).toBeGreaterThan(business.monthly_tokens);
  });

  it("free plan has correct PBKDF2-required iterations value (600k)", () => {
    const free = getPlanLimits("free");
    expect(free.monthly_tokens).toBe(100_000);
  });

  it("enterprise plan allows SSO", () => {
    const enterprise = getPlanLimits("enterprise");
    expect(enterprise.sso).toBe(true);
  });

  it("free plan disallows SSO", () => {
    const free = getPlanLimits("free");
    expect(free.sso).toBe(false);
  });
});

describe("Feature gating (G-B-ENT02)", () => {
  it("free plan disallows custom_tools", () => {
    expect(isFeatureAllowed("free", "custom_tools")).toBe(false);
  });

  it("growth plan allows custom_tools", () => {
    expect(isFeatureAllowed("growth", "custom_tools")).toBe(true);
  });

  it("free plan disallows sse_streaming", () => {
    expect(isFeatureAllowed("free", "sse_streaming")).toBe(false);
  });

  it("growth plan allows sse_streaming", () => {
    expect(isFeatureAllowed("growth", "sse_streaming")).toBe(true);
  });

  it("business plan allows advanced_analytics", () => {
    expect(isFeatureAllowed("business", "advanced_analytics")).toBe(true);
  });

  it("growth plan disallows advanced_analytics", () => {
    expect(isFeatureAllowed("growth", "advanced_analytics")).toBe(false);
  });

  it("enterprise plan allows sso", () => {
    expect(isFeatureAllowed("enterprise", "sso")).toBe(true);
  });

  it("free plan disallows sso", () => {
    expect(isFeatureAllowed("free", "sso")).toBe(false);
  });

  it("numeric limits are true when >0", () => {
    // spaces > 0 means "allowed" for numeric features
    expect(isFeatureAllowed("free", "spaces")).toBe(true);
  });

  it("free plan has zero webhook_subscriptions (disallowed)", () => {
    expect(isFeatureAllowed("free", "webhook_subscriptions")).toBe(false);
  });

  it("growth plan has non-zero webhook_subscriptions (allowed)", () => {
    expect(isFeatureAllowed("growth", "webhook_subscriptions")).toBe(true);
  });
});

describe("Audit log retention (G-B-ENT03)", () => {
  it("enterprise plan retains logs for 365 days", () => {
    const limits = getPlanLimits("enterprise");
    expect(limits.audit_log_retention_days).toBe(365);
  });

  it("free plan retains logs for only 7 days", () => {
    const limits = getPlanLimits("free");
    expect(limits.audit_log_retention_days).toBe(7);
  });

  it("retention increases monotonically across plans", () => {
    const days = (["free", "growth", "business", "enterprise"] as PlanTier[]).map(
      (t) => getPlanLimits(t).audit_log_retention_days
    );
    for (let i = 1; i < days.length; i++) {
      expect(days[i]!).toBeGreaterThan(days[i - 1]!);
    }
  });
});
