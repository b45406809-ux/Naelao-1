import { describe, expect, it } from "vitest";
import { validateExtensionManifest } from "../extensions.js";
import { ANCHOR_DOGFOOD_EXTENSIONS, DOGFOOD_EXTENSION_CANVASES, DOGFOOD_EXTENSION_CATALOG, DOGFOOD_EXTENSIONS, isSaasReplacementEligible } from "./index.js";
describe("dogfooded enterprise extensions", () => {
  it("validates all first-party extension contracts through the public Gatekeeper boundary", () => {
    expect(DOGFOOD_EXTENSIONS).toHaveLength(10);
    for (const manifest of DOGFOOD_EXTENSIONS) expect(validateExtensionManifest(manifest, { gatekeeperCapabilities: manifest.capabilityRequirements })).toEqual(manifest);
    const voiceDashboard = DOGFOOD_EXTENSION_CANVASES.ext_assistant_voice_dashboard ?? "";
    expect(voiceDashboard).toContain("/api/assistant-voice");
    expect(voiceDashboard).toContain("/api/settings");
    expect(voiceDashboard).toContain("Save installation draft");
    expect(voiceDashboard).toContain("Apply draft to Space Assistant");
    expect(voiceDashboard).toContain("Selected profile · published list-rate estimate");
    expect(voiceDashboard).toContain("Not a quote, invoice, or measured cost.");
    expect(voiceDashboard).toContain("Provider availability, actual billed rates, and regional eligibility are unverified.");
    expect(DOGFOOD_EXTENSIONS.find(manifest => manifest.id === "ext_assistant_voice_dashboard")?.settingsSchema)
      .toMatchObject({ schemaVersion: 1, fields: expect.arrayContaining([expect.objectContaining({ id: "voice_profile_id" })]) });
    const script = voiceDashboard.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    const foundry = DOGFOOD_EXTENSION_CANVASES.ext_foundry_catalog ?? "";
    expect(foundry).toContain("Customer setup form");
    expect(foundry).toContain("Add setup field");
    expect(foundry).toContain("Setup contract preview");
    expect(foundry).toContain("Customer form preview");
    expect(foundry).toContain("Assistant channel availability defaults");
    expect(foundry).toContain("collectAssistantChannelDefaults");
    expect(foundry).toContain("blueprint.dependencies");
    expect(foundry).toContain("manifest_sha256");
    expect(foundry).toContain("Declared package features (installed together; no per-feature grant)");
    expect(foundry).not.toContain('id="required-extensions"');
    expect(DOGFOOD_EXTENSIONS.find(manifest => manifest.id === "ext_foundry_catalog")?.capabilityRequirements).toContain("blueprint.dependencies");
    expect(foundry).toContain("do not connect accounts");
    expect(foundry).toContain("setup-form-preview");
    expect(foundry).toContain("setup-preview-locale");
    expect(foundry).toContain("updateCustomerPreviewValues");
    expect(foundry).not.toContain(".innerHTML");
    expect(foundry).toContain("projectIds,requiredExtensions,requiredExtensionVersions");
    expect(foundry).toContain("setupSchemaVersion,setupFieldsByProject");
    expect(foundry).toContain("setup-project-select");
    expect(foundry).toContain("blueprint.export");
    expect(foundry).toContain("Save authoring draft");
    expect(foundry).toContain("MAX_DRAFT_BYTES=49152");
    expect(foundry).toContain("function validateSavedDraft");
    expect(foundry).toContain("function restoreProductDraft");
    expect(foundry).toContain("activeProductStatus=['draft','building','in_review','published','suspended','retired'].includes(item.status)?item.status:'draft'");
    expect(foundry).toContain("draft?.lifecycle?.marketplace_listing_id||item.marketplace_listing_id||''");
    expect(foundry).toContain("publication_status:savedListingId?'published':draft?.lifecycle?.publication_status||'draft'");
    expect(foundry).toContain("activeLifecycle.export_request_id&&!workflowStatusTerminal(activeLifecycle.conformance_job_status))return'building'");
    expect(foundry).toContain("if(activeLifecycle.marketplace_listing_id){await persistProductState();document.querySelector('#certification').textContent=JSON.stringify({stage:'marketplace_published',listing_id:activeLifecycle.marketplace_listing_id,alreadyPublished:true},null,2);return}");
    expect(foundry).toContain("function saveAuthoringDraft");
    expect(foundry).toContain("draft_json:raw");
    expect(foundry).toContain("export_request_id");
    expect(foundry).toContain("export_fingerprint");
    expect(foundry).toContain("conformance_job_id");
    expect(foundry).toContain("refreshConformanceStatus({quiet:true})");
    expect(foundry).toContain("marketplace_listing_id:activeLifecycle.marketplace_listing_id||null");
    expect(foundry).toContain("requestId" );
    expect(foundry).toContain("This exact draft is certified");
    expect(foundry).toContain("Local preview values were cleared");
    expect(foundry).not.toContain("preview_values:");
    expect(foundry.toLowerCase()).toContain("provider credentials");
    const foundryScript = foundry.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(foundryScript).toBeTruthy();
    expect(() => new Function(foundryScript!)).not.toThrow();
    const foundryManifest = DOGFOOD_EXTENSIONS.find(manifest => manifest.id === "ext_foundry_catalog");
    expect(foundryManifest?.releaseVersion).toBe("1.3.0");
    expect(foundryManifest?.gadgets[0]?.migrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 2, up: expect.stringContaining("ADD COLUMN draft_json TEXT NOT NULL DEFAULT '{}'" ) }),
    ]));
  });

  it("limits commercial first-party claims to CRM and e-sign", () => {
    expect(ANCHOR_DOGFOOD_EXTENSIONS.map((manifest) => manifest.id)).toEqual(["ext_crm_core", "ext_esign_core"]);
    expect(DOGFOOD_EXTENSION_CATALOG.filter((entry) => entry.maturity === "reference").map((entry) => entry.manifest.id)).toEqual([
      "ext_lsp_indexer",
      "ext_assistant_voice_dashboard",
      "ext_space_blackboard",
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
