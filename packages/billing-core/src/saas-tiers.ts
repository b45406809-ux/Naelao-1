/**
 * SaaS Subscription Tiers, Unified Usage Metering & Platform Monetization
 * 
 * Implements the 3-Stream Billing Architecture for AVOS / Launchpad:
 * 1. SaaS Subscriptions: Free ($0), Starter ($29), Pro ($99-$150), Enterprise ($299+)
 * 2. Usage-Based Metering: 1 Platform Credit = $0.01 USD (Tokens, Isolates, Workflows, Scraping, Headless Browser, Containers, Voice Call minutes, Phone Numbers)
 * 3. Marketplace & Take-Rate Settlements: Storefronts (5%), Invoices/Retainers (1.5%), Developer Referrals (40/60), Organic Marketplace (20/80), One-off licenses (100%)
 */

import { CREDITS_PER_USD } from "./index.js";

export type PlatformSaaSTier = "free" | "starter" | "pro" | "enterprise";

export interface SaaSTierConfig {
  id: PlatformSaaSTier;
  name: string;
  priceMonthlyCents: number;
  includedComputeCreditsMonthly: number; // e.g. Starter gets $10 (1000 credits), Pro gets $35 (3500 credits)
  maxWorkspaces: number;
  maxThreadsPerProject: number; // -1 for unlimited
  maxCustomDomains: number;
  maxSubSpaces: number; // Sub-spaces / Departments
  maxTeamSeats: number;
  maxBotsPerProject: number; // Free: 2, Starter: 5, Pro: 15, Enterprise: -1 (unlimited)
  maxConcurrentBotExecutions: number; // Concurrency ladder capacity
  dailySpendLimitCreditsDefault: number; // Project daily spend cap default
  unlockedExecutionTiers: number[]; // 1..6
  features: {
    byokOnly: boolean;
    personalAssistantIntegrations: boolean; // WhatsApp / Telegram bot
    chromiumHeadlessQA: boolean; // Tier 5
    linuxContainerSandbox: boolean; // Tier 6
    modelStudioLoRATraining: boolean;
    voiceTelephonyDesk: boolean; // @cloudflare/voice
    artifactsPrBranching: boolean;
    whiteLabeling: boolean;
    customSslApex: boolean;
    auditRetentionDays: number;
  };
}

export const SAAS_TIER_CONFIGS: Record<PlatformSaaSTier, SaaSTierConfig> = {
  free: {
    id: "free",
    name: "Free (Hacker)",
    priceMonthlyCents: 0,
    includedComputeCreditsMonthly: 0,
    maxWorkspaces: 1,
    maxThreadsPerProject: 3,
    maxCustomDomains: 0,
    maxSubSpaces: 0,
    maxTeamSeats: 1,
    maxBotsPerProject: 2,
    maxConcurrentBotExecutions: 1,
    dailySpendLimitCreditsDefault: 200,
    unlockedExecutionTiers: [1, 2],
    features: {
      byokOnly: true,
      personalAssistantIntegrations: false,
      chromiumHeadlessQA: false,
      linuxContainerSandbox: false,
      modelStudioLoRATraining: false,
      voiceTelephonyDesk: false,
      artifactsPrBranching: false,
      whiteLabeling: false,
      customSslApex: false,
      auditRetentionDays: 7,
    },
  },
  starter: {
    id: "starter",
    name: "Starter (Solo Builder)",
    priceMonthlyCents: 2900,
    includedComputeCreditsMonthly: 1000, // $10.00 compute credit allowance
    maxWorkspaces: 3,
    maxThreadsPerProject: -1, // unlimited
    maxCustomDomains: 1,
    maxSubSpaces: 0,
    maxTeamSeats: 1,
    maxBotsPerProject: 5,
    maxConcurrentBotExecutions: 2,
    dailySpendLimitCreditsDefault: 1000,
    unlockedExecutionTiers: [1, 2, 3, 4],
    features: {
      byokOnly: false,
      personalAssistantIntegrations: true,
      chromiumHeadlessQA: false,
      linuxContainerSandbox: false,
      modelStudioLoRATraining: false,
      voiceTelephonyDesk: false,
      artifactsPrBranching: false,
      whiteLabeling: false,
      customSslApex: false,
      auditRetentionDays: 30,
    },
  },
  pro: {
    id: "pro",
    name: "Pro (Venture Studio)",
    priceMonthlyCents: 9900,
    includedComputeCreditsMonthly: 3500, // $35.00 compute credit allowance
    maxWorkspaces: 10,
    maxThreadsPerProject: -1,
    maxCustomDomains: 5,
    maxSubSpaces: 3,
    maxTeamSeats: 5,
    maxBotsPerProject: 15,
    maxConcurrentBotExecutions: 5,
    dailySpendLimitCreditsDefault: 5000,
    unlockedExecutionTiers: [1, 2, 3, 4, 5, 6],
    features: {
      byokOnly: false,
      personalAssistantIntegrations: true,
      chromiumHeadlessQA: true,
      linuxContainerSandbox: true,
      modelStudioLoRATraining: true,
      voiceTelephonyDesk: true,
      artifactsPrBranching: true,
      whiteLabeling: false,
      customSslApex: true,
      auditRetentionDays: 90,
    },
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise (Holding Co)",
    priceMonthlyCents: 29900,
    includedComputeCreditsMonthly: 10000, // $100.00 compute credit allowance
    maxWorkspaces: 100,
    maxThreadsPerProject: -1,
    maxCustomDomains: 50,
    maxSubSpaces: 25,
    maxTeamSeats: 25,
    maxBotsPerProject: -1, // Unlimited
    maxConcurrentBotExecutions: 20,
    dailySpendLimitCreditsDefault: 50000,
    unlockedExecutionTiers: [1, 2, 3, 4, 5, 6],
    features: {
      byokOnly: false,
      personalAssistantIntegrations: true,
      chromiumHeadlessQA: true,
      linuxContainerSandbox: true,
      modelStudioLoRATraining: true,
      voiceTelephonyDesk: true,
      artifactsPrBranching: true,
      whiteLabeling: true,
      customSslApex: true,
      auditRetentionDays: 365,
    },
  },
};

