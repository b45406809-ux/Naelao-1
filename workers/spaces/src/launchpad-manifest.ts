/**
 * Launchpad SpaceType manifest v2 (spec §61/§62).
 * Seeded into SpaceTypeRegistryDO at deploy time.
 * Loop model: task-completion. External portal: Lemon Squeezy storefront.
 */

import type { NaelaoSpaceTypeManifestV2 } from "./do/SpaceTypeRegistryDO.js";

export const LAUNCHPAD_MANIFEST: NaelaoSpaceTypeManifestV2 = {
  id: "launchpad",
  name: "Launchpad",
  description: "Creator economy platform — sell products, subscriptions, and memberships with AI-powered operations.",
  version: "2.0.0",
  author: "naelao",
  icon: "https://assets.naelao.com/spacetypes/launchpad/icon-128.png",
  tags: ["creator", "e-commerce", "subscription", "community", "payments"],

  agentEnvironment: {
    defaultExecutionTier: "isolate",
    containerIdleTimeoutMs: 600_000, // 10 min idle
    loopModel: "task-completion",
    alwaysLoadedSkills: ["web-search", "knowledge-base", "notifications"],
    disabledSkills: [],
    networkPolicy: "open",
    maxContextTokens: 100_000,
    agentPermissions: [],
  },

  backend: {
    platformDOs: [], // Launchpad relies on SpaceDO + NaelaoAgentDO (already instantiated)
    workflowTemplates: [
      { id: "order-fulfillment", name: "Order Fulfillment", triggerType: "event" },
      { id: "subscription-renewal", name: "Subscription Renewal", triggerType: "schedule" },
      { id: "customer-onboarding", name: "Customer Onboarding", triggerType: "event" },
    ],
    cronJobs: [
      { id: "daily-analytics", cron: "0 8 * * *", workerBinding: "ANALYTICS_WORKER" },
    ],
    r2Prefixes: ["workspace", "agents", "scripts", "portal"],
    resourceBudget: {
      maxDOsPerInstance: 5,
      maxR2WritesPerDay: 10_000,
      maxContainerHoursPerDay: 2,
      maxLLMTokensPerDay: 1_000_000,
      maxCronJobsPerInstance: 5,
      maxWorkflowsPerInstance: 20,
    },
  },

  ui: {
    operatorShell: {
      sidebarItems: [
        { id: "revenue", label: "Revenue", icon: "dollar", path: "/revenue" },
        { id: "orders", label: "Orders", icon: "shopping-cart", path: "/orders" },
        { id: "customers", label: "Customers", icon: "users", path: "/customers" },
        { id: "products", label: "Products", icon: "box", path: "/products" },
        { id: "campaigns", label: "Campaigns", icon: "megaphone", path: "/campaigns" },
        { id: "agents", label: "Agents", icon: "cpu", path: "/agents" },
      ],
      dashboardWidgets: [],
      hiddenCoreItems: [],
      defaultView: "revenue",
    },
    externalPortal: {
      enabled: true,
      deploymentType: "dynamic-worker",
      templateId: "launchpad-storefront",
      defaultSlug: "shop",
      customDomain: true,
      authModel: "customer-auth",
    },
  },

  // Default: a single business operated by an invited team, one assistant per member.
  // Builders flip membershipModel→"tenant"/"hybrid" to resell (let customers create
  // their own businesses, Polsia-style), and assistantMode→"shared" for one CEO chat.
  productConfig: {
    tenancy: "team",
    membershipModel: "team",
    agencyShell: false,
    assistantMode: "per-user",
    allowPublicSignup: false,
    allowedChildSpaceTypes: ["launchpad"],
    billingRelationship: "platform",
    userPermissions: {
      canCreateSpace: false,
      canCreateSubSpaces: true,
      canCreateProjects: true,
      maxThreadsPerUser: null,
      maxCreditsPerMonth: null,
    },
    // Launchpad is a commerce SpaceType: owners sell digital products. Money-in routes
    // through Naelao's Lemon Squeezy store with a 5% platform fee (reserved capability).
    commerce: {
      enabled: true,
      defaultCurrency: "USD",
      naelaoFeeBps: 500,
      allowCustomDomain: true,
    },
    businessServices: {
      storefront: true,
      businessEmail: true,
    },
  },

  lifecycle: {}, // No custom provisioner/deprovisioner hooks for Launchpad

  marketplace: {
    visible: true,
    minimumNaelaoPlan: "free",
    priceUsdPerMonth: 0,
    trialDays: 14,
    capabilities: [
      "sell digital products",
      "subscription billing via Lemon Squeezy",
      "AI-powered customer support",
      "email campaigns",
      "customer portal",
      "order automation",
    ],
  },
};
