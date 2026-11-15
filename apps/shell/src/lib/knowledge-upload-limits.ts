export const SPACE_KNOWLEDGE_MAX_CONTENT_BYTES = 1_048_576;
export const PROJECT_KNOWLEDGE_MAX_CONTENT_BYTES = 5 * 1_048_576;

export function knowledgeContentByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export function knowledgeContentLimitBytes(projectId?: string | null): number {
  return projectId ? PROJECT_KNOWLEDGE_MAX_CONTENT_BYTES : SPACE_KNOWLEDGE_MAX_CONTENT_BYTES;
}

export function assertKnowledgeContentWithinScope(content: string, projectId?: string | null): void {
  const limit = knowledgeContentLimitBytes(projectId);
  const actual = knowledgeContentByteLength(content);
  if (actual > limit) {
    const scope = projectId ? "Project-private" : "Space-wide";
    throw new RangeError(`${scope} Knowledge content is ${actual} bytes; the limit is ${limit} bytes.`);
  }
}
