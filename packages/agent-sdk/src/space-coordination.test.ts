import { describe, expect, it } from "vitest";
import { createSpaceCoordinationClient, createSpaceCoordinationClientV2, validateSpaceCoordinationDraft, validateSpaceCoordinationDraftV2 } from "./space-coordination.js";

describe("Space coordination registry v1 contract", () => {
  it("normalizes bounded facts and rejects authority or hidden-source fields", () => {
    expect(validateSpaceCoordinationDraft({ capability_key: "Official.Website", label: " Official site ", description: " Published intentionally " }))
      .toEqual({ ok: true, value: { capability_key: "official.website", label: "Official site", description: "Published intentionally" } });
    expect(validateSpaceCoordinationDraft({ capability_key: "website", label: "Official site", project_id: "private-project" }).ok).toBe(false);
    expect(validateSpaceCoordinationDraft({ capability_key: "website", label: "x".repeat(121) }).ok).toBe(false);
    expect(validateSpaceCoordinationDraft({ capability_key: "website", label: "site", description: "x".repeat(501) }).ok).toBe(false);
  });

  it("uses the versioned host routes and carries explicit disclosure confirmation", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const client = createSpaceCoordinationClient({
      spaceId: "space / one",
      request: async <T>(path: string, init?: { method?: "GET" | "POST" | "DELETE" | "PATCH"; body?: unknown }) => {
        calls.push({ path, method: init?.method ?? "GET", body: init?.body });
        return {} as T;
      },
    });
    await client.list("cursor/1");
    await client.preview({ capability_key: "official.website", label: "Company site" });
    await client.publish({ capability_key: "official.website", label: "Company site" }, true);
    await client.revoke("entry/1", 3);
    expect(calls).toEqual([
      { path: "/spaces/space%20%2F%20one/coordination-registry?after=cursor%2F1", method: "GET", body: undefined },
      { path: "/spaces/space%20%2F%20one/coordination-registry/preview", method: "POST", body: { capability_key: "official.website", label: "Company site" } },
      { path: "/spaces/space%20%2F%20one/coordination-registry", method: "POST", body: { capability_key: "official.website", label: "Company site", confirm_disclosure: true } },
      { path: "/spaces/space%20%2F%20one/coordination-registry/entry%2F1", method: "DELETE", body: { expected_version: 3 } },
    ]);
  });
});

describe("Space coordination registry v2 audience contract", () => {
  it("requires a declared audience and rejects arbitrary authority fields", () => {
    expect(validateSpaceCoordinationDraftV2({ schema_version: 2, capability_key: "official.website", label: "Company site", audience: "space_admins" }))
      .toEqual({ ok: true, value: { schema_version: 2, audience: "space_admins", capability_key: "official.website", label: "Company site", expires_at: null } });
    const expiresAt = "2026-12-01T23:59:59.999Z";
    expect(validateSpaceCoordinationDraftV2({ schema_version: 2, capability_key: "official.website", label: "Company site", audience: "space_admins", expires_at: expiresAt }))
      .toMatchObject({ ok: true, value: { expires_at: expiresAt } });
    expect(validateSpaceCoordinationDraftV2({ schema_version: 2, capability_key: "official.website", label: "Company site", audience: "space_admins", expires_at: "tomorrow" }).ok).toBe(false);
    expect(validateSpaceCoordinationDraftV2({ schema_version: 2, capability_key: "website", label: "Site", audience: "private_project" }).ok).toBe(false);
    expect(validateSpaceCoordinationDraftV2({ schema_version: 2, capability_key: "website", label: "Site", audience: "space_members", project_id: "private" }).ok).toBe(false);
  });

  it("uses v2 routes and persists the exact audience in drafts and revocations", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const client = createSpaceCoordinationClientV2({
      spaceId: "space / one",
      request: async <T>(path: string, init?: { method?: "GET" | "POST" | "DELETE" | "PATCH"; body?: unknown }) => {
        calls.push({ path, method: init?.method ?? "GET", body: init?.body });
        return {} as T;
      },
    });
    const draft = { schema_version: 2 as const, capability_key: "official.website", label: "Company site", audience: "space_admins" as const, expires_at: null };
    await client.list("cursor/1");
    await client.preview(draft);
    await client.publish(draft, true);
    await client.revoke("entry/1", 3);
    await client.amend("entry/1", 3, { ...draft, label: "Company website" }, true);
    await client.history("entry/1", "event cursor");
    expect(calls).toEqual([
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2?after=cursor%2F1", method: "GET", body: undefined },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/preview", method: "POST", body: draft },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2", method: "POST", body: { ...draft, confirm_disclosure: true } },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/entry%2F1", method: "DELETE", body: { schema_version: 2, expected_version: 3 } },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/entry%2F1", method: "PATCH", body: { ...draft, label: "Company website", expected_version: 3, confirm_disclosure: true } },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/entry%2F1/history?after=event%20cursor", method: "GET", body: undefined },
    ]);
  });
});
