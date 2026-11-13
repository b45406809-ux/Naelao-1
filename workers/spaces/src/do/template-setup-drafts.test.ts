import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

const schema = [{ project_id: "support", project_name: "Support", fields: [
  { id: "greeting", type: "text" as const, label: "Greeting", required: true, minLength: 2, maxLength: 80 },
  { id: "language", type: "select" as const, label: "Language", options: [{ value: "en", label: "English" }, { value: "fr", label: "French" }], defaultValue: "en" },
] }];
async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("encrypted Space Template setup drafts", () => {
  it("resumes only the matching signed listing and schema, with optimistic revisions", async () => {
    const storage = createDOStorage(), secret = "template-setup-draft-encryption-test-secret-40";
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret } as never);
    const tenantId = "tenant-a", spaceId = "space-a", blueprintId = "template-a", listingId = "listing-a";
    const token = await mintInternalToken(secret, tenantId);
    const artifactSha = "a".repeat(64), changedArtifactSha = "b".repeat(64), schemaSha = await sha256(JSON.stringify(schema));
    const target = (artifactSha256 = artifactSha, setupSchemaSha256 = schemaSha, listing = listingId) => {
      const query = new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, blueprint_id: blueprintId, listing_id: listing,
        artifact_sha256: artifactSha256, setup_schema_version: "1", setup_schema_sha256: setupSchemaSha256 });
      return `http://space/template-setup-draft?${query}`;
    };
    const request = (method: "GET" | "PUT", url = target(), body?: unknown, role = "owner") => space.fetch(new Request(url, {
      method, headers: { "x-naelao-internal-token": token, "x-naelao-user-id": "owner-a", "x-naelao-role": role, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

    expect(await (await request("GET")).json()).toMatchObject({ exists: false, binding_matches: false, revision: 0 });
    const saved = await request("PUT", target(), { schema, values: { support: { greeting: "Hello" } }, expected_revision: 0 });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ exists: true, binding_matches: true, values: { support: { greeting: "Hello", language: "en" } }, revision: 1 });
    const stored = storage.sql.exec<{ setup_values_ciphertext: string }>("SELECT setup_values_ciphertext FROM space_template_setup_drafts").toArray()[0]!.setup_values_ciphertext;
    expect(stored).not.toContain("Hello");
    expect(await (await request("GET")).json()).toMatchObject({ values: { support: { greeting: "Hello", language: "en" } }, revision: 1 });

    const changedContext = await request("GET", target(changedArtifactSha));
    expect(await changedContext.json()).toMatchObject({ exists: true, binding_matches: false, revision: 1 });
    expect(await request("PUT", target(changedArtifactSha), { schema, values: { support: {} }, expected_revision: 1 }).then(response => response.status)).toBe(409);
    const replaced = await request("PUT", target(changedArtifactSha), { schema, values: { support: {} }, expected_revision: 1, replace_context: true });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ binding_matches: true, values: { support: { language: "en" } }, revision: 2 });
    expect(await request("PUT", target(changedArtifactSha), { schema, values: {}, expected_revision: 1, replace_context: true }).then(response => response.status)).toBe(409);
    expect(await request("PUT", target(changedArtifactSha), { schema, values: {}, expected_revision: 2 }, "member").then(response => response.status)).toBe(403);
  });
});
