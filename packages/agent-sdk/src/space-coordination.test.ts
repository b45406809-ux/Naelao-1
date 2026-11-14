import { describe, expect, it } from "vitest";
import { createSpaceCoordinationClient, createSpaceCoordinationClientV2, createSpaceCoordinationProposalClient, validateSpaceCoordinationDraft, validateSpaceCoordinationDraftV2, validateSpaceCoordinationSingletonKeys } from "./space-coordination.js";

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
      request: async <T>(path: string, init?: { method?: "GET" | "POST" | "DELETE" | "PATCH" | "PUT"; body?: unknown }) => {
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
  it("validates a bounded, canonical optional singleton-key set", () => {
    expect(validateSpaceCoordinationSingletonKeys(["official.website", "service.phone"])).toEqual({
      ok: true, value: ["official.website", "service.phone"],
    });
    expect(validateSpaceCoordinationSingletonKeys(["Official.Website"]).ok).toBe(false);
    expect(validateSpaceCoordinationSingletonKeys(["official.website", "official.website"]).ok).toBe(false);
    expect(validateSpaceCoordinationSingletonKeys(Array.from({ length: 33 }, (_, index) => `service.${index}`)).ok).toBe(false);
  });
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
      request: async <T>(path: string, init?: { method?: "GET" | "POST" | "DELETE" | "PATCH" | "PUT"; body?: unknown }) => {
        calls.push({ path, method: init?.method ?? "GET", body: init?.body });
        return {} as T;
      },
    });
    const draft = { schema_version: 2 as const, capability_key: "official.website", label: "Company site", audience: "space_admins" as const, expires_at: null };
    await client.policy();
    await client.policyHistory("1");
    await client.updatePolicy(true, 0, true);
    await client.singletonPolicy();
    await client.singletonPolicyHistory("2");
    await client.updateSingletonPolicy(["service.phone", "official.website"], 0, true);
    await client.list("cursor/1");
    await client.preview(draft);
    await client.publish(draft, true);
    await client.revoke("entry/1", 3);
    await client.amend("entry/1", 3, { ...draft, label: "Company website" }, true);
    await client.history("entry/1", "event cursor");
    await client.useRequests("request cursor");
    await client.requestCollaboration("entry/1", true);
    await client.resolveUseRequest("request/1", 2, "contacted");
    expect(calls).toEqual([
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/policy", method: "GET", body: undefined },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/policy/history?after=1", method: "GET", body: undefined },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/policy", method: "PUT", body: { member_facts_enabled: true, expected_revision: 0, confirm: true } },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/singletons", method: "GET", body: undefined },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/singletons/history?after=2", method: "GET", body: undefined },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/singletons", method: "PUT", body: { singleton_capability_keys: ["official.website", "service.phone"], expected_revision: 0, confirm: true } },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2?after=cursor%2F1", method: "GET", body: undefined },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/preview", method: "POST", body: draft },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2", method: "POST", body: { ...draft, confirm_disclosure: true } },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/entry%2F1", method: "DELETE", body: { schema_version: 2, expected_version: 3 } },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/entry%2F1", method: "PATCH", body: { ...draft, label: "Company website", expected_version: 3, confirm_disclosure: true } },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/entry%2F1/history?after=event%20cursor", method: "GET", body: undefined },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/requests?after=request%20cursor", method: "GET", body: undefined },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/entry%2F1/requests", method: "POST", body: { confirm_identity_sharing: true } },
      { path: "/spaces/space%20%2F%20one/coordination-registry/v2/requests/request%2F1", method: "PATCH", body: { expected_revision: 2, resolution: "contacted" } },
    ]);
  });
});

describe("private project publication proposal contract", () => {
  it("uses project-scoped submit/withdraw and reviewer-only review routes with optimistic revisions", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const client = createSpaceCoordinationProposalClient({
      spaceId: "space / one",
      request: async <T>(path: string, init?: { method?: "GET" | "POST" | "DELETE" | "PATCH" | "PUT"; body?: unknown }) => {
        calls.push({ path, method: init?.method ?? "GET", body: init?.body });
        return {} as T;
      },
    });
    const draft = { schema_version: 2 as const, capability_key: "official.website", label: "Company site", audience: "space_members" as const, expires_at: null };
    await client.submit("private/project", draft, true, "10000000-0000-4000-8000-000000000001");
    await client.listProject("private/project", "cursor/1");
    await client.reviewQueue("cursor/2");
    await client.review("10000000-0000-4000-8000-000000000001", 1, "approve", draft);
    await client.withdraw("private/project", "10000000-0000-4000-8000-000000000001", 1);
    expect(calls).toEqual([
      { path: "/spaces/space%20%2F%20one/projects/private%2Fproject/coordination-proposals", method: "POST",
        body: { request_id: "10000000-0000-4000-8000-000000000001", ...draft, confirm_disclosure: true } },
      { path: "/spaces/space%20%2F%20one/projects/private%2Fproject/coordination-proposals?after=cursor%2F1", method: "GET", body: undefined },
      { path: "/spaces/space%20%2F%20one/coordination-proposals?after=cursor%2F2", method: "GET", body: undefined },
      { path: "/spaces/space%20%2F%20one/coordination-proposals/10000000-0000-4000-8000-000000000001", method: "PATCH",
        body: { expected_revision: 1, action: "approve", confirm_disclosure: true, draft } },
      { path: "/spaces/space%20%2F%20one/projects/private%2Fproject/coordination-proposals/10000000-0000-4000-8000-000000000001", method: "DELETE", body: { expected_revision: 1 } },
    ]);
  });
});
