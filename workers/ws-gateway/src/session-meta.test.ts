import { describe, expect, it } from "vitest";
import { restoreWsSessionMeta } from "./session-meta";

describe("restoreWsSessionMeta", () => {
  it("prefers the full hibernation attachment", () => {
    const attachment = { tenantId: "t1", spaceId: "s1", userId: "u1", sessionId: "run1" };
    expect(restoreWsSessionMeta(attachment, ["tenantId:wrong", "spaceId:wrong"])).toEqual(attachment);
  });

  it("reconstructs legacy tag-only identity", () => {
    expect(restoreWsSessionMeta(null, ["tenantId:t1", "spaceId:s1"])).toEqual({ tenantId: "t1", spaceId: "s1" });
  });

  it("returns undefined when no durable identity exists", () => {
    expect(restoreWsSessionMeta(undefined, [])).toBeUndefined();
  });
});
