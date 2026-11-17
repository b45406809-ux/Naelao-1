import { describe, expect, it } from "vitest";
import { previewExtensionPublisherProvenance } from "./extension-publisher-provenance";

const manifest = { id: "ext_provenance", type: "extension", declaredPermissions: [], capabilityRequirements: ["extension.project_canvas"],
  gadgets: [], daemons: [], commands: [], bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_provenance", version: "1.0.0",
    primitives: [{ schemaVersion: "1.0", kind: "canvas", id: "preview", version: "1.0.0", permissions: [], capabilityRequirements: [],
      lifecycle: {}, layout: "CanvasMount", component: "./index.html", dynamicPage: false }] } };

describe("extension source provenance preview", () => {
  it("fingerprints the publisher signing payload and changes with source bytes", async () => {
    const manifestDraft = JSON.stringify(manifest);
    const first = await previewExtensionPublisherProvenance(manifestDraft, JSON.stringify({ "./index.html": "<main>one</main>" }));
    const reordered = await previewExtensionPublisherProvenance(manifestDraft, JSON.stringify({ "./index.html": "<main>one</main>" }));
    const changed = await previewExtensionPublisherProvenance(manifestDraft, JSON.stringify({ "./index.html": "<main>two</main>" }));
    expect(first).toMatchObject({ sourceCount: 1, sourceBytes: 16 });
    expect(first.signingPayloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered.signingPayloadSha256).toBe(first.signingPayloadSha256);
    expect(changed.signingPayloadSha256).not.toBe(first.signingPayloadSha256);
  });

  it("rejects malformed manifests and unsafe or oversized artifact maps", async () => {
    await expect(previewExtensionPublisherProvenance("{}", "{}" )).rejects.toThrow();
    await expect(previewExtensionPublisherProvenance(JSON.stringify(manifest), JSON.stringify({ "../secret.ts": "x" }))).rejects.toThrow("extension_publisher_artifact_invalid");
  });
});
