import { describe, expect, it } from "vitest";
import { actorAddress } from "./runtime-context.js";

describe("actorAddress", () => {
  it("structurally isolates private, project and space actors", () => {
    expect(actorAddress({ scope: "USER_PRIVATE", spaceId: "s", userId: "u" })).toBe("actor:personal:s:u");
    expect(actorAddress({ scope: "PROJECT_BOUND", spaceId: "s", projectId: "p" })).toBe("actor:project:s:p");
    expect(actorAddress({ scope: "SPACE_WIDE", spaceId: "s" })).toBe("actor:space:s");
  });
});
