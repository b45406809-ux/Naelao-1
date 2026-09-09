export type VentureCategory = "AGENCY" | "MICRO_SAAS" | "COWORK" | "VOICE_DESK";

export interface RadarOpportunity {
  id: string;
  rank: number;
  title: string;
  niche: string;
  category: VentureCategory;
  trafficSurgePct: number;
  saturationIndex: number; // 0 to 100 (Lower = Less Competition / Blue Ocean)
  opportunityScore: number; // 0 to 100 (Combined Viability)
  estimatedMrrRange: string;
  recommendedArchetype: string;
  blueprintSpec: {
    baseTemplateId: string;
    seedProjects: Array<{ name: string; kind: string; plugins: string[] }>;
    initialPromptDirectives: string;
    preconfiguredScraperTargets?: string[];
  };
}

export interface PartnerAccountRecord {
  id: string;
  userId: string;
  displayName: string;
  payoutEmail: string;
  commissionRatePct: number; // 40.0 for referral, 20.0 for organic
  totalEarnedCents: number;
  balanceCents: number;
  createdAt: string;
}

export interface PartnerTemplateListing {
  id: string;
  partnerId: string;
  name: string;
  category: string;
  description: string;
  blueprintR2Key: string;
  priceCentsMonthly: number;
  isPublic: boolean;
  createdAt: string;
}
