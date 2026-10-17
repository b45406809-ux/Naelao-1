import { describe, expect, it } from "vitest";
import { actorAddress, scopedInstallationId } from "./runtime-context.js";

describe("actorAddress", () => {
  it("structurally isolates private, project and space actors", () => {
    expect(actorAddress({ scope: "USER_PRIVATE", spaceId: "s", userId: "u" })).toBe("actor:personal:s:u");
    expect(actorAddress({ scope: "PROJECT_BOUND", spaceId: "s", projectId: "p" })).toBe("actor:project:s:p");
    expect(actorAddress({ scope: "SPACE_WIDE", spaceId: "s" })).toBe("actor:space:s");
  });
});

describe("scopedInstallationId instance keys", () => {
  const base = { tenantId: "t", spaceId: "s", projectId: "p", extensionId: "ext_bot", scope: "PROJECT_BOUND" as const };
  it("keeps the default identity stable and isolates explicitly named instances", () => {
    expect(scopedInstallationId(base)).toBe(scopedInstallationId({ ...base, instanceKey: "default" }));
    expect(scopedInstallationId({ ...base, instanceKey: "trading_live" })).not.toBe(scopedInstallationId({ ...base, instanceKey: "trading_paper" }));
  });
  it("rejects invalid instance keys", () => {
    expect(() => scopedInstallationId({ ...base, instanceKey: "../shared" })).toThrow("invalid_instance_key");
  });
});
