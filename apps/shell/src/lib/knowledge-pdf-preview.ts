import { knowledgeContentLimitBytes } from "./knowledge-upload-limits";

export function encodeKnowledgePdfBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

export async function readKnowledgePdfFile(file: File, projectId?: string | null): Promise<string> {
  if (!/\.pdf$/i.test(file.name) || file.type && file.type !== "application/pdf") {
    throw new TypeError("Choose a PDF file.");
  }
  if (file.size < 5 || file.size > knowledgeContentLimitBytes(projectId)) {
    throw new RangeError(projectId ? "Project Knowledge PDF files are limited to 5 MiB." : "Space-wide Knowledge PDF files are limited to 1 MiB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new TypeError("The selected file is not a valid PDF document.");
  return encodeKnowledgePdfBytes(bytes);
}
