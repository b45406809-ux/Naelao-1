/** System One may suggest only attachment operations installed for this run and compatible
 * with its placement. Owner opt-in and per-object authorization are still checked at execution. */
type AttachmentTool = "attachment.inspect" | "attachment.read" | "attachment.copy" | "attachment.ocr" | "attachment.describe" | "attachment.transcribe";

export function attachmentToolsForRun(prebuilt: readonly string[], airGappedOnly: boolean): AttachmentTool[] {
  const customerAttachments = prebuilt.includes("customer-attachments");
  const projectOrSpaceAttachments = prebuilt.includes("attachments") && !customerAttachments;
  if (!projectOrSpaceAttachments && !customerAttachments) return [];
  const local: AttachmentTool[] = ["attachment.inspect", "attachment.read", "attachment.copy"];
  const safeLocal = customerAttachments && !projectOrSpaceAttachments
    ? local.filter(tool => tool !== "attachment.copy") : local;
  return airGappedOnly ? safeLocal : [...safeLocal, "attachment.ocr", "attachment.describe", "attachment.transcribe"];
}
