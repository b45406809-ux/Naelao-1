import { describe, expect, it } from "vitest";
import { validateExtensionManifest } from "../extensions.js";
import { DOGFOOD_EXTENSIONS } from "./index.js";
describe("dogfooded enterprise extensions", () => {
  it("validates all six through the public Gatekeeper boundary", () => {
    expect(DOGFOOD_EXTENSIONS).toHaveLength(6);
    for (const manifest of DOGFOOD_EXTENSIONS) expect(validateExtensionManifest(manifest, { gatekeeperCapabilities: manifest.capabilityRequirements })).toEqual(manifest);
  });
});
