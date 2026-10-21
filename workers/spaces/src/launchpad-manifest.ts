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
  version: "2.1.0",
  author: "naelao",
  icon: "https://assets.naelao.com/spacetypes/launchpad/icon-128.png",
  tags: ["creator", "e-commerce", "subscription", "community", "payments"],

  agentEnvironment: {
    defaultExecutionTier: "isolate",
    // AVOS compute arbitrage: native containers scale to zero after one minute. The runtime
    // coordinator refreshes this lease while work is active; SpaceType overrides are forbidden.
    containerIdleTimeoutMs: 60_000,
    loopModel: "task-completion",
    alwaysLoadedSkills: ["web-search", "knowledge-base", "notifications"],
    disabledSkills: [],
    networkPolicy: "open",
    maxContextTokens: 100_000,
    agentPermissions: [],
  },

  backend: {
    platformDOs: [], // Launchpad relies on SpaceDO + NaelaoAgentDO (already instantiated)
    r2Prefixes: ["workspace", "agents", "scripts", "portal"],
    scriptAgentsEnabled: true,
    fulfillment: { agentId: "launchpad-fulfillment-v1", projectNameFallback: "orders" },
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
      // §A1.17 Phase N (G-4b): corrected from the early "dynamic-worker" wording — the settled,
      // built architecture (A1.9) is a CF Pages static shell fronted by the portal Worker as
      // CF-for-SaaS fallback origin, routing by Host header. One multitenant surface, not a
      // Worker-per-tenant.
      deploymentType: "cf-pages",
      templateId: "launchpad-storefront",
      defaultSlug: "shop",
      customDomain: true,
      authModel: "customer-auth",
    },
  },

  // Launchpad products begin with a business onboarding flow. The product root is the
  // catalogue/onboarding hub; the user's first real workspace is a child business.
  productConfig: {
    tenancy: "saas",
    membershipModel: "hybrid",
    agencyShell: false,
    assistantMode: "per-user",
    allowPublicSignup: true,
    allowedChildSpaceTypes: ["launchpad"],
    billingRelationship: "platform",
    userPermissions: {
      canCreateSpace: true,
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
