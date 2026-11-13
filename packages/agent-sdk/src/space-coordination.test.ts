import { describe, expect, it } from "vitest";
import { createSpaceCoordinationClient, validateSpaceCoordinationDraft } from "./space-coordination.js";

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
      request: async <T>(path: string, init?: { method?: "GET" | "POST" | "DELETE"; body?: unknown }) => {
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
