import { describe, expect, it } from "vitest";
import { DEV_FOUNDRY_TEMPLATE, getNativeSpaceTemplate } from "./dev-foundry.js";

describe("tpl_dev_foundry_v1", () => {
  it("is native to the shell and exposes every foundry capability", () => {
    expect(getNativeSpaceTemplate("tpl_dev_foundry_v1")).toBe(DEV_FOUNDRY_TEMPLATE);
    expect(DEV_FOUNDRY_TEMPLATE.externalDomainRequired).toBe(false);
    expect(DEV_FOUNDRY_TEMPLATE.shellRoute).toBe("/foundry");
    expect(DEV_FOUNDRY_TEMPLATE.foundation).toEqual(expect.arrayContaining([
      "launchpad.projects", "launchpad.extensions", "launchpad.assistants", "launchpad.knowledge_bases",
    ]));
    expect(DEV_FOUNDRY_TEMPLATE.capabilities).toEqual(expect.arrayContaining([
      "extension.author", "api.author", "project_template.author", "space_template.publish",
      "marketplace.manage", "sqlite.schema.inspect", "conformance.run",
    ]));
    expect(DEV_FOUNDRY_TEMPLATE.name).toBe("FDE Foundry");
    expect(DEV_FOUNDRY_TEMPLATE.capabilities).not.toContain("referral.payout.request");
  });

  it("rejects identifiers outside the template namespace", () => {
    expect(() => getNativeSpaceTemplate("ext_wrong_kind")).toThrow("invalid_template_id");
  });
});
