import { knowledgeContentLimitBytes } from "./knowledge-upload-limits";

export function encodeKnowledgePdfBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

export async function readKnowledgeSourceFile(file: File, projectId?: string | null): Promise<string> {
  const isPdf = /\.pdf$/i.test(file.name) && (!file.type || file.type === "application/pdf");
  const isDocx = /\.docx$/i.test(file.name) && (!file.type || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  if (!isPdf && !isDocx) throw new TypeError("Choose a PDF or DOCX file.");
  if (file.size < 5 || file.size > knowledgeContentLimitBytes(projectId)) {
    throw new RangeError(projectId ? "Project Knowledge files are limited to 5 MiB." : "Space-wide Knowledge files are limited to 1 MiB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPdf && new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new TypeError("The selected file is not a valid PDF document.");
  if (isDocx && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) throw new TypeError("The selected file is not a DOCX archive.");
  return encodeKnowledgePdfBytes(bytes);
}

export const readKnowledgePdfFile = readKnowledgeSourceFile;
