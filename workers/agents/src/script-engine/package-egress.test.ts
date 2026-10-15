import { describe, expect, it } from "vitest";
import { isTrustedPackageUrl, TRUSTED_PACKAGE_HOSTS } from "./package-egress.js";

describe("trusted package egress host policy", () => {
  it("permits HTTPS only for exact package-source hostnames", () => {
    for (const host of TRUSTED_PACKAGE_HOSTS) expect(isTrustedPackageUrl(`https://${host}/package`)).toBe(true);
    expect(isTrustedPackageUrl("http://registry.npmjs.org/package")).toBe(false);
    expect(isTrustedPackageUrl("https://registry.npmjs.org:444/package")).toBe(false);
    expect(isTrustedPackageUrl("https://user@registry.npmjs.org/package")).toBe(false);
    expect(isTrustedPackageUrl("https://evil-registry.npmjs.org/package")).toBe(false);
    expect(isTrustedPackageUrl("https://registry.npmjs.org.evil.example/package")).toBe(false);
    expect(isTrustedPackageUrl("https://example.com/package")).toBe(false);
  });
});
