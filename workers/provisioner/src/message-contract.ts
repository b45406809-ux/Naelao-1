export interface ProvisionMessage {
  type: "space_provision" | "space_deprovision";
  spaceId: string;
  tenantId: string;
  spaceTypeId: string;
  spaceName: string;
  templateId?: string;
  templateIds?: string[];
  requestedAt: string;
  userId?: string;
}

const ID_MAX = 128;
const TEMPLATE_MAX = 100;

function boundedText(value: unknown, max = ID_MAX): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Validate queue payloads before they reach destructive R2/D1 operations. */
export function isProvisionMessage(value: unknown): value is ProvisionMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type !== "space_provision" && message.type !== "space_deprovision") return false;
  if (!boundedText(message.spaceId) || !boundedText(message.tenantId)) return false;
  if (!boundedText(message.spaceTypeId) || !boundedText(message.spaceName, 256) || !boundedText(message.requestedAt, 64)) return false;
  if (message.userId !== undefined && !boundedText(message.userId)) return false;
  if (message.type === "space_deprovision") return true;
  if (message.templateId !== undefined && !boundedText(message.templateId)) return false;
  if (message.templateIds !== undefined && (
    !Array.isArray(message.templateIds) ||
    message.templateIds.length > TEMPLATE_MAX ||
    message.templateIds.some((id) => !boundedText(id))
  )) return false;
  return true;
}
