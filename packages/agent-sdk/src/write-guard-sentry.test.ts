import { describe, expect, it } from "vitest";
import { enforceWriteGuardWithSentry, mintCapabilityGrant } from "./avos-features.js";

const requirement = { subject: "human", resource: "project" };
const secret = "test-secret";

describe("WriteGuard System One boundary", () => {
  it("requires a scoped human grant to add dependencies while permitting clean locked installs", async () => {
    await expect(enforceWriteGuardWithSentry("npm install express", undefined, secret, requirement)).rejects.toThrow("destructive_mutation_denied");
    await expect(enforceWriteGuardWithSentry("pip install requests", undefined, secret, requirement)).rejects.toThrow("destructive_mutation_denied");
    await expect(enforceWriteGuardWithSentry("cargo add serde", undefined, secret, requirement)).rejects.toThrow("destructive_mutation_denied");
    await expect(enforceWriteGuardWithSentry("npm ci && npm install injected", undefined, secret, requirement)).rejects.toThrow("destructive_mutation_denied");
    await expect(enforceWriteGuardWithSentry("python -m pip install requests", undefined, secret, requirement)).rejects.toThrow("destructive_mutation_denied");
    await expect(enforceWriteGuardWithSentry('dependency_manifest_edit {"path":"package.json"}', undefined, secret, requirement)).rejects.toThrow("destructive_mutation_denied");
    await expect(enforceWriteGuardWithSentry("api request POST https://api.stripe.com/v1/charges", undefined, secret, requirement)).rejects.toThrow("destructive_mutation_denied");
    await expect(enforceWriteGuardWithSentry("api request GET https://api.stripe.com/v1/customers", undefined, secret, requirement)).resolves.toBe(false);
    await expect(enforceWriteGuardWithSentry("npm ci", undefined, secret, requirement)).resolves.toBe(false);
    await expect(enforceWriteGuardWithSentry("pnpm install --frozen-lockfile", undefined, secret, requirement)).resolves.toBe(false);
  });

  it("never lets a sentry waive a deterministic destructive match", async () => {
    await expect(enforceWriteGuardWithSentry("git reset --hard", undefined, secret, requirement, {
      noul: async () => ({ kind: "noul", value: false, probability: 0.01, confidence: 0.99, provider: "openrouter", policyCode: "write_guard_ambiguous_mutation" }),
      choice: async () => { throw new Error("unused"); }, score: async () => { throw new Error("unused"); },
    })).rejects.toThrow("destructive_mutation_denied");
  });

  it("may tighten an ambiguous command and accepts a valid scoped grant", async () => {
    const token = await mintCapabilityGrant({ subject: "human", resources: ["project"], actions: ["destructive_write"], expiresAt: Date.now() + 60_000, nonce: "n" }, secret);
    await expect(enforceWriteGuardWithSentry("custom-admin rotate --all", token, secret, requirement, {
      noul: async () => ({ kind: "noul", value: true, probability: 0.97, confidence: 0.97, provider: "openrouter", policyCode: "write_guard_ambiguous_mutation" }),
      choice: async () => { throw new Error("unused"); }, score: async () => { throw new Error("unused"); },
    })).resolves.toBe(true);
  });
});
