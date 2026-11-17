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
  const isImage = /\.(?:png|jpe?g)$/i.test(file.name) && (!file.type || file.type === "image/png" || file.type === "image/jpeg");
  if (!isPdf && !isDocx && !isXlsx && !isPptx && !isImage) throw new TypeError("Choose a PDF, DOCX, XLSX, PPTX, PNG or JPEG file.");
  if (file.size < 5 || file.size > (isImage ? 1_048_576 : knowledgeContentLimitBytes(projectId))) {
    throw new RangeError(isImage ? "Knowledge images are limited to 1 MiB." : projectId ? "Project Knowledge files are limited to 5 MiB." : "Space-wide Knowledge files are limited to 1 MiB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPdf && new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new TypeError("The selected file is not a valid PDF document.");
  if ((isDocx || isXlsx || isPptx) && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) throw new TypeError("The selected file is not a supported Office archive.");
  const imageHeaderValid = /\.png$/i.test(file.name)
    ? bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    : bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (isImage && !imageHeaderValid) {
    throw new TypeError("The selected file is not a supported PNG or JPEG image.");
  }
  return encodeKnowledgePdfBytes(bytes);
}

export const readKnowledgePdfFile = readKnowledgeSourceFile;
