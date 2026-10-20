import type { NaelaoSpaceTypeManifestV2 } from "../../spaces/src/do/SpaceTypeRegistryDO.js";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function boundedArray(value: unknown, maxLength: number): value is unknown[] {
  return Array.isArray(value) && value.length <= maxLength;
}

function textList(value: unknown, maxCount: number, maxLength: number): value is string[] {
  return boundedArray(value, maxCount) && value.every((entry) => text(entry, maxLength));
}

function finiteNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}

/** Validate the manifest fields that provisioning will dereference or use as resource keys. */
export function isProvisionableManifest(value: unknown, expectedId: string): value is NaelaoSpaceTypeManifestV2 {
  if (!record(value) || value.id !== expectedId || !text(value.name, 120) || !text(value.description, 2000) ||
      !text(value.version, 64) || value.author !== "naelao" || !text(value.icon, 256) || !textList(value.tags, 100, 64) ||
      !record(value.agentEnvironment) || !record(value.backend) || !record(value.ui) || !record(value.lifecycle) || !record(value.marketplace)) return false;
  const agent = value.agentEnvironment;
  if (!["workspace", "isolate", "browser", "sandbox"].includes(String(agent.defaultExecutionTier)) ||
      !finiteNumber(agent.containerIdleTimeoutMs, 86_400_000) ||
      !["chat", "file-edit", "knowledge-graph", "task-completion", "content", "remote"].includes(String(agent.loopModel)) ||
      !textList(agent.alwaysLoadedSkills, 1000, 128) || !textList(agent.disabledSkills, 1000, 128) ||
      !["open", "restricted", "none"].includes(String(agent.networkPolicy)) ||
      (agent.networkAllowlist !== undefined && !textList(agent.networkAllowlist, 100, 256)) ||
      !finiteNumber(agent.maxContextTokens, 10_000_000) || !textList(agent.agentPermissions, 256, 128)) return false;
  const backend = value.backend;
  if (!boundedArray(backend.platformDOs, 100) || !backend.platformDOs.every((entry) =>
    record(entry) && text(entry.type, 64) && text(entry.namingPattern, 128)
  )) return false;
  if (!boundedArray(backend.r2Prefixes, 100) || !backend.r2Prefixes.every((prefix) =>
    text(prefix, 128) && /^[A-Za-z0-9._/-]+$/.test(prefix) && !prefix.split("/").some((part) => part === "." || part === "..")
  )) return false;
  if (!boundedArray(backend.workflowTemplates, 100) || !backend.workflowTemplates.every((entry) =>
    record(entry) && text(entry.id, 128) && text(entry.name, 256) && text(entry.triggerType, 64)
  )) return false;
  if (!boundedArray(backend.cronJobs, 100) || !backend.cronJobs.every((entry) =>
    record(entry) && text(entry.id, 128) && text(entry.cron, 128) && text(entry.workerBinding, 128)
  )) return false;
  if (backend.scriptAgentsEnabled !== undefined && typeof backend.scriptAgentsEnabled !== "boolean") return false;
  if (backend.spaceDoInitHook !== undefined && !text(backend.spaceDoInitHook, 128)) return false;
  if (!record(backend.resourceBudget) || ![
    backend.resourceBudget.maxDOsPerInstance,
    backend.resourceBudget.maxR2WritesPerDay,
    backend.resourceBudget.maxContainerHoursPerDay,
    backend.resourceBudget.maxLLMTokensPerDay,
    backend.resourceBudget.maxCronJobsPerInstance,
    backend.resourceBudget.maxWorkflowsPerInstance,
  ].every((limit) => finiteNumber(limit))) return false;
  if (value.productConfig !== undefined && value.productConfig !== null && !record(value.productConfig)) return false;

  const shell = value.ui.operatorShell;
  if (!record(shell) || !boundedArray(shell.sidebarItems, 100) || !shell.sidebarItems.every((item) =>
    record(item) && text(item.id, 128) && text(item.label, 128) && text(item.icon, 64) && text(item.path, 256)
  ) || !textList(shell.dashboardWidgets, 100, 128) || !textList(shell.hiddenCoreItems, 100, 128) || !text(shell.defaultView, 128)) return false;
  const portal = value.ui.externalPortal;
  if (portal !== undefined && portal !== null) {
    if (!record(portal) || typeof portal.enabled !== "boolean") return false;
    if (portal.enabled && (!text(portal.templateId, 128) || !text(portal.defaultSlug, 64) || !/^[a-z0-9-]+$/.test(portal.defaultSlug) ||
        !["cf-pages", "dynamic-worker"].includes(String(portal.deploymentType)) || typeof portal.customDomain !== "boolean" ||
        !["public", "customer-auth", "gated"].includes(String(portal.authModel)))) return false;
  }
  const lifecycle = value.lifecycle;
  for (const key of ["provisionerWorker", "deprovisionerWorker", "migratorWorker", "healthCheckUrl"] as const) {
    const endpoint = lifecycle[key];
    if (endpoint !== undefined && endpoint !== null && !text(endpoint, 2048)) return false;
  }
  const customWorker = value.lifecycle.provisionerWorker;
  if (customWorker !== undefined && customWorker !== null) {
    if (!text(customWorker, 2048)) return false;
    try {
      const url = new URL(customWorker);
      if (url.protocol !== "https:" || url.username || url.password) return false;
    } catch { return false; }
  }
  const marketplace = value.marketplace;
  if (typeof marketplace.visible !== "boolean" || !["free", "maker", "pro", "team", "enterprise"].includes(String(marketplace.minimumNaelaoPlan)) ||
      !finiteNumber(marketplace.priceUsdPerMonth) || !finiteNumber(marketplace.trialDays, 365) || !textList(marketplace.capabilities, 256, 128)) return false;
  return true;
}
