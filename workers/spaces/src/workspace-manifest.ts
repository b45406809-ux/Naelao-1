/** Generic default Space type. Domain behavior and specialized setup ship as Space Templates and
 * extensions; this manifest only supplies the shared Naelao workspace runtime. */
import type { NaelaoSpaceTypeManifestV2 } from "./do/SpaceTypeRegistryDO.js";

export const WORKSPACE_MANIFEST: NaelaoSpaceTypeManifestV2 = {
  id: "workspace",
  name: "Workspace",
  description: "A general Naelao Space for assistants, projects, extensions, and user-defined workflows.",
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
    allowedChildSpaceTypes: ["workspace"],
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

/** Existing Spaces may still carry the old type id. Keep it resolvable with the generic shell
 * defaults while hiding it from new type selection; all new Spaces use `workspace`. */
export const LEGACY_LAUNCHPAD_MANIFEST: NaelaoSpaceTypeManifestV2 = {
  ...WORKSPACE_MANIFEST,
  id: "launchpad",
  name: "Workspace (legacy type)",
  description: "Compatibility type for existing Spaces. New Spaces use Workspace.",
  marketplace: { ...WORKSPACE_MANIFEST.marketplace, visible: false },
};
