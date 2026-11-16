import type { BlueprintBusinessRoleResourceRefV1, BlueprintBusinessRoleV1, BlueprintProject,
  BlueprintExtensionRequirements } from "./types.js";

const ROLE_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SYMBOL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EXTENSION_ID = /^ext_[a-z][a-z0-9_]{0,59}$/;
const ACTION_ID = /^[a-z][a-z0-9._:-]{0,95}$/;
const COLLECTION_ID = /^[a-z][a-z0-9_-]{2,63}$/;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_ROLE_COUNT = 32;
const MAX_ROLE_BYTES = 64 * 1024;

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function canonicalText(value: unknown, maximum: number): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid business role localization");
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.length > 12) throw new Error("Invalid business role localization");
  const normalized = new Map<string, string>();
  for (const [rawLocale, rawText] of entries) {
    const locale = rawLocale.toLowerCase();
    if (!LOCALE.test(rawLocale) || normalized.has(locale) || typeof rawText !== "string"
      || !rawText.trim() || rawText.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(rawText)) {
      throw new Error("Invalid business role localization");
    }
    normalized.set(locale, rawText.normalize("NFC").trim());
  }
  return Object.fromEntries([...normalized.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function canonicalIds(value: unknown, maximum: number, field: string): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !ACTION_ID.test(item))) {
    throw new Error(`Invalid business role ${field}`);
  }
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate business role ${field}`);
  return [...ids].sort();
}

function canonicalResource(value: unknown, projectIds: ReadonlySet<string>, extensionIds: ReadonlySet<string>,
  knowledgeRefs: ReadonlySet<string>): BlueprintBusinessRoleResourceRefV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid business role resource reference");
  const raw = value as Record<string, unknown>;
  if (raw.kind === "project" && onlyKeys(raw, ["kind", "projectId"]) && typeof raw.projectId === "string"
    && SYMBOL_ID.test(raw.projectId) && projectIds.has(raw.projectId)) {
    return { kind: "project", projectId: raw.projectId };
  }
  if (raw.kind === "extension" && onlyKeys(raw, ["kind", "extensionId"]) && typeof raw.extensionId === "string"
    && EXTENSION_ID.test(raw.extensionId) && extensionIds.has(raw.extensionId)) {
    return { kind: "extension", extensionId: raw.extensionId };
  }
  if (raw.kind === "microapp" && onlyKeys(raw, ["kind", "extensionId", "microappId"])
    && typeof raw.extensionId === "string" && EXTENSION_ID.test(raw.extensionId) && extensionIds.has(raw.extensionId)
    && typeof raw.microappId === "string" && SYMBOL_ID.test(raw.microappId)) {
    return { kind: "microapp", extensionId: raw.extensionId, microappId: raw.microappId };
  }
  if (raw.kind === "knowledge" && onlyKeys(raw, ["kind", "extensionId", "knowledgeId"])
    && typeof raw.extensionId === "string" && EXTENSION_ID.test(raw.extensionId) && extensionIds.has(raw.extensionId)
    && typeof raw.knowledgeId === "string" && COLLECTION_ID.test(raw.knowledgeId)
    && knowledgeRefs.has(`${raw.extensionId}:${raw.knowledgeId}`)) {
    return { kind: "knowledge", extensionId: raw.extensionId, knowledgeId: raw.knowledgeId };
  }
  if (raw.kind === "collection" && onlyKeys(raw, ["kind", "extensionId", "collectionId"])
    && typeof raw.extensionId === "string" && EXTENSION_ID.test(raw.extensionId) && extensionIds.has(raw.extensionId)
    && typeof raw.collectionId === "string" && COLLECTION_ID.test(raw.collectionId)
    && knowledgeRefs.has(`${raw.extensionId}:${raw.collectionId}`)) {
    return { kind: "collection", extensionId: raw.extensionId, collectionId: raw.collectionId };
  }
  if (raw.kind === "shared_data" && onlyKeys(raw, ["kind", "projectId", "extensionId", "microappId", "collectionId"])
    && typeof raw.projectId === "string" && SYMBOL_ID.test(raw.projectId) && projectIds.has(raw.projectId)
    && typeof raw.extensionId === "string" && EXTENSION_ID.test(raw.extensionId) && extensionIds.has(raw.extensionId)
    && typeof raw.microappId === "string" && SYMBOL_ID.test(raw.microappId)
    && typeof raw.collectionId === "string" && COLLECTION_ID.test(raw.collectionId)) {
    return { kind: "shared_data", projectId: raw.projectId, extensionId: raw.extensionId,
      microappId: raw.microappId, collectionId: raw.collectionId };
  }
  throw new Error("Invalid or undeclared business role resource reference");
}

function resourceKey(resource: BlueprintBusinessRoleResourceRefV1): string {
  switch (resource.kind) {
    case "project": return `project:${resource.projectId}`;
    case "extension": return `extension:${resource.extensionId}`;
    case "microapp": return `microapp:${resource.extensionId}:${resource.microappId}`;
    case "knowledge": return `knowledge:${resource.extensionId}:${resource.knowledgeId}`;
    case "collection": return `knowledge:${resource.extensionId}:${resource.collectionId}`;
    case "shared_data": return `shared_data:${resource.projectId}:${resource.extensionId}:${resource.microappId}:${resource.collectionId}`;
  }
}

/**
 * Validate and canonicalize data-only template proposals. This does not resolve grants or
 * install/authorize any referenced resource; callers must obtain customer owner approval later.
 */
export function validateBlueprintBusinessRoles(value: unknown, context: {
  projects: readonly Pick<BlueprintProject, "id">[];
  requiredExtensions: readonly string[];
  extensionRequirements?: BlueprintExtensionRequirements;
}): BlueprintBusinessRoleV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ROLE_COUNT) {
    throw new Error("Invalid business role list");
  }
  const declaredProjectIds = context.projects.map((project) => project.id).filter((id): id is string => typeof id === "string" && SYMBOL_ID.test(id));
  if (new Set(declaredProjectIds).size !== declaredProjectIds.length) throw new Error("Duplicate business role project reference");
  const projectIds = new Set(declaredProjectIds);
  const extensionIds = new Set(context.requiredExtensions.filter((id) => EXTENSION_ID.test(id)));
  const knowledgeRefs = new Set((context.extensionRequirements?.knowledge ?? []).map((item) => `${item.extensionId}:${item.knowledgeId}`));
  const roleIds = new Set<string>();
  const roles = (value as unknown[]).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid business role");
    const raw = item as Record<string, unknown>;
    if (!onlyKeys(raw, ["id", "name", "description", "recommendedSpaceRole", "resourceRequests", "assistant", "onboardingSteps", "spendingSuggestion"])
      || typeof raw.id !== "string" || !ROLE_ID.test(raw.id) || roleIds.has(raw.id)) {
      throw new Error("Invalid or duplicate business role");
    }
    roleIds.add(raw.id);
    if (raw.recommendedSpaceRole !== undefined && raw.recommendedSpaceRole !== "member" && raw.recommendedSpaceRole !== "admin") {
      throw new Error("Invalid business role Space role suggestion");
    }

    let resourceRequests: BlueprintBusinessRoleV1["resourceRequests"];
    if (raw.resourceRequests !== undefined) {
      if (!Array.isArray(raw.resourceRequests) || raw.resourceRequests.length > 64) throw new Error("Invalid business role resource requests");
      const seenResources = new Set<string>();
      resourceRequests = (raw.resourceRequests as unknown[]).map((request) => {
        if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid business role resource request");
        const entry = request as Record<string, unknown>;
        if (!onlyKeys(entry, ["resource", "actions", "purpose"])) throw new Error("Invalid business role resource request");
        const resource = canonicalResource(entry.resource, projectIds, extensionIds, knowledgeRefs);
        const key = resourceKey(resource);
        if (seenResources.has(key)) throw new Error("Duplicate business role resource request");
        seenResources.add(key);
        const actions = canonicalIds(entry.actions, 32, "actions");
        if (!actions.length) throw new Error("Invalid business role actions");
        return { resource, actions, purpose: canonicalText(entry.purpose, 240) };
      }).sort((a, b) => resourceKey(a.resource).localeCompare(resourceKey(b.resource)));
    }

    let assistant: BlueprintBusinessRoleV1["assistant"];
    if (raw.assistant !== undefined) {
      if (!raw.assistant || typeof raw.assistant !== "object" || Array.isArray(raw.assistant)) throw new Error("Invalid business role assistant proposal");
      const entry = raw.assistant as Record<string, unknown>;
      if (!onlyKeys(entry, ["mode", "instructions", "allowedActions"])
        || entry.mode !== undefined && entry.mode !== "inherit" && entry.mode !== "read_only" && entry.mode !== "none") {
        throw new Error("Invalid business role assistant proposal");
      }
      const allowedActions = entry.allowedActions === undefined ? undefined : canonicalIds(entry.allowedActions, 64, "assistant actions");
      if (entry.mode === undefined && entry.instructions === undefined && allowedActions === undefined) throw new Error("Empty business role assistant proposal");
      assistant = {
        ...(entry.mode === "inherit" || entry.mode === "read_only" || entry.mode === "none" ? { mode: entry.mode } : {}),
        ...(entry.instructions !== undefined ? { instructions: canonicalText(entry.instructions, 2_000) } : {}),
        ...(allowedActions !== undefined ? { allowedActions } : {}),
      };
    }

    let onboardingSteps: BlueprintBusinessRoleV1["onboardingSteps"];
    if (raw.onboardingSteps !== undefined) {
      if (!Array.isArray(raw.onboardingSteps) || raw.onboardingSteps.length > 20) throw new Error("Invalid business role onboarding steps");
      const stepIds = new Set<string>();
      onboardingSteps = (raw.onboardingSteps as unknown[]).map((step) => {
        if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error("Invalid business role onboarding step");
        const entry = step as Record<string, unknown>;
        if (!onlyKeys(entry, ["id", "title", "instructions", "required"]) || typeof entry.id !== "string"
          || !ROLE_ID.test(entry.id) || stepIds.has(entry.id) || typeof entry.required !== "boolean") {
          throw new Error("Invalid business role onboarding step");
        }
        stepIds.add(entry.id);
        return { id: entry.id, title: canonicalText(entry.title, 120), instructions: canonicalText(entry.instructions, 1_200), required: entry.required };
      }).sort((a, b) => a.id.localeCompare(b.id));
    }

    let spendingSuggestion: BlueprintBusinessRoleV1["spendingSuggestion"];
    if (raw.spendingSuggestion !== undefined) {
      if (!raw.spendingSuggestion || typeof raw.spendingSuggestion !== "object" || Array.isArray(raw.spendingSuggestion)) throw new Error("Invalid business role spending suggestion");
      const entry = raw.spendingSuggestion as Record<string, unknown>;
      if (!onlyKeys(entry, ["monthlyCredits", "approvalActions"]) || entry.monthlyCredits === undefined && entry.approvalActions === undefined
        || entry.monthlyCredits !== undefined && (!Number.isSafeInteger(entry.monthlyCredits) || Number(entry.monthlyCredits) < 0 || Number(entry.monthlyCredits) > 10_000_000)) {
        throw new Error("Invalid business role spending suggestion");
      }
      const approvalActions = entry.approvalActions === undefined ? undefined : canonicalIds(entry.approvalActions, 64, "approval actions");
      spendingSuggestion = { ...(entry.monthlyCredits !== undefined ? { monthlyCredits: Number(entry.monthlyCredits) } : {}),
        ...(approvalActions !== undefined ? { approvalActions } : {}) };
    }

    return {
      id: raw.id,
      name: canonicalText(raw.name, 120),
      ...(raw.description !== undefined ? { description: canonicalText(raw.description, 1_000) } : {}),
      ...(raw.recommendedSpaceRole !== undefined ? { recommendedSpaceRole: raw.recommendedSpaceRole as "member" | "admin" } : {}),
      ...(resourceRequests !== undefined ? { resourceRequests } : {}),
      ...(assistant !== undefined ? { assistant } : {}),
      ...(onboardingSteps !== undefined ? { onboardingSteps } : {}),
      ...(spendingSuggestion !== undefined ? { spendingSuggestion } : {}),
    } satisfies BlueprintBusinessRoleV1;
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new TextEncoder().encode(JSON.stringify(roles)).byteLength > MAX_ROLE_BYTES) throw new Error("Business role proposals exceed the size limit");
  return roles;
}
