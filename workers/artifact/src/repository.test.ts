import { describe, expect, it } from "vitest";
import { commitBody, encodeGitObject, objectKey, repositoryName, validateMetadata } from "./repository.js";

const metadata = {
  agent_role: "builder", user_goal: "ship it", task_id: "task-1", rationale: "implemented feature",
  thread_id: "thread-1", tool_turn_id: "turn-1",
};

describe("repository scoping", () => {
  it("isolates tenant, space and project namespaces", () => {
    const a = { tenantId: "tenant-a", spaceId: "space", projectId: "project" };
    const b = { tenantId: "tenant-b", spaceId: "space", projectId: "project" };
    expect(repositoryName(a)).not.toBe(repositoryName(b));
    expect(objectKey(a, "a".repeat(40))).not.toBe(objectKey(b, "a".repeat(40)));
  });

  it("rejects path-like scope components", () => {
    expect(() => repositoryName({ tenantId: "../other", spaceId: "s", projectId: "p" })).toThrow();
  });
});

describe("Git object and metadata encoding", () => {
  it("matches Git's known empty blob id", async () => {
    expect((await encodeGitObject("blob", new Uint8Array())).oid).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("round-trips structured agent metadata in a commit body", () => {
    const valid = validateMetadata(metadata);
    const text = new TextDecoder().decode(commitBody("a".repeat(40), undefined, "message", valid, "2026-01-01T00:00:00.000Z"));
    expect(JSON.parse(text.split("naelao-metadata ")[1]!.trim())).toEqual(metadata);
  });

  it("requires every rollback audit field", () => {
    expect(() => validateMetadata({ ...metadata, tool_turn_id: "" })).toThrow("metadata.tool_turn_id");
  });
});
