export interface Parse5RequestOptions {
  model?: string; // Default: "parse-v5.0"
  outputFormat?: "markdown" | "json";
}

export interface ParsedDocumentResult {
  docId: string;
  markdown: string;
  pageCount: number;
  tablesDetected: number;
  durationMs: number;
  rawByteSize: number;
}

export interface IngestDocumentPayload {
  spaceId: string;
  projectId?: string;
  title: string;
  fileBuffer: ArrayBuffer;
  contentType: string;
  visibility?: "public" | "private" | "role_restricted";
  minRoleRank?: number; // 1: Viewer -> 5: Owner
}
