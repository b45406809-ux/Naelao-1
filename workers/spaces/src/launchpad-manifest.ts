/**
 * Launchpad SpaceType manifest v2 (spec §61/§62).
 * Seeded into SpaceTypeRegistryDO at deploy time.
 * Loop model: task-completion. Product-specific experiences are installed as Space Templates.
 */

import type { NaelaoSpaceTypeManifestV2 } from "./do/SpaceTypeRegistryDO.js";

export const LAUNCHPAD_MANIFEST: NaelaoSpaceTypeManifestV2 = {
  id: "launchpad",
  name: "Launchpad",
  description: "Naelao's general AI workspace. Install Space Templates and extensions for specialized workflows.",
  version: "3.0.0",
  author: "naelao",
  icon: "https://assets.naelao.com/spacetypes/launchpad/icon-128.png",
  tags: ["ai", "workspace", "agents", "extensions"],

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
  },

  ui: {
    operatorShell: {
      sidebarItems: [
        { id: "agents", label: "Agents", icon: "cpu", path: "/agents" },
      ],
      dashboardWidgets: [],
      hiddenCoreItems: [],
      defaultView: "agents",
    },
  },

  // Launchpad is the default Naelao workspace type. Domain workflows are provided by
  // marketplace Space Templates and installed extensions.
  productConfig: {
    tenancy: "saas",
    membershipModel: "hybrid",
    agencyShell: false,
    assistantMode: "per-user",
    allowPublicSignup: true,
    allowedChildSpaceTypes: ["launchpad"],
    userPermissions: {
      canCreateSpace: true,
      canCreateSubSpaces: true,
      canCreateProjects: true,
      maxThreadsPerUser: null,
      maxCreditsPerMonth: null,
    },
  },

  lifecycle: {}, // No custom provisioner/deprovisioner hooks for Launchpad

  marketplace: {
    visible: true,
    minimumNaelaoPlan: "free",
    priceUsdPerMonth: 0,
    trialDays: 14,
    capabilities: ["Naelao agent workspace", "Space Templates", "extensions", "connected MCP tools"],
  },
};
