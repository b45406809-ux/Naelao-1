import { SpaceId, TenantId } from "./index";

export type SpaceDepth = 0 | 1; // 0 = Parent Holding Co, 1 = Department Sub-Space

export type TenancyTopology = "single" | "team" | "saas";

export type SubSpaceScenario = "organizational" | "agency-child" | "user-workspace";

export interface CrossSpaceGrant {
  id: string;
  grantingSpaceId: string;
  receivingSpaceId: string;
  targetProjectId?: string;
  grantType: "read" | "write" | "admin" | "delegate_task";
  allowedOperations?: string[];
  grantedByUserId: string;
  grantedAt: string;
  expiresAt?: string;
}

export interface SpaceHierarchyNode {
  id: SpaceId;
  tenantId: TenantId;
  name: string;
  depth: SpaceDepth;
  parentSpaceId?: SpaceId | null;
  tenancyMode: TenancyTopology;
  isAutomationAnchor: boolean;
}
