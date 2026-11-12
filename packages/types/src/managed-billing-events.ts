export type DunningProvider = "lemon_squeezy" | "whop";

export interface DunningEventIdentity {
  provider: DunningProvider;
  subscriptionId: string;
  providerEventId: string | null;
  providerUpdatedAt: string | null;
}

interface DunningEventFields extends DunningEventIdentity {
  type: "dunning";
  workflow_id: string;
}

type DunningEventScope = {
  scope: "platform_subscription";
  orgId: string;
} | {
  scope: "product_user_subscription";
  productId: string;
  endUserId: string;
};

export type DunningEventV1 = DunningEventFields & DunningEventScope & { version: 1 };

/** Records written before versioning was introduced remain readable as v1 during queue recovery. */
export type DunningEventMessage = DunningEventFields & DunningEventScope & { version?: 1 };

function boundedNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function isDunningEventMessage(value: unknown): value is DunningEventMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.type !== "dunning" || (body.version !== undefined && body.version !== 1) ||
      typeof body.workflow_id !== "string" || !/^dunning-[a-f0-9]{64}$/.test(body.workflow_id) ||
      (body.provider !== "lemon_squeezy" && body.provider !== "whop") ||
      !boundedNonEmpty(body.subscriptionId) ||
      !(body.providerEventId === null || (typeof body.providerEventId === "string" && body.providerEventId.length <= 256)) ||
      !(body.providerUpdatedAt === null ||
        (typeof body.providerUpdatedAt === "string" && Number.isFinite(Date.parse(body.providerUpdatedAt))))) return false;

  if (body.scope === "platform_subscription") return boundedNonEmpty(body.orgId);
  return body.scope === "product_user_subscription" && boundedNonEmpty(body.productId) && boundedNonEmpty(body.endUserId);
}
