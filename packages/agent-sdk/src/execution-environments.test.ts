import { describe, expect, it } from "vitest";
import { eligibleEnvironments, selectEnvironment, previewTemplateRuntimes, validateTemplateRuntimes, type EnvironmentCard, type TemplateRuntimeRequirement } from "./execution-environments.js";
const owner = { tenantId: "tenant", spaceId: "space", projectId: "project", scope: "PROJECT_BOUND" as const };
const card: EnvironmentCard = { ...owner, id: "managed", kind: "managed", provider: "cf", capabilities: ["bash"], observedAt: 1000, available: true, authorized: true, persistence: "ephemeral", filesystemModel: "workspace-backed", apps: [], externalUse: [] };
describe("environment policy", () => {
  it("filters stale, cross-scope, revoked and future observations before ranking", () => {
    const invalid = [{ ...card, id: "other", spaceId: "other" }, { ...card, id: "private", scope: "ASSISTANT_PRIVATE" as const }, { ...card, id: "revoked", authorized: false }, { ...card, id: "future", observedAt: 1002 }];
    expect(eligibleEnvironments([card, ...invalid], owner, { capabilities: ["bash"], mode: "managed" }, 1001)).toEqual([card]);
    expect(eligibleEnvironments([card], owner, { capabilities: [], mode: "managed" }, 62000)).toEqual([]);
  });
  it("requires explicit external consent and host availability evidence", () => {
    const external: EnvironmentCard = { ...card, id: "gpu", kind: "external", filesystemModel: "machine-local", persistence: "filesystem", externalUse: ["fallback"], capabilities: ["bash", "cuda"] };
    expect(() => selectEnvironment([external], owner, { capabilities: ["cuda"], mode: "fallback" }, undefined, undefined, 1001)).toThrow("no_eligible");
    expect(selectEnvironment([external], owner, { capabilities: ["cuda"], mode: "fallback", managedUnavailable: true }, undefined, undefined, 1001).id).toBe("gpu");
    expect(() => selectEnvironment([external], owner, { capabilities: ["cuda"], mode: "capability" }, undefined, undefined, 1001)).toThrow("no_eligible");
    expect(external.filesystemModel).toBe("machine-local");
    expect(card.filesystemModel).toBe("workspace-backed");
  });
  it("does not let model selection override eligibility or replace a pinned session", () => {
    expect(selectEnvironment([card], owner, { capabilities: ["bash"], mode: "managed" }, "invented", undefined, 1001).id).toBe("managed");
    expect(() => selectEnvironment([card], owner, { capabilities: ["bash"], mode: "managed" }, undefined, "missing", 1001)).toThrow("session_target_unavailable");
  });
  it("requires fresh account-specific authentication evidence", () => {
    const loggedIn = { ...card, apps: [{ id: "browser", connectionId: "account-a", authenticatedAt: 1000 }] };
    expect(selectEnvironment([loggedIn], owner, { capabilities: [], mode: "managed", connectionId: "account-a" }, undefined, undefined, 1001)).toEqual(loggedIn);
    expect(() => selectEnvironment([loggedIn], owner, { capabilities: [], mode: "managed", connectionId: "account-b" }, undefined, undefined, 1001)).toThrow();
  });
});
const core: TemplateRuntimeRequirement = { id: "core", capabilities: ["bash"], required: true, priority: 2, dependencies: [] };
describe("template runtime previews", () => {
  it("includes prerequisites before optional upgrades and reports plan restrictions", () => {
    const gpu = { id: "gpu", capabilities: ["cuda"], required: false, priority: 0, dependencies: ["core"] };
    expect(previewTemplateRuntimes([gpu, core], 1, ["bash", "cuda"])).toEqual({ installable: true, components: [
      { id: "core", required: true, status: "included" }, { id: "gpu", required: false, status: "deferred", reason: "plan_slot_limit" },
    ] });
    expect(previewTemplateRuntimes([core], 0, ["bash"]).installable).toBe(false);
  });
  it("rejects cyclic, missing and duplicate dependencies", () => {
    expect(() => validateTemplateRuntimes([{ ...core, dependencies: ["core"] }])).toThrow("cycle");
    expect(() => validateTemplateRuntimes([{ ...core, dependencies: ["missing"] }])).toThrow("missing");
    expect(() => validateTemplateRuntimes([core, core])).toThrow("invalid");
  });
  it("blocks required capabilities that are unavailable", () => expect(previewTemplateRuntimes([core], 10, []).installable).toBe(false));
  it("handles maximum-size dependency chains", () => {
    const chain = Array.from({ length: 64 }, (_, index) => ({ ...core, id: `runtime${index}`, dependencies: index ? [`runtime${index - 1}`] : [] }));
    expect(previewTemplateRuntimes(chain, 64, ["bash"]).components).toHaveLength(64);
    expect(() => previewTemplateRuntimes([...chain, { ...core, id: "overflow" }], 65, ["bash"])).toThrow();
  });
});

import { validateMachineApps, validateMachineGrants } from "./tunnel-protocol.js";
describe("bridge inventory and consent validation", () => {
  it("rejects credential-bearing app inventory and malformed external consent", () => {
    expect(() => validateMachineApps([{ id: "browser", cookies: "private" } as never])).toThrow("tunnel_app_invalid");
    expect(() => validateMachineApps([{ id: "browser", authenticatedAt: 1000 }])).toThrow("tunnel_app_invalid");
    expect(() => validateMachineApps(Array.from({ length: 65 }, () => ({ id: "app" })))).toThrow();
    expect(() => validateMachineGrants([{ id: "grant", actorId: "owner", commands: [], roots: [], inference: false, expiresAt: Date.now() + 1000, externalUse: ["anything" as never] }])).toThrow("external_use_invalid");
  });
});
