import { describe, expect, it } from "vitest";
import { DEV_FOUNDRY_TEMPLATE, getNativeSpaceTemplate } from "./dev-foundry.js";

describe("tpl_dev_foundry_v1", () => {
  it("is native to the shell and exposes every foundry capability", () => {
    expect(getNativeSpaceTemplate("tpl_dev_foundry_v1")).toBe(DEV_FOUNDRY_TEMPLATE);
    expect(DEV_FOUNDRY_TEMPLATE.externalDomainRequired).toBe(false);
    expect(DEV_FOUNDRY_TEMPLATE.shellRoute).toBe("/foundry");
    expect(DEV_FOUNDRY_TEMPLATE.capabilities).toEqual(expect.arrayContaining([
      "extension.author", "sqlite.schema.inspect", "conformance.run", "referral.royalties.read",
    ]));
    expect(DEV_FOUNDRY_TEMPLATE.royalty.referralShareBps).toBe(4000);
  });

  it("rejects identifiers outside the template namespace", () => {
    expect(() => getNativeSpaceTemplate("ext_wrong_kind")).toThrow("invalid_template_id");
  });
});