/**
 * Extended Usage Resource Pricing for Stream 2: Compute & Telephony Metering
 */
export type ExtendedMeteredResource =
  | "isolate"               // Tier 2: 1 Credit per 100 runs ($0.0001)
  | "workflow_step"         // Tier 3: 1 Credit per 20 steps ($0.0005)
  | "kitesurf_dom_scrape"   // Tier 4: 1 Credit per 10 scrapes ($0.001)
  | "chromium_snapshot"     // Tier 5: 1 Credit per snapshot ($0.01)
  | "container_hour"        // Tier 6: 5 Credits per active hour ($0.05)
  | "voice_call_minute"     // @cf/voice: 4 Credits per min ($0.04)
  | "phone_number_monthly"; // 200 Credits per month ($2.00)

export const EXTENDED_RESOURCE_PRICING: Record<ExtendedMeteredResource, { unitCostUsd: number; creditsPerUnit: number }> = {
  isolate: { unitCostUsd: 0.0001, creditsPerUnit: 0.01 },
  workflow_step: { unitCostUsd: 0.0005, creditsPerUnit: 0.05 },
  kitesurf_dom_scrape: { unitCostUsd: 0.001, creditsPerUnit: 0.1 },
  chromium_snapshot: { unitCostUsd: 0.01, creditsPerUnit: 1.0 },
  container_hour: { unitCostUsd: 0.05, creditsPerUnit: 5.0 },
  voice_call_minute: { unitCostUsd: 0.04, creditsPerUnit: 4.0 },
  phone_number_monthly: { unitCostUsd: 2.00, creditsPerUnit: 200.0 },
};

/**
 * Calculate credits for a metered usage event
 */
export function calculateExtendedResourceCredits(
  resource: ExtendedMeteredResource,
  quantity: number
): number {
  if (quantity <= 0) return 0;
  const pricing = EXTENDED_RESOURCE_PRICING[resource];
  const credits = pricing.creditsPerUnit * quantity;
  return Math.max(1, Math.ceil(credits));
}

/**
 * Stream 3: Downstream Commerce & Take-Rate Calculations
 */
export interface CommerceTakeRateSettlement {
  grossSaleCents: number;
  platformFeePct: number;
  platformFeeCents: number;
  netBusinessSettlementCents: number;
}

export function calculateDownstreamCommerceCut(
  grossSaleCents: number,
  type: "storefront_sale" | "invoice_retainer"
): CommerceTakeRateSettlement {
  // 5.0% for digital storefront sales, 1.5% for client invoices & retainers
  const platformFeePct = type === "storefront_sale" ? 0.05 : 0.015;
  const platformFeeCents = Math.round(grossSaleCents * platformFeePct);
  const netBusinessSettlementCents = Math.max(0, grossSaleCents - platformFeeCents);

  return {
    grossSaleCents,
    platformFeePct: platformFeePct * 100,
    platformFeeCents,
    netBusinessSettlementCents,
  };
}
