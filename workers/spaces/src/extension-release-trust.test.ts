import { describe, expect, it } from "vitest";
import { applyPublisherKeyRegistry, extensionReleaseAccessExpansion, isTrustedPublisherRelease, retainActivePublisherInstallations } from "./extension-release-trust.js";

describe("current publisher key trust", () => {
  it("does not treat a stale SpaceDO signature as trusted after the key registry revokes it", () => {
    const release = { version: "1.0.0", signatureValid: true, publisher: { id: "pub_a", keyId: "key-a", revoked: false } };
    const current = applyPublisherKeyRegistry(release, new Set<string>());
    expect(current).toMatchObject({ signatureValid: false, publisher: { keyId: "key-a", revoked: true } });
    expect(isTrustedPublisherRelease(current, new Set<string>())).toBe(false);
  });

  it("rejects incomplete publisher metadata instead of treating it as a first-party release", () => {
    const release = { signatureValid: true, publisher: { id: "pub_a", revoked: false } };
    const current = applyPublisherKeyRegistry(release, new Set<string>());
    expect(current.signatureValid).toBe(false);
    expect(current.publisher?.revoked).toBe(true);
    expect(isTrustedPublisherRelease(current, new Set<string>())).toBe(false);
  });

  it("retains first-party releases and releases signed by currently active keys", () => {
    const active = new Set(["key-a"]);
    const firstParty = { signatureValid: true };
    const publisher = { signatureValid: true, publisher: { keyId: "key-a", revoked: false } };
    expect(applyPublisherKeyRegistry(firstParty, active)).toBe(firstParty);
    expect(isTrustedPublisherRelease(firstParty, active)).toBe(true);
    expect(isTrustedPublisherRelease(publisher, active)).toBe(true);
  });

  it("excludes installed dependency pins whose publisher key is absent or revoked", () => {
    const installations = [
      { extension_id: "ext_first_party", publisher_key_id: null },
      { extension_id: "ext_active", publisher_key_id: "key-a" },
      { extension_id: "ext_revoked", publisher_key_id: "key-b" },
    ];
    expect(retainActivePublisherInstallations(installations, new Set(["key-a"]))
      .map(installation => installation.extension_id)).toEqual(["ext_first_party", "ext_active"]);
  });

  it("identifies permission and capability expansion before a rollback", () => {
    expect(extensionReleaseAccessExpansion(
      { permissions: ["repo.read"], capabilities: ["channel.invoke"] },
      { permissions: ["repo.read", "repo.write"], capabilities: ["channel.invoke", "extension.workflow"] },
    )).toEqual({ permissions: ["repo.write"], capabilities: ["extension.workflow"] });
  });
});
