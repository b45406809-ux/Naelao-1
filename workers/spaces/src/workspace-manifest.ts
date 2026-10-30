/** Launchpad is Naelao's default product. Its users create Spaces and install Space Templates. */
import type { NaelaoSpaceTypeManifestV2 } from "./do/SpaceTypeRegistryDO.js";

export const LAUNCHPAD_MANIFEST: NaelaoSpaceTypeManifestV2 = {
  id: "launchpad",
  name: "Launchpad",
  description: "Naelao's AI OS for Spaces, assistants, projects, extensions, and user-defined workflows.",
  version: "1.0.0",
  author: "naelao",
  icon: "layout",
  tags: ["workspace", "agents", "extensions"],
  agentEnvironment: {
    defaultExecutionTier: "isolate",
    containerIdleTimeoutMs: 60_000,
    loopModel: "task-completion",
    alwaysLoadedSkills: ["web-search", "knowledge-base", "notifications"],
    disabledSkills: [],
    networkPolicy: "open",
    maxContextTokens: 100_000,
    agentPermissions: [],
  },
  backend: {
    platformDOs: [],
    r2Prefixes: ["workspace", "agents", "scripts"],
    scriptAgentsEnabled: true,
  },
  ui: {
    operatorShell: {
      sidebarItems: [{ id: "agents", label: "Agents", icon: "cpu", path: "/agents" }],
      dashboardWidgets: [],
      hiddenCoreItems: [],
      defaultView: "agents",
    },
  },
  productConfig: {
    tenancy: "team",
    membershipModel: "team",
    agencyShell: false,
    assistantMode: "per-user",
    allowPublicSignup: false,
    allowedChildSpaceTypes: ["launchpad"],
    userPermissions: {
      canCreateSpace: true,
      canCreateSubSpaces: true,
      canCreateProjects: true,
      maxThreadsPerUser: null,
      maxCreditsPerMonth: null,
    },
  },
  lifecycle: {},
  marketplace: {
    visible: true,
    minimumNaelaoPlan: "free",
    priceUsdPerMonth: 0,
    trialDays: 0,
    capabilities: ["Naelao workspace", "Projects", "Space Templates", "Extensions"],
  },
};

/** Compatibility for records created with the temporary workspace type id. */
export const WORKSPACE_MANIFEST: NaelaoSpaceTypeManifestV2 = {
  ...LAUNCHPAD_MANIFEST,
  id: "workspace",
  name: "Workspace (compatibility)",
  marketplace: { ...LAUNCHPAD_MANIFEST.marketplace, visible: false },
};
