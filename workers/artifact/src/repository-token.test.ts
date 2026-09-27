import { describe, expect, it } from "vitest";
import {
  createRepositoryToken,
  verifyRepositoryToken,
} from "./repository-token.js";

describe("repository mount tokens", () => {
  it("accepts only an unexpired token for the exact repository", async () => {
    const claims = {
      tenantId: "tenant",
      spaceId: "space",
      projectId: "project",
      repoId: "project",
      exp: 2_000,
    };
    const token = await createRepositoryToken("secret", claims);
    await expect(
      verifyRepositoryToken("secret", token, "project", 1_000)
    ).resolves.toEqual(claims);
    await expect(
      verifyRepositoryToken("secret", token, "other", 1_000)
    ).resolves.toBeNull();
    await expect(
      verifyRepositoryToken("secret", token, "project", 2_000)
    ).resolves.toBeNull();
    await expect(
      verifyRepositoryToken("wrong", token, "project", 1_000)
    ).resolves.toBeNull();
  });
});
