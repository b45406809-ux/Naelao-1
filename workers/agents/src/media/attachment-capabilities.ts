/** System One may suggest only attachment operations installed for this run and compatible
 * with its placement. Owner opt-in and per-object authorization are still checked at execution. */
type AttachmentTool = "attachment.inspect" | "attachment.read" | "attachment.copy" | "attachment.ocr" | "attachment.transcribe";

export function attachmentToolsForRun(prebuilt: readonly string[], airGappedOnly: boolean): AttachmentTool[] {
  if (!prebuilt.includes("attachments")) return [];
  const local: AttachmentTool[] = ["attachment.inspect", "attachment.read", "attachment.copy"];
  return airGappedOnly ? local : [...local, "attachment.ocr", "attachment.transcribe"];
}
