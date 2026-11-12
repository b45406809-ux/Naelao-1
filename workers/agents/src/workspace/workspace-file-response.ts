import { isInlineTextContentType } from "@naelao/types";

/** Encode text for inline preview and preserve opaque/binary bytes as base64. */
export function encodeWorkspaceFileContent(bytes: Uint8Array, contentType: string): { content: string } | { encoding: "base64"; content: string } {
  if (isInlineTextContentType(contentType)) return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) };
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return { encoding: "base64", content: btoa(binary) };
}
