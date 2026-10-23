import { describe, expect, it } from "vitest";
import { validateExtensionManifest } from "../extensions.js";
import { ANCHOR_DOGFOOD_EXTENSIONS, DOGFOOD_EXTENSION_CATALOG, DOGFOOD_EXTENSIONS, isSaasReplacementEligible } from "./index.js";
describe("dogfooded enterprise extensions", () => {
  it("validates all first-party extension contracts through the public Gatekeeper boundary", () => {
    expect(DOGFOOD_EXTENSIONS).toHaveLength(8);
    for (const manifest of DOGFOOD_EXTENSIONS) expect(validateExtensionManifest(manifest, { gatekeeperCapabilities: manifest.capabilityRequirements })).toEqual(manifest);
  });

  it("limits commercial first-party claims to CRM and e-sign", () => {
    expect(ANCHOR_DOGFOOD_EXTENSIONS.map((manifest) => manifest.id)).toEqual(["ext_crm_core", "ext_esign_core"]);
    expect(DOGFOOD_EXTENSION_CATALOG.filter((entry) => entry.maturity === "reference").map((entry) => entry.manifest.id)).toEqual([
      "ext_lsp_indexer",
      "ext_foundry_catalog",
      "ext_ledger_core",
      "ext_omnichannel_inbox",
      "ext_commerce_hub",
      "ext_payroll_core",
    ]);
  });

  it("blocks SaaS replacement claims until all graduation evidence is approved", () => {
    expect(DOGFOOD_EXTENSION_CATALOG.every((entry) => !isSaasReplacementEligible(entry))).toBe(true);
    const candidate = {
      ...DOGFOOD_EXTENSION_CATALOG[0]!,
      graduation: {
        status: "approved" as const,
        domainTestPlan: "evidence/domain-tests.md",
        securityReview: "evidence/security-review.md",
        migrationPolicy: "evidence/migration.md",
        operationalSlo: "evidence/slo.md",
      },
    };
    expect(isSaasReplacementEligible(candidate)).toBe(true);
    expect(isSaasReplacementEligible({ ...candidate, graduation: { ...candidate.graduation, securityReview: "" } })).toBe(false);
  });
});
