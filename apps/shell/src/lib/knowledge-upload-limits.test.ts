import { describe, expect, it } from "vitest";
import {
  assertKnowledgeContentWithinScope,
  knowledgeContentByteLength,
  knowledgeContentLimitBytes,
  PROJECT_KNOWLEDGE_MAX_CONTENT_BYTES,
  SPACE_KNOWLEDGE_MAX_CONTENT_BYTES,
} from "./knowledge-upload-limits";

describe("scope-specific Knowledge upload limits", () => {
  it("matches the server's Space-wide and project workflow byte ceilings", () => {
    expect(knowledgeContentLimitBytes()).toBe(1_048_576);
    expect(knowledgeContentLimitBytes("project-1")).toBe(5 * 1_048_576);
    expect(SPACE_KNOWLEDGE_MAX_CONTENT_BYTES).toBe(1_048_576);
    expect(PROJECT_KNOWLEDGE_MAX_CONTENT_BYTES).toBe(5 * 1_048_576);
  });

  it("counts UTF-8 bytes rather than JavaScript characters", () => {
    expect(knowledgeContentByteLength("a\u{1f680}")).toBe(5);
  });

  it("accepts the exact scope limit and rejects the first byte above it", () => {
    expect(() => assertKnowledgeContentWithinScope("a".repeat(SPACE_KNOWLEDGE_MAX_CONTENT_BYTES))).not.toThrow();
    expect(() => assertKnowledgeContentWithinScope("a".repeat(SPACE_KNOWLEDGE_MAX_CONTENT_BYTES + 1)))
      .toThrow(/Space-wide Knowledge content/);
    expect(() => assertKnowledgeContentWithinScope("a".repeat(PROJECT_KNOWLEDGE_MAX_CONTENT_BYTES), "project-1")).not.toThrow();
    expect(() => assertKnowledgeContentWithinScope("a".repeat(PROJECT_KNOWLEDGE_MAX_CONTENT_BYTES + 1), "project-1"))
      .toThrow(/Project-private Knowledge content/);
  });
});
