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
  const isXlsx = /\.xlsx$/i.test(file.name) && (!file.type || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const isPptx = /\.pptx$/i.test(file.name) && (!file.type || file.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  if (!isPdf && !isDocx && !isXlsx && !isPptx) throw new TypeError("Choose a PDF, DOCX, XLSX or PPTX file.");
  if (file.size < 5 || file.size > knowledgeContentLimitBytes(projectId)) {
    throw new RangeError(projectId ? "Project Knowledge files are limited to 5 MiB." : "Space-wide Knowledge files are limited to 1 MiB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPdf && new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new TypeError("The selected file is not a valid PDF document.");
  if ((isDocx || isXlsx || isPptx) && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) throw new TypeError("The selected file is not a supported Office archive.");
  return encodeKnowledgePdfBytes(bytes);
}

export const readKnowledgePdfFile = readKnowledgeSourceFile;
