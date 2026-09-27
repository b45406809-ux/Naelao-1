import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_ROLE_MASK,
  hasKnowledgeBitmaskAccess,
  resolveKnowledgeClearance,
} from "./knowledge-permissions.js";

describe("sovereign knowledge clearance", () => {
  it("maps roles to their specified one-hot masks", () => {
    expect(KNOWLEDGE_ROLE_MASK).toEqual({
      owner: 16,
      admin: 8,
      editor: 4,
      member: 2,
      viewer: 1,
    });
    expect(hasKnowledgeBitmaskAccess(10, KNOWLEDGE_ROLE_MASK.member)).toBe(
      true
    );
    expect(hasKnowledgeBitmaskAccess(10, KNOWLEDGE_ROLE_MASK.viewer)).toBe(
      false
    );
  });

  it("fails closed outside verified space and project memberships", () => {
    const claims = {
      userId: "u1",
      role: "member" as const,
      spaceIds: ["s1"],
      projectIds: ["p1"],
    };
    expect(resolveKnowledgeClearance(claims, "s1", "p1")).toMatchObject({
      roleMask: 2,
      scope: "PROJECT_BOUND",
    });
    expect(() => resolveKnowledgeClearance(claims, "s1", "secret")).toThrow(
      /project/
    );
    expect(() => resolveKnowledgeClearance(claims, "other")).toThrow(/space/);
  });
});
