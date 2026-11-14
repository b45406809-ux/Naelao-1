"use client";

import * as React from "react";
import Link from "next/link";
import { Button, Badge, Card, CardTitle, CardDesc, FormInput, FormSelect, Modal, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { listMySpaces, createSpace, getSpaceAnalytics, listSpaceTemplates, forkSpaceTemplate, activateSpaceTemplate, previewSpaceTemplateActivation, getSpaceTemplateSetupDraft, saveSpaceTemplateSetupDraft, listSpaceTemplateInstallations, previewSpaceTemplateSetupUpdate, applySpaceTemplateSetupUpdate, previewSpaceSharedExtensionImport, importSpaceSharedExtension, previewSpaceSharedExtensionInstall, installSpaceSharedExtension, type SpaceTemplateInstallationRecord, type SpaceTemplateActivationPreview, type SpaceTemplateSetupMigrationPreview, type SpaceTemplateExpectedUsageV1, type SpaceTemplateSetupValue, type SpaceTemplateSetupValues, type SpaceSummary, type SpaceTemplateListing, type SpaceSharedExtensionImportReview, type SpaceSharedExtensionInstallReview } from "@/lib/api";
import { listModelBenchmarks, DEFAULT_WORKING_MODEL, type CostTier } from "@naelao/billing-core";
import { isBlueprintSetupFieldVisible, resolveBlueprintSetupFieldHelpText, resolveBlueprintSetupFieldLabel, resolveBlueprintSetupOptionLabel, type BlueprintSetupField } from "@naelao/agent-sdk";
import { createLatestRequestFence, parseTemplateExpectedUsageInput } from "@/lib/template-usage-estimate";
import { modelLabel } from "@/components/ModelSelector";

const COST_TIER_LABEL: Record<CostTier, string> = { economy: "Economy", standard: "Standard", premium: "Premium" };
const COST_TIER_BADGE: Record<CostTier, "green" | "blue" | "amber"> = { economy: "green", standard: "blue", premium: "amber" };
const AXIS_LABEL: Record<string, string> = {
  agency: "Multi-step", safety: "Safety", fabrication: "Won't invent results",
  recovery: "Recovers", proactivity: "Escalates", synthesis: "Briefings",
};

interface SpaceActivity {
  space: SpaceSummary;
  runs: number;
  credits: number;
  successRate: number | null;
  failed: boolean;
}

interface TemplateDependencyImportProgress {
  sourceSpaceId: string;
  importReview?: SpaceSharedExtensionImportReview | undefined;
  importedPackages?: string[] | undefined;
  installReview?: SpaceSharedExtensionInstallReview | undefined;
  notice?: string | undefined;
}

function defaultSetupValues(preview: SpaceTemplateActivationPreview): SpaceTemplateSetupValues {
  const values: SpaceTemplateSetupValues = {};
  for (const group of preview.setup_fields) {
    const fields: Record<string, SpaceTemplateSetupValue> = {};
    for (const field of group.fields) if (isBlueprintSetupFieldVisible(group.fields, field, fields) && field.defaultValue !== undefined) fields[field.id] = field.defaultValue;
    if (Object.keys(fields).length) values[group.project_id] = fields;
  }
  return values;
}

function rebaseSetupValues(current: SpaceTemplateSetupValues, preview: SpaceTemplateActivationPreview): SpaceTemplateSetupValues {
  const values = defaultSetupValues(preview);
  for (const group of preview.setup_fields) {
    const projectValues = { ...(values[group.project_id] ?? {}) };
    for (const field of group.fields) {
      if (!isBlueprintSetupFieldVisible(group.fields, field, projectValues)) continue;
      const existing = current[group.project_id]?.[field.id];
      if (existing === undefined) continue;
      if ((field.type === "text" && typeof existing === "string") || (field.type === "number" && typeof existing === "number")
        || (field.type === "boolean" && typeof existing === "boolean") || (field.type === "select" && typeof existing === "string")) {
        projectValues[field.id] = existing;
      }
    }
    if (Object.keys(projectValues).length) values[group.project_id] = projectValues;
  }
  return values;
}

function TemplateSetupInput({ projectId, field, value, onChange }: {
  projectId: string; field: BlueprintSetupField; value: SpaceTemplateSetupValue | undefined;
  onChange: (value: SpaceTemplateSetupValue | undefined) => void;
}) {
  const inputId = `template-${projectId}-${field.id}`;
  const [locale, setLocale] = React.useState("en");
  React.useEffect(() => { if (typeof navigator !== "undefined") setLocale(navigator.language || "en"); }, []);
  const label = resolveBlueprintSetupFieldLabel(field, locale);
  const helpText = resolveBlueprintSetupFieldHelpText(field, locale);
  return <label htmlFor={inputId} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(180px,1fr)", alignItems: "center", gap: 8, marginTop: 8 }}>
    <span>{label}{field.required ? " *" : ""}{helpText && <small style={{ display: "block", color: "var(--text3)" }}>{helpText}</small>}</span>
    {field.type === "boolean" ? <select id={inputId} required={field.required} value={typeof value === "boolean" ? String(value) : ""} onChange={event => onChange(event.target.value === "" ? undefined : event.target.value === "true")}>
        <option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option>
      </select>
      : field.type === "select" ? <select id={inputId} required={field.required} value={typeof value === "string" ? value : ""} onChange={event => onChange(event.target.value || undefined)}>
        <option value="">Choose…</option>{field.options.map(option => <option key={option.value} value={option.value}>{resolveBlueprintSetupOptionLabel(field, option.value, locale)}</option>)}
      </select>
      : field.type === "number" ? <input id={inputId} type="number" required={field.required} min={field.minimum} max={field.maximum} step={field.integer ? 1 : "any"} value={typeof value === "number" ? value : ""} onChange={event => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />
      : <input id={inputId} type="text" required={field.required} minLength={field.minLength} maxLength={field.maxLength} value={typeof value === "string" ? value : ""} onChange={event => onChange(event.target.value)} />}
  </label>;
}

export default function SpacesPage() {
  const product = useProduct();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const [spaces, setSpaces] = React.useState<SpaceSummary[]>([]);
  const [templates, setTemplates] = React.useState<SpaceTemplateListing[]>([]);
  const [activities, setActivities] = React.useState<SpaceActivity[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [listFailed, setListFailed] = React.useState(false);
  const [activityLoading, setActivityLoading] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [showAllModels, setShowAllModels] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [newSpaceName, setNewSpaceName] = React.useState("");
  const [templateId, setTemplateId] = React.useState("");
  const [assistantEmailMode,setAssistantEmailMode]=React.useState<""|"none"|"naelao_managed"|"user_connected">("");
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [createdSpaceId, setCreatedSpaceId] = React.useState<string | null>(null);
  const [activationReview, setActivationReview] = React.useState<{ spaceId: string; blueprintId: string; preview: SpaceTemplateActivationPreview; applyCoordinationDefault?: boolean; extensionRequirementsReviewed?: boolean; filesystemGrantSelections?: Record<string, Record<string, "KEEP" | "NONE" | "READ" | "READ_WRITE">> } | null>(null);
  const [dependencyImports, setDependencyImports] = React.useState<Record<string, TemplateDependencyImportProgress>>({});
  const [dependencyImportBusy, setDependencyImportBusy] = React.useState<string | null>(null);
  const [setupValues, setSetupValues] = React.useState<SpaceTemplateSetupValues>({});
  const [setupDraftRevision, setSetupDraftRevision] = React.useState(0);
  const [setupDraftNeedsReplacement, setSetupDraftNeedsReplacement] = React.useState(false);
  const [setupDraftStatus, setSetupDraftStatus] = React.useState("");
  const [savingSetupDraft, setSavingSetupDraft] = React.useState(false);
  const [expectedConversations, setExpectedConversations] = React.useState("");
  const [expectedInteractions, setExpectedInteractions] = React.useState("");
  const [updatingUsageEstimate, setUpdatingUsageEstimate] = React.useState(false);
  const [usageEstimateError, setUsageEstimateError] = React.useState("");
  const [activatingTemplate, setActivatingTemplate] = React.useState(false);
  const [refreshingPreview, setRefreshingPreview] = React.useState(false);
  const [openingPendingTemplate, setOpeningPendingTemplate] = React.useState<string | null>(null);
  const [templateStatusSpace, setTemplateStatusSpace] = React.useState<SpaceSummary | null>(null);
  const [templateStatusRecords, setTemplateStatusRecords] = React.useState<SpaceTemplateInstallationRecord[]>([]);
  const [templateStatusLoading, setTemplateStatusLoading] = React.useState(false);
  const [templateSetupUpdatePreviews, setTemplateSetupUpdatePreviews] = React.useState<Record<string, SpaceTemplateSetupMigrationPreview>>({});
  const [templateSetupUpdateValues, setTemplateSetupUpdateValues] = React.useState<Record<string, SpaceTemplateSetupValues>>({});
  const [templateSetupUpdateClearedFields, setTemplateSetupUpdateClearedFields] = React.useState<Record<string, Array<{ project_id: string; field_id: string }>>>({});
  const [templateSetupUpdateDataLossConfirmed, setTemplateSetupUpdateDataLossConfirmed] = React.useState<Record<string, boolean>>({});
  const [templateSetupUpdateBusy, setTemplateSetupUpdateBusy] = React.useState<string | null>(null);
  const pendingPreviewed = React.useRef(new Set<string>());
  const expectedUsageEstimateRequests = React.useRef(createLatestRequestFence()).current;
  const expectedUsageSpaceId = activationReview?.spaceId ?? null;
  const expectedUsageBlueprintId = activationReview?.blueprintId ?? null;
  const creds = React.useMemo(() => session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null, [session]);
  const selectedTemplate = templates.find(template => template.id === templateId);

  function patchDependencyImport(extensionId: string, patch: Partial<TemplateDependencyImportProgress>) {
    setDependencyImports(current => ({ ...current, [extensionId]: {
      sourceSpaceId: current[extensionId]?.sourceSpaceId ?? "", ...current[extensionId], ...patch,
    } }));
  }

  async function openTemplateStatus(space: SpaceSummary) {
    if (!creds) return;
    setTemplateStatusSpace(space);
    setTemplateStatusRecords([]);
    setTemplateSetupUpdatePreviews({});
    setTemplateSetupUpdateValues({});
    setTemplateSetupUpdateClearedFields({});
    setTemplateSetupUpdateDataLossConfirmed({});
    setTemplateStatusLoading(true);
    try {
      const result = await listSpaceTemplateInstallations(space.id, creds);
      setTemplateStatusRecords(result.installations);
    } catch (error) {
      show(`Template status unavailable: ${error instanceof Error ? error.message : "request failed"}`);
      setTemplateStatusSpace(null);
    } finally { setTemplateStatusLoading(false); }
  }

  function templateUpdateKey(spaceId: string, blueprintId: string): string { return `${spaceId}:${blueprintId}`; }

  async function previewTemplateSetupUpdate(record: SpaceTemplateInstallationRecord) {
    if (!creds || !templateStatusSpace || !record.source_update?.setup_migration_available
      || !record.source_update.source_listing_id || !record.source_update.source_artifact_sha256) return;
    const key = templateUpdateKey(templateStatusSpace.id, record.blueprint_id);
    setTemplateSetupUpdateBusy(key);
    try {
      const preview = await previewSpaceTemplateSetupUpdate(templateStatusSpace.id, record.blueprint_id, creds, {
        source_listing_id: record.source_update.source_listing_id,
        source_artifact_sha256: record.source_update.source_artifact_sha256,
        expected_artifact_sha256: record.artifact_sha256,
        expected_setup_revision: record.setup_revision,
      });
      setTemplateSetupUpdatePreviews(current => ({ ...current, [key]: preview }));
      setTemplateSetupUpdateValues(current => ({ ...current, [key]: preview.values }));
      setTemplateSetupUpdateClearedFields(current => ({ ...current, [key]: [] }));
      setTemplateSetupUpdateDataLossConfirmed(current => ({ ...current, [key]: false }));
    } catch (error) { show(`Setup migration preview unavailable: ${error instanceof Error ? error.message : "request failed"}`); }
    finally { setTemplateSetupUpdateBusy(null); }
  }

  async function confirmTemplateSetupUpdate(record: SpaceTemplateInstallationRecord) {
    if (!creds || !templateStatusSpace || !record.source_update?.setup_migration_available
      || !record.source_update.source_listing_id || !record.source_update.source_artifact_sha256) return;
    const key = templateUpdateKey(templateStatusSpace.id, record.blueprint_id);
    const preview = templateSetupUpdatePreviews[key];
    if (!preview) return;
    const values = templateSetupUpdateValues[key] ?? preview.values;
    const missing = preview.setup_schema_groups.flatMap(group => group.fields.flatMap(field =>
      field.required && isBlueprintSetupFieldVisible(group.fields, field, values[group.project_id] ?? {})
        && values[group.project_id]?.[field.id] === undefined ? [field.id] : []));
    if (missing.length) { show(`Complete the required setup fields: ${missing.join(", ")}`); return; }
    const dropsSavedValues = preview.setup_migration_operations.some(operation => operation.kind === "drop");
    if (dropsSavedValues && !templateSetupUpdateDataLossConfirmed[key]) {
      show("Confirm the listed saved-value removal before applying this migration."); return;
    }
    setTemplateSetupUpdateBusy(key);
    try {
      await applySpaceTemplateSetupUpdate(templateStatusSpace.id, record.blueprint_id, creds, {
        source_listing_id: record.source_update.source_listing_id,
        source_artifact_sha256: record.source_update.source_artifact_sha256,
        expected_artifact_sha256: record.artifact_sha256,
        expected_setup_revision: record.setup_revision,
        setup_values: values,
        clear_fields: templateSetupUpdateClearedFields[key] ?? [],
        confirm_data_loss: dropsSavedValues && templateSetupUpdateDataLossConfirmed[key] === true,
      });
      const refreshed = await listSpaceTemplateInstallations(templateStatusSpace.id, creds);
      setTemplateStatusRecords(refreshed.installations);
      setTemplateSetupUpdatePreviews(current => { const next = { ...current }; delete next[key]; return next; });
      setTemplateSetupUpdateValues(current => { const next = { ...current }; delete next[key]; return next; });
      setTemplateSetupUpdateClearedFields(current => { const next = { ...current }; delete next[key]; return next; });
      setTemplateSetupUpdateDataLossConfirmed(current => { const next = { ...current }; delete next[key]; return next; });
      show("Template setup settings were updated. No project or provider resources were changed.");
    } catch (error) { show(`Setup update was not applied: ${error instanceof Error ? error.message : "request failed"}`); }
    finally { setTemplateSetupUpdateBusy(null); }
  }

  async function loadTemplateSetupDraft(spaceId: string, blueprintId: string, preview: SpaceTemplateActivationPreview, restoreValues: boolean) {
    if (!creds) return;
    if (restoreValues) { setExpectedConversations(""); setExpectedInteractions(""); setUsageEstimateError(""); }
    setSetupDraftRevision(0);
    setSetupDraftNeedsReplacement(false);
    try {
      const draft = await getSpaceTemplateSetupDraft(spaceId, blueprintId, creds);
      setSetupDraftRevision(draft.revision);
      setSetupDraftNeedsReplacement(draft.exists && !draft.binding_matches);
      if (restoreValues) setSetupValues(draft.binding_matches && draft.values ? rebaseSetupValues(draft.values, preview) : defaultSetupValues(preview));
      setSetupDraftStatus(draft.exists
        ? draft.binding_matches ? "Saved setup draft resumed." : "The saved draft belongs to a different signed template or setup schema. Review these fields before replacing it."
        : "");
    } catch {
      setSetupDraftRevision(0);
      setSetupDraftNeedsReplacement(false);
      if (restoreValues) setSetupValues(defaultSetupValues(preview));
      setSetupDraftStatus("Saved setup could not be checked. Review the fields and retry before relying on a saved draft.");
    }
  }

  async function saveCurrentTemplateDraft() {
    if (!creds || !activationReview || savingSetupDraft || activationReview.preview.setup_fields.length === 0) return;
    setSavingSetupDraft(true);
    try {
      const saved = await saveSpaceTemplateSetupDraft(activationReview.spaceId, activationReview.blueprintId, creds,
        setupValues, setupDraftRevision, setupDraftNeedsReplacement);
      setSetupDraftRevision(saved.revision);
      setSetupDraftNeedsReplacement(false);
      setSetupDraftStatus("Setup draft saved securely for this Space and signed template.");
    } catch (error) {
      setSetupDraftStatus(`Setup draft was not saved: ${error instanceof Error ? error.message : "save failed"}`);
    } finally { setSavingSetupDraft(false); }
  }

  const fetchExpectedUsageEstimate = React.useCallback(async (
    usage: SpaceTemplateExpectedUsageV1 | null, requestId: number, validationError: string | null,
  ) => {
    if (!creds || !expectedUsageSpaceId || !expectedUsageBlueprintId || !expectedUsageEstimateRequests.isCurrent(requestId)) return;
    setUpdatingUsageEstimate(true);
    setUsageEstimateError(validationError ?? "");
    try {
      const preview = await previewSpaceTemplateActivation(expectedUsageSpaceId, expectedUsageBlueprintId, creds, usage ?? undefined);
      if (!expectedUsageEstimateRequests.isCurrent(requestId)) return;
      setActivationReview(current => current && current.spaceId === expectedUsageSpaceId && current.blueprintId === expectedUsageBlueprintId
        ? { ...current, preview: { ...current.preview, cost_estimate: preview.cost_estimate } } : current);
    } catch (error) {
      if (expectedUsageEstimateRequests.isCurrent(requestId)) setUsageEstimateError(validationError
        ? `${validationError} The previous projection may be stale until the estimate refreshes.`
        : `Usage estimate was not refreshed: ${error instanceof Error ? error.message : "request failed"}`);
    } finally {
      if (expectedUsageEstimateRequests.isCurrent(requestId)) setUpdatingUsageEstimate(false);
    }
  }, [creds, expectedUsageBlueprintId, expectedUsageEstimateRequests, expectedUsageSpaceId]);

  function updateExpectedUsageEstimate() {
    if (!expectedUsageSpaceId || !expectedUsageBlueprintId) return;
    const input = parseTemplateExpectedUsageInput(expectedConversations, expectedInteractions);
    const requestId = expectedUsageEstimateRequests.issue();
    void fetchExpectedUsageEstimate(input.usage, requestId, input.valid ? null : input.message);
  }

  React.useEffect(() => {
    if (!creds || !expectedUsageSpaceId || !expectedUsageBlueprintId) {
      expectedUsageEstimateRequests.invalidate();
      setUpdatingUsageEstimate(false);
      setUsageEstimateError("");
      return;
    }
    const input = parseTemplateExpectedUsageInput(expectedConversations, expectedInteractions);
    const requestId = expectedUsageEstimateRequests.issue();
    if (!input.valid) setUsageEstimateError(input.message);
    const timer = window.setTimeout(() => {
      void fetchExpectedUsageEstimate(input.usage, requestId, input.valid ? null : input.message);
    }, 350);
    return () => {
      window.clearTimeout(timer);
      if (expectedUsageEstimateRequests.isCurrent(requestId)) expectedUsageEstimateRequests.invalidate();
    };
  }, [creds, expectedConversations, expectedInteractions, expectedUsageBlueprintId, expectedUsageEstimateRequests,
    expectedUsageSpaceId, fetchExpectedUsageEstimate]);

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      const [listed, availableTemplates] = await Promise.allSettled([
        listMySpaces(product.space_id, creds),
        listSpaceTemplates(creds),
      ]);
      if (listed.status === "fulfilled") {
        setSpaces(listed.value);
        setListFailed(false);
      } else {
        setListFailed(true);
      }
      if (availableTemplates.status === "fulfilled") setTemplates(availableTemplates.value);
    } catch {
      setListFailed(true);
    } finally {
      setLoading(false);
    }
  }, [creds, product.space_id]);

  async function handleCreate(event?: React.FormEvent) {
    event?.preventDefault();
    if (!creds || !newSpaceName.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const listing = templateId ? templates.find((item) => item.id === templateId) : undefined;
      if (templateId && !listing) throw new Error("That Space Template is no longer available.");
      const fork = listing ? await forkSpaceTemplate(product.space_id, listing.id, creds) : null;
      const created = await createSpace(product.space_id, creds, {
        name: newSpaceName.trim(),
        ...(listing ? { template_listing_id: listing.id } : {}),
        ...(fork ? { blueprint_id: fork.space_type_id } : {}),
        ...(fork&&assistantEmailMode?{assistant_email_mode:assistantEmailMode}:{}),
      });
      setNewSpaceName("");
      // Production spaces install the blueprint at the end of background provisioning. Local
      // spaces have no queue, so activate it now that the owner membership is committed.
      if (fork && created.status === "active") {
        try {
          const preview = await previewSpaceTemplateActivation(created.id, fork.space_type_id, creds);
          await loadTemplateSetupDraft(created.id, fork.space_type_id, preview, true);
          setDependencyImports({});
          setActivationReview({ spaceId: created.id, blueprintId: fork.space_type_id, preview, applyCoordinationDefault: false, extensionRequirementsReviewed: false });
          setCreatedSpaceId(created.id);
          setCreateError(preview.ready ? null : `Template dependencies need attention: ${preview.blockers.join(", ")}`);
          await refresh();
          return;
        } catch (error) {
          setCreatedSpaceId(created.id);
          setCreateError(`Space created, but the template was not installed: ${error instanceof Error ? error.message : "installation failed"}`);
          await refresh();
          return;
        }
      }
      setCreateOpen(false);
      setTemplateId("");
      setCreatedSpaceId(null);
      await refresh();
      if (created.status === "active") window.location.assign(`/p/${product.slug}/spaces/${created.id}`);
      else show("Space created and provisioning in the background.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create Space.";
      setCreateError(message);
      show(message);
    } finally {
      setCreating(false);
    }
  }

  async function confirmTemplateActivation() {
    if (!creds || !activationReview || !activationReview.preview.ready || activatingTemplate) return;
    const hasExtensionRequirements = activationReview.preview.extension_requirements.knowledge.length > 0 || activationReview.preview.extension_requirements.actions.length > 0;
    if (hasExtensionRequirements && activationReview.extensionRequirementsReviewed !== true) return;
    setActivatingTemplate(true); setCreateError(null);
    try {
      const approvedSharedFilesystem = Object.fromEntries(Object.entries(activationReview.filesystemGrantSelections ?? {}).flatMap(([extensionId, paths]) => {
        const dependency = activationReview.preview.dependencies.find(item => item.extension_id === extensionId);
        const installed = dependency?.status === "installed";
        const defaultValue = installed ? "KEEP" : "NONE";
        if (!Object.values(paths).some(access => access !== defaultValue)) return [];
        const grants = (dependency?.summary?.shared_filesystem ?? []).flatMap(requested => {
          const selected = paths[requested.path] ?? defaultValue;
          if (selected === "NONE") return [];
          if (selected === "KEEP") {
            const current = dependency?.summary?.approved_shared_filesystem?.find(grant => grant.path === requested.path);
            return current ? [current] : [];
          }
          return [{ path: requested.path, access: selected }];
        });
        return [[extensionId, grants]];
      }));
      await activateSpaceTemplate(activationReview.spaceId, activationReview.blueprintId, creds, approvedSharedFilesystem, setupValues,
        activationReview.applyCoordinationDefault === true, hasExtensionRequirements && activationReview.extensionRequirementsReviewed === true);
      setCreateOpen(false);
      window.location.assign(`/p/${product.slug}/spaces/${activationReview.spaceId}?next=settings`);
    } catch (error) { setCreateError(`Template was not activated: ${error instanceof Error ? error.message : "activation failed"}`); }
    finally { setActivatingTemplate(false); }
  }

  async function reviewTemplateDependencyImport(extensionId: string) {
    if (!creds || !activationReview || dependencyImportBusy) return;
    const dependency = activationReview.preview.dependencies.find(item => item.extension_id === extensionId);
    const sourceSpaceId = dependencyImports[extensionId]?.sourceSpaceId;
    if (!dependency?.required_version || dependency.status !== "unavailable") return;
    if (!sourceSpaceId || sourceSpaceId === activationReview.spaceId) {
      patchDependencyImport(extensionId, { notice: "Choose another Space in this tenant as the package source." }); return;
    }
    setDependencyImportBusy(extensionId);
    patchDependencyImport(extensionId, { notice: undefined, importReview: undefined, installReview: undefined });
    try {
      const review = await previewSpaceSharedExtensionImport(activationReview.spaceId, sourceSpaceId, extensionId,
        dependency.required_version, creds, dependency.required_digest);
      const root = review.packages.find(pkg => pkg.extension_id === extensionId);
      if (review.source_space_id !== sourceSpaceId || review.destination_space_id !== activationReview.spaceId
        || review.extension_id !== extensionId || review.version !== dependency.required_version || !root
        || root.version !== dependency.required_version || root.publisher_signature_verified !== true
        || dependency.required_digest !== undefined && root.manifest_sha256 !== dependency.required_digest)
        throw new Error("The source Space does not contain the exact signed release required by this template.");
      patchDependencyImport(extensionId, { importReview: review, importedPackages: undefined,
        notice: "Read-only package review is ready. No package bytes or installation state changed." });
    } catch (error) {
      patchDependencyImport(extensionId, { notice: `Package review failed: ${error instanceof Error ? error.message : "request failed"}` });
    } finally { setDependencyImportBusy(null); }
  }

  async function importTemplateDependency(extensionId: string) {
    if (!creds || !activationReview || dependencyImportBusy) return;
    const progress = dependencyImports[extensionId];
    const review = progress?.importReview;
    if (!review || review.expires_at <= Date.now()) {
      patchDependencyImport(extensionId, { notice: "The package review expired. Review the source package again." }); return;
    }
    setDependencyImportBusy(extensionId);
    patchDependencyImport(extensionId, { notice: undefined });
    try {
      const result = await importSpaceSharedExtension(activationReview.spaceId, review, creds);
      patchDependencyImport(extensionId, { importReview: undefined, installReview: undefined,
        importedPackages: result.completed_packages.map(item => `${item.extension_id}@${item.version}`),
        notice: "The signed package closure is in this Space. Review its requested authority before installation." });
    } catch (error) {
      patchDependencyImport(extensionId, { notice: `Import did not return a completion receipt: ${error instanceof Error ? error.message : "request failed"}. Retry this same review while it is valid, or review the source again; completed package copies are immutable and retryable.` });
    } finally { setDependencyImportBusy(null); }
  }

  async function reviewTemplateDependencyInstall(extensionId: string) {
    if (!creds || !activationReview || dependencyImportBusy) return;
    const dependency = activationReview.preview.dependencies.find(item => item.extension_id === extensionId);
    if (!dependency?.required_version) return;
    setDependencyImportBusy(extensionId);
    patchDependencyImport(extensionId, { notice: undefined, installReview: undefined });
    try {
      const review = await previewSpaceSharedExtensionInstall(activationReview.spaceId, extensionId, creds,
        dependency.required_version, []);
      if (review.space_id !== activationReview.spaceId || review.extension_id !== extensionId
        || review.version !== dependency.required_version || review.requested_package.extension_id !== extensionId
        || review.requested_package.version !== dependency.required_version
        || dependency.required_digest !== undefined && review.requested_package.manifest_sha256 !== dependency.required_digest)
        throw new Error("The destination package does not match the template's exact extension pin.");
      patchDependencyImport(extensionId, { installReview: review, notice: review.ready_to_install
        ? "Installation review is read-only. Review permissions, capabilities and dependencies below; no folder access will be granted by this flow."
        : "The package is imported, but its destination installation review has blockers." });
    } catch (error) {
      patchDependencyImport(extensionId, { notice: `Could not review an exact release in this destination Space: ${error instanceof Error ? error.message : "request failed"}. If no release has been imported here yet, select its same-tenant source Space and review the package closure first.` });
    } finally { setDependencyImportBusy(null); }
  }

  async function installTemplateDependency(extensionId: string) {
    if (!creds || !activationReview || dependencyImportBusy) return;
    const dependency = activationReview.preview.dependencies.find(item => item.extension_id === extensionId);
    const review = dependencyImports[extensionId]?.installReview;
    if (!dependency?.required_version || !review?.ready_to_install || !review.review_token) return;
    if (review.review_expires_at !== undefined && review.review_expires_at <= Date.now()) {
      patchDependencyImport(extensionId, { notice: "The installation review expired. Review the exact package again." }); return;
    }
    setDependencyImportBusy(extensionId);
    patchDependencyImport(extensionId, { notice: undefined });
    let installError: unknown;
    try {
      await installSpaceSharedExtension(activationReview.spaceId, extensionId, creds, [], dependency.required_version, review.review_token);
    } catch (error) { installError = error; }
    try {
      const preview = await previewSpaceTemplateActivation(activationReview.spaceId, activationReview.blueprintId, creds);
      setActivationReview(current => current && current.spaceId === activationReview.spaceId ? { ...current, preview, extensionRequirementsReviewed: false } : current);
      const refreshed = preview.dependencies.find(item => item.extension_id === extensionId);
      const exactPinActive = refreshed?.status === "installed" && refreshed.available_version === dependency.required_version
        && (dependency.required_digest === undefined || refreshed.available_digest === dependency.required_digest);
      if (exactPinActive) {
        patchDependencyImport(extensionId, { installReview: undefined,
          notice: installError ? "The install response was ambiguous, but the refreshed template preview confirms the exact signed pin is active."
            : "The exact signed pin is active in the destination Space. Refresh the preview and continue template activation." });
        setCreateError(preview.ready ? null : `Template dependencies need attention: ${preview.blockers.join(", ")}`);
      } else if (installError) {
        patchDependencyImport(extensionId, { notice: `Installation was not confirmed: ${installError instanceof Error ? installError.message : "request failed"}. Refresh the package review before retrying.` });
      } else {
        patchDependencyImport(extensionId, { notice: "The install request completed, but the refreshed preview does not show the exact required pin as active." });
      }
    } catch (error) {
      patchDependencyImport(extensionId, { notice: `Could not verify the install outcome: ${installError instanceof Error ? installError.message : error instanceof Error ? error.message : "request failed"}. Refresh the template preview before retrying.` });
    } finally { setDependencyImportBusy(null); }
  }

  async function recheckTemplateActivation() {
    if (!creds || !activationReview || refreshingPreview) return;
    setRefreshingPreview(true); setCreateError(null);
    try {
      const usage = expectedConversations && expectedInteractions ? {
        conversations_per_month: Number(expectedConversations), interactions_per_conversation: Number(expectedInteractions),
      } : undefined;
      const preview = await previewSpaceTemplateActivation(activationReview.spaceId, activationReview.blueprintId, creds, usage);
      setSetupValues(current => rebaseSetupValues(current, preview));
      await loadTemplateSetupDraft(activationReview.spaceId, activationReview.blueprintId, preview, false);
      setActivationReview({ ...activationReview, preview, extensionRequirementsReviewed: false });
      setCreateError(preview.ready ? null : `Template dependencies need attention: ${preview.blockers.join(", ")}`);
    } catch (error) { setCreateError(`Could not refresh dependency status: ${error instanceof Error ? error.message : "preview failed"}`); }
    finally { setRefreshingPreview(false); }
  }

  async function reviewPendingTemplate(space: SpaceSummary) {
    if (!creds || !space.pending_blueprint_id || openingPendingTemplate) return;
    setOpeningPendingTemplate(space.id);
    try {
      const preview = await previewSpaceTemplateActivation(space.id, space.pending_blueprint_id, creds);
      await loadTemplateSetupDraft(space.id, space.pending_blueprint_id, preview, true);
      setDependencyImports({});
      setActivationReview({ spaceId: space.id, blueprintId: space.pending_blueprint_id, preview, extensionRequirementsReviewed: false });
      setCreatedSpaceId(space.id);
      setCreateError(preview.ready ? null : `Template dependencies need attention: ${preview.blockers.join(", ")}`);
      setCreateOpen(true);
    } catch (error) {
      show(`Template setup review unavailable: ${error instanceof Error ? error.message : "preview failed"}`);
    } finally {
      setOpeningPendingTemplate(null);
    }
  }

  React.useEffect(() => { void refresh(); }, [refresh]);

  React.useEffect(() => {
    if (!creds || createOpen || activationReview) return;
    const pending = spaces.find(space => space.space_status === "active" && space.pending_blueprint_id
      && (space.role === "owner" || space.role === "admin"));
    if (!pending?.pending_blueprint_id) return;
    const key = `${pending.id}:${pending.pending_blueprint_id}`;
    if (pendingPreviewed.current.has(key)) return;
    pendingPreviewed.current.add(key);
    void previewSpaceTemplateActivation(pending.id, pending.pending_blueprint_id, creds).then(preview => {
      void loadTemplateSetupDraft(pending.id, pending.pending_blueprint_id!, preview, true).then(() => {
        setDependencyImports({});
        setActivationReview({ spaceId: pending.id, blueprintId: pending.pending_blueprint_id!, preview, extensionRequirementsReviewed: false });
        setCreatedSpaceId(pending.id);
        setCreateError(preview.ready ? null : `Template dependencies need attention: ${preview.blockers.join(", ")}`);
        setCreateOpen(true);
      });
    }).catch(error => {
      setCreateError(`Template preview is unavailable: ${error instanceof Error ? error.message : "retry the preview"}`);
      show("A Space Template is waiting for review. Refresh this page to retry its preview.");
    });
  }, [spaces, creds, createOpen, activationReview, show]);

  React.useEffect(() => {
    if (!creds) return;
    const active = spaces.filter((space) => space.space_status === "active");
    if (active.length === 0) { setActivities(null); return; }
    let cancelled = false;
    setActivityLoading(true);
    void Promise.all(active.map(async (space): Promise<SpaceActivity> => {
      try {
        const result = await getSpaceAnalytics(space.id, creds, "30d");
        return { space, runs: result.runs.total, credits: result.credits.used, successRate: result.runs.success_rate, failed: false };
      } catch {
        return { space, runs: 0, credits: 0, successRate: null, failed: true };
      }
    })).then((rows) => {
      if (!cancelled) setActivities(rows.sort((a, b) => b.runs - a.runs));
    }).finally(() => { if (!cancelled) setActivityLoading(false); });
    return () => { cancelled = true; };
  }, [spaces, session]);

  const visibleSpaces = query.trim()
    ? spaces.filter((space) => space.name.toLowerCase().includes(query.trim().toLowerCase()))
    : spaces;
  const totalRuns = activities?.reduce((total, row) => total + row.runs, 0) ?? 0;

  return (
    <div className="page-view">
      <div className="page-header">
        <div>
          <div className="page-title">Spaces</div>
          <div className="page-subtitle">Your Naelao workspaces.</div>
        </div>
        <Button onClick={() => { setCreateError(null); setCreatedSpaceId(null); setActivationReview(null); setCreateOpen(true); }}>New Space</Button>
      </div>

      {!loading && !listFailed && spaces.length > 0 && (
        <div className="grid-3" style={{ marginBottom: 18 }}>
          <div className="card"><div className="card-label">Spaces</div><div className="card-value">{spaces.length}</div></div>
          <div className="card"><div className="card-label">Agent runs (30d)</div><div className="card-value">{activityLoading && activities === null ? "…" : totalRuns.toLocaleString()}</div></div>
        </div>
      )}

      {!loading && !listFailed && spaces.length > 0 && (
        <div className="search-bar" style={{ marginBottom: 16 }}>
          <FormInput placeholder="Search spaces…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
      )}

      <div className="section-label">Your spaces{!loading && !listFailed && spaces.length > 0 ? ` (${visibleSpaces.length}${query.trim() ? ` of ${spaces.length}` : ""})` : ""}</div>
      {loading ? <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
        : listFailed ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
            <span style={{ color: "#dc2626" }} role="alert">Couldn&rsquo;t load your spaces. Your work is still there; this is a loading problem.</span>
            <Button variant="secondary" onClick={() => void refresh()}>Retry</Button>
          </div>
        ) : spaces.length === 0 ? (
          <p style={{ color: "var(--text3)", fontSize: 13 }}>No additional spaces are connected to this account.</p>
        ) : visibleSpaces.length === 0 ? (
          <p style={{ color: "var(--text3)", fontSize: 13 }}>No space matches &ldquo;{query}&rdquo;.</p>
        ) : (
          <div className="grid-3">
            {visibleSpaces.map((space) => {
              const templatePending = Boolean(space.pending_blueprint_id);
              const active = space.space_status === "active";
              return (
                <Link key={space.id} href={`/p/${product.slug}/spaces/${space.id}`} style={{ textDecoration: "none" }}>
                  <Card interactive>
                    <CardTitle>{space.name}</CardTitle>
                    <CardDesc>Your role: {space.role}</CardDesc>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {templatePending && <Badge color="amber">Template review</Badge>}
                      <Badge color={active ? "green" : "amber"}>{active ? "active" : space.space_status}</Badge>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}

      {activities && activities.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 26 }}>Space activity · last 30 days</div>
          <div className="settings-block">
            {activities.map((row, index) => (
              <Link key={row.space.id} href={`/p/${product.slug}/spaces/${row.space.id}`} className="settings-row" style={{ textDecoration: "none", color: "inherit", cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                  <span style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, background: index === 0 ? "var(--accent)" : "var(--surface2)", color: index === 0 ? "#fff" : "var(--text3)" }}>{index + 1}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="settings-row-label" style={{ marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.space.name}</div>
                    <div className="settings-row-sub">{row.runs} runs · {row.credits.toLocaleString()} credits{row.successRate !== null ? ` · ${Math.round(row.successRate * 100)}% success` : ""}{row.failed ? " · partial data" : ""}</div>
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text3)" }}>{row.runs} runs</div><div style={{ fontSize: 10.5, color: "var(--text3)" }}>last 30 days</div></div>
              </Link>
            ))}
          </div>
        </>
      )}

      {visibleSpaces.some(space => space.pending_blueprint_id && (space.role === "owner" || space.role === "admin")) && <div style={{ marginTop: 20 }}>
        <div className="section-label">Template setup to finish</div>
        <div className="settings-block">
          {visibleSpaces.filter(space => space.pending_blueprint_id && (space.role === "owner" || space.role === "admin")).map(space => <div key={`${space.id}:${space.pending_blueprint_id}`} className="settings-row">
            <div style={{ minWidth: 0 }}>
              <div className="settings-row-label">{space.name}</div>
              <div className="settings-row-sub">Space created; template activation is waiting for your review.</div>
            </div>
            <Button variant="secondary" disabled={openingPendingTemplate !== null} onClick={() => void reviewPendingTemplate(space)}>
              {openingPendingTemplate === space.id ? "Loading…" : "Review setup"}
            </Button>
          </div>)}
        </div>
      </div>}

      {visibleSpaces.some(space => space.role === "owner" || space.role === "admin") && <div style={{ marginTop: 20 }}>
        <div className="section-label">Installed Space Templates</div>
        <div className="settings-block">
          {visibleSpaces.filter(space => space.role === "owner" || space.role === "admin").map(space => <div key={`template-status:${space.id}`} className="settings-row">
            <div style={{ minWidth: 0 }}>
              <div className="settings-row-label">{space.name}</div>
              <div className="settings-row-sub">Review the pinned installed artifact and setup record.</div>
            </div>
            <Button variant="secondary" disabled={!creds || templateStatusLoading} onClick={() => void openTemplateStatus(space)}>
              {templateStatusLoading && templateStatusSpace?.id === space.id ? "Loading…" : "Template status"}
            </Button>
          </div>)}
        </div>
      </div>}

      <div className="section-label" style={{ marginTop: 26 }}>Model benchmarks</div>
      <p style={{ fontSize: 12, color: "var(--text3)", margin: "-6px 0 12px" }}>
        Model strengths and costs based on measured Naelao runs where available, otherwise published estimates.
      </p>
      <div className="grid-3">
        {(showAllModels ? listModelBenchmarks() : listModelBenchmarks().slice(0, 6)).map((benchmark) => (
          <Card key={benchmark.id} interactive={false}>
            <CardTitle>{modelLabel(benchmark.id)}{benchmark.id === DEFAULT_WORKING_MODEL && <span style={{ marginLeft: 6, fontSize: 10.5, color: "var(--accent)", fontWeight: 600 }}>DEFAULT</span>}</CardTitle>
            <CardDesc>{benchmark.strengths[0]}</CardDesc>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
              <Badge color={COST_TIER_BADGE[benchmark.costTier]}>{COST_TIER_LABEL[benchmark.costTier]}</Badge>
              {benchmark.costBasis === "estimated" && <Badge color="blue">Estimated cost</Badge>}
              {benchmark.eval && <Badge color={benchmark.eval.usable.startsWith("0") ? "amber" : "green"}>{benchmark.eval.usable} usable · {benchmark.eval.avgScore.toFixed(2)}/10</Badge>}
              {benchmark.neuronsPerRun !== undefined && <Badge color="blue">~{benchmark.neuronsPerRun} neurons/run</Badge>}
            </div>
            {benchmark.axes && Object.keys(benchmark.axes).length > 0 && (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", margin: "2px 0 6px" }}>
                {Object.entries(benchmark.axes).map(([axis, result]) => <span key={axis} title={result.note ?? `${result.passed} of ${result.total} checks passed`} style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, border: "1px solid var(--border)", color: result.passed === result.total ? "var(--text2)" : "var(--text3)", background: result.passed === result.total ? "var(--bg3)" : "transparent" }}>{AXIS_LABEL[axis] ?? axis} {result.passed}/{result.total}</span>)}
              </div>
            )}
            <p style={{ fontSize: 11.5, color: "var(--text3)", margin: "4px 0 0" }}>{benchmark.eval ? benchmark.eval.note : `Best for: ${benchmark.bestFor[0]}`}</p>
          </Card>
        ))}
      </div>
      {!showAllModels && listModelBenchmarks().length > 6 && <Button variant="secondary" onClick={() => setShowAllModels(true)} style={{ marginTop: 10 }}>Show all {listModelBenchmarks().length} models</Button>}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={activationReview ? "Review Space Template" : "Create a Space"} footer={activationReview ? <>
        <Button variant="secondary" onClick={() => { setCreateOpen(false); setActivationReview(null); }}>Later</Button>
        {activationReview.preview.setup_fields.length > 0 && <Button variant="secondary" onClick={() => void saveCurrentTemplateDraft()} disabled={savingSetupDraft}>
          {savingSetupDraft ? "Saving draft…" : setupDraftNeedsReplacement ? "Replace saved draft" : "Save setup for later"}
        </Button>}
        <Button onClick={() => void confirmTemplateActivation()} disabled={!activationReview.preview.ready || activatingTemplate
          || (activationReview.preview.extension_requirements.knowledge.length + activationReview.preview.extension_requirements.actions.length > 0 && activationReview.extensionRequirementsReviewed !== true)}>{activatingTemplate ? "Installing…" : "Approve and install"}</Button>
      </> : createdSpaceId ? <Button onClick={() => window.location.assign(`/p/${product.slug}/spaces/${createdSpaceId}`)}>Open Space</Button> : <><Button variant="secondary" type="button" onClick={() => setCreateOpen(false)}>Cancel</Button><Button onClick={() => void handleCreate()} disabled={creating || !newSpaceName.trim()}>{creating ? "Creating…" : "Create Space"}</Button></>}>
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 12 }}>Name<FormInput autoFocus maxLength={100} placeholder="What is this Space for?" value={newSpaceName} onChange={(event) => setNewSpaceName(event.target.value)} required /></label>
          {templates.some((template) => template.price_cents === 0) && (
            <label style={{ fontSize: 12 }}>Space Template (optional)<FormSelect value={templateId} onChange={(event) => {setTemplateId(event.target.value);setAssistantEmailMode("");}}>
              <option value="">Start with a blank Space</option>
              {templates.filter((template) => template.price_cents === 0).map((template) => <option key={template.id} value={template.id}>{template.name} · by {template.author_name}</option>)}
            </FormSelect></label>
          )}
          {selectedTemplate && <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, fontSize: 11.5 }}>
            <strong>Template prerequisites</strong>
            {selectedTemplate.planGatedFeatures?.length ? <div style={{ marginTop: 5 }}>
              Plan-gated features: {selectedTemplate.planGatedFeatures.join(", ")}. Availability depends on the Space subscription plan; this preview does not verify the current plan’s entitlement.
            </div> : null}
            {selectedTemplate.requirements ? <>
              <div style={{ marginTop: 5 }}>Required extensions: {selectedTemplate.requirements.extensions.length
                ? selectedTemplate.requirements.extensions.map(item => `${item.id}${item.version ? ` v${item.version}` : " (version pin missing)"}`).join(", ") : "none declared"}</div>
              <div>Setup credentials: {selectedTemplate.requirements.credentials.length
                ? selectedTemplate.requirements.credentials.map(item => `${item.name} (${item.required ? "required" : "optional"}) — ${item.description}`).join("; ") : "none declared"}</div>
              <div>Project runtimes: {selectedTemplate.requirements.runtimes.length
                ? selectedTemplate.requirements.runtimes.map(item => `${item.project_id} · ${item.id}${item.required ? " (required)" : " (optional)"}${item.capabilities.length ? ` [${item.capabilities.join(", ")}]` : ""}`).join("; ") : "none declared"}</div>
            </> : <p style={{ margin: "5px 0 0" }}>This marketplace listing does not include prerequisite details.</p>}
            <p style={{ margin: "6px 0 0", color: "var(--text3)" }}>This is the template’s declared setup. Naelao checks availability and asks you to review access before activation.</p>
          </div>}
          <p style={{ margin: 0, fontSize: 12, color: "var(--text3)" }}>You can install additional extensions and configure the Space after it is created.</p>
          {createError && <p role="alert" style={{ margin: 0, fontSize: 12, color: "#dc2626" }}>{createError}</p>}
          {activationReview && <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, fontSize: 12 }}>
            <strong>{activationReview.preview.ready ? "Ready for your approval" : "Cannot install yet"}</strong>
            <p>This preview made no changes and granted no access.</p>
            <strong>Extensions</strong>
            {activationReview.preview.dependencies.length ? <ul>{activationReview.preview.dependencies.map(item => <li key={item.extension_id}>
              <strong>{item.extension_id}: {item.status}</strong>{item.required_version ? ` (requires ${item.required_version}${item.available_version ? `; available ${item.available_version}` : ""})` : item.status === "version_unpinned" ? " (pin an exact release before installing this template)" : ""}{item.required_digest ? ` · SHA-256 ${item.required_digest.slice(0, 12)}${item.available_digest && item.available_digest !== item.required_digest ? ` (available ${item.available_digest.slice(0, 12)})` : ""}` : ""}
              {item.status === "installed" && <p style={{ margin: "5px 0 8px 12px" }}><a href={`/p/${product.slug}/spaces/${encodeURIComponent(activationReview.spaceId)}?next=extensions`} target="_blank" rel="noopener noreferrer">Review this Space’s installed extension settings and dashboards in a new tab</a>. Return here afterward; this template is still awaiting activation.</p>}
              {item.summary && <div style={{ margin: "4px 0 8px 12px", color: "var(--text3)" }}>
                <div>Declared extension surface only; host grants and per-operation checks still control what can run.</div>
                {item.summary.primitives.length > 0 && <div>Components: {item.summary.primitives.map(part => `${part.kind} ${part.id}${part.scope ? ` [${part.scope}]` : ""}${part.provider ? ` [${part.provider}]` : ""}`).join(", ")}</div>}
                {item.summary.primitives.map(part => <div key={`${part.kind}:${part.id}`} style={{ marginLeft: 10 }}>
                  <strong>{part.kind} {part.id}:</strong> {[...(part.tools?.map(tool => `tool ${tool}`) ?? []), ...(part.gadget_reads?.map(grant => `read ${grant.gadget_id}.${grant.tables.join("/")}`) ?? []), ...part.capabilities.map(capability => `capability ${capability}`), ...part.permissions.map(permission => `access ${permission}`), ...(part.inbound_events?.map(event => `in ${event}`) ?? []), ...(part.outbound_events?.map(event => `out ${event}`) ?? [])].join(", ") || "no declared actions"}
                  {part.resources && ` · ${part.resources.cpu_cores} CPU / ${part.resources.memory_mb} MiB / ${part.resources.timeout_seconds}s`}{part.network_policy && ` · network ${part.network_policy}`}
                </div>)}
                {item.summary.capabilities.length > 0 && <div>Capabilities: {item.summary.capabilities.join(", ")}</div>}
                {item.summary.permissions.length > 0 && <div>Requested access: {item.summary.permissions.join(", ")}</div>}
                {item.summary.commands.length > 0 && <div>Commands: {item.summary.commands.join(", ")}</div>}
                {item.summary.background_jobs.length > 0 && <div>Background jobs: {item.summary.background_jobs.map(job => `${job.id}${job.schedule ? ` (${job.schedule})` : ""} · ${job.memory_scope}`).join(", ")}</div>}
                {item.summary.widgets.length > 0 && <div>Chat widgets: {item.summary.widgets.map(widget => `${widget.event} → ${widget.component}`).join(", ")}</div>}
                {item.summary.connections.length > 0 && <div>Connections: {item.summary.connections.map(connection => `${connection.provider}/${connection.id} (${connection.required ? "required" : "optional"}) — ${connection.purpose}`).join("; ")}</div>}
                {item.summary.knowledge.length > 0 && <div>Knowledge: {item.summary.knowledge.map(item => `${item.purpose} (${item.access})`).join("; ")}</div>}
                {item.summary.shared_filesystem.length > 0 && <div>Shared files: {item.summary.shared_filesystem.map(grant => `${grant.path} (${grant.access})`).join(", ")}</div>}
                {item.summary.approved_shared_filesystem && item.summary.approved_shared_filesystem.length > 0 && <div>Currently approved: {item.summary.approved_shared_filesystem.map(grant => `${grant.path} (${grant.access})`).join(", ")}</div>}
                {item.summary.shared_filesystem.length > 0 && <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 6 }}>
                  <div>{item.status === "installed" ? "Review existing shared-file grants. Existing access stays unless you replace it here." : "Optional shared-file access. Nothing is granted unless selected."}</div>
                  {item.summary.shared_filesystem.map(grant => <label key={grant.path} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
                    <span style={{ flex: 1 }}>{grant.path}</span>
                    <select aria-label={`Access for ${item.extension_id} ${grant.path}`} value={activationReview.filesystemGrantSelections?.[item.extension_id]?.[grant.path] ?? (item.status === "installed" ? "KEEP" : "NONE")}
                      onChange={event => setActivationReview(current => current ? { ...current, filesystemGrantSelections: {
                        ...current.filesystemGrantSelections,
                        [item.extension_id]: { ...current.filesystemGrantSelections?.[item.extension_id], [grant.path]: event.target.value as "KEEP" | "NONE" | "READ" | "READ_WRITE" },
                      } } : current)}>
                      {item.status === "installed" && <option value="KEEP">Keep current</option>}
                      <option value="NONE">No access</option>
                      <option value="READ">Read only</option>
                      {grant.access === "READ_WRITE" && <option value="READ_WRITE">Read and write</option>}
                    </select>
                  </label>)}
          {selectedTemplate&&<label style={{fontSize:12}}>Assistant email setup<FormSelect aria-label="Template assistant email setup" value={assistantEmailMode} onChange={event=>setAssistantEmailMode(event.target.value as typeof assistantEmailMode)}>
            <option value="">Use the template default</option><option value="none">No automatic inbox</option><option value="naelao_managed">Naelao managed · quote required</option><option value="user_connected">I’ll connect my AgentMail account</option>
          </FormSelect><small style={{display:"block",color:"var(--text3)"}}>You can choose before installation. A managed inbox is not created or charged during install; an owner must review and confirm its current exact quote afterward. Connecting your own AgentMail inbox has no Naelao inbox rental charge.</small></label>}
                </div>}
                {item.summary.worker_roles.length > 0 && <div>Worker roles: {item.summary.worker_roles.map(role => `${role.id} (${role.execution}/${role.invocation}; ${role.primitive_ids.join(", ") || "no primitives"}${role.gadget_actions.length ? `; ${role.gadget_actions.map(action => `${action.gadget_id} ${action.operations.join("/")} on ${action.tables.join(",")}`).join("; ")}` : ""})`).join("; ")}</div>}
              </div>}
              {item.status === "unavailable" && item.required_version && (() => {
                const progress = dependencyImports[item.extension_id] ?? { sourceSpaceId: "" };
                const sourceSpaces = spaces.filter(space => space.id !== activationReview.spaceId && space.membership_status === "active"
                  && space.space_status === "active" && (space.role === "owner" || space.role === "admin"));
                const importReview = progress.importReview;
                const installReview = progress.installReview;
                const busy = dependencyImportBusy === item.extension_id;
                return <section style={{ margin: "10px 0 4px 12px", padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
                  <strong>Import this exact release from another Space</strong>
                  <p style={{ color: "var(--text3)", margin: "4px 0 8px" }}>Choose an active Space in this tenant where you are an owner or admin. Naelao verifies the signed dependency closure and required pin before any copy. Cross-tenant seller artifacts still need an authorized listing entitlement.</p>
                  <label style={{ display: "grid", gap: 4 }}>Source Space
                    <select aria-label={`Package source Space for ${item.extension_id}`} value={progress.sourceSpaceId}
                      onChange={event => patchDependencyImport(item.extension_id, { sourceSpaceId: event.target.value,
                        importReview: undefined, importedPackages: undefined, installReview: undefined, notice: undefined })}>
                      <option value="">Choose a Space…</option>{sourceSpaces.map(space => <option key={space.id} value={space.id}>{space.name} · {space.id}</option>)}
                    </select>
                  </label>
                  {sourceSpaces.length === 0 && <p role="status">No other active Space where you are an owner or admin is available in this account.</p>}
                  <Button type="button" variant="secondary" disabled={busy || dependencyImportBusy !== null || !progress.sourceSpaceId}
                    onClick={() => void reviewTemplateDependencyImport(item.extension_id)}>{busy ? "Verifying signed release…" : importReview ? "Refresh package review" : `Review ${item.extension_id}@${item.required_version}`}</Button>
                  {importReview && <div style={{ marginTop: 8 }}>
                    <p>Source {importReview.source_space_id} → destination {importReview.destination_space_id} · exact root {importReview.extension_id}@{importReview.version}
                      {item.required_digest ? ` · required manifest SHA-256 ${item.required_digest}` : " · this template pins the exact version but does not record a manifest digest"}</p>
                    <ul>{importReview.packages.map(pkg => <li key={`${pkg.extension_id}@${pkg.version}`}>
                      {pkg.extension_id}@{pkg.version} · publisher {pkg.publisher_id} / key {pkg.publisher_key_id} · manifest {pkg.manifest_sha256} · artifacts {pkg.artifact_sha256} · signature verified
                    </li>)}</ul>
                    <p>This review is read-only. Import copies immutable signed package bytes and release metadata; it does not install packages or grant folder access.</p>
                    <Button type="button" disabled={busy || dependencyImportBusy !== null || importReview.expires_at <= Date.now()}
                      onClick={() => void importTemplateDependency(item.extension_id)}>{busy ? "Importing package closure…" : "Import reviewed package closure"}</Button>
                  </div>}
                  {progress.importedPackages && <p role="status" style={{ marginTop: 8 }}>Imported or verified immutable releases: {progress.importedPackages.join(", ") || "none"}. A partial response can be retried through the same package review.</p>}
                  <Button type="button" variant="secondary" disabled={busy || dependencyImportBusy !== null}
                    onClick={() => void reviewTemplateDependencyInstall(item.extension_id)}>{busy ? "Reviewing destination…" : progress.importedPackages || installReview ? "Refresh destination install review" : "Check for an exact release already imported here"}</Button>
                  {installReview && <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                    <strong>Destination install review · {installReview.requested_package.extension_id}@{installReview.requested_package.version}</strong>
                    {[installReview.requested_package, ...installReview.dependency_packages].map(pkg => <div key={`${pkg.extension_id}@${pkg.version}`} style={{ marginTop: 6 }}>
                      <strong>{pkg.extension_id}@{pkg.version}</strong> · {pkg.publisher_id}/{pkg.publisher_key_id} · manifest {pkg.manifest_sha256} · {pkg.publisher_signature_verified ? "signature verified" : "signature not verified"} · {pkg.installed_state}
                      <div>Permissions: {pkg.permissions.join(", ") || "none"}. Capabilities: {pkg.capabilities.join(", ") || "none"}.</div>
                      <div>Folder access requested: {pkg.shared_filesystem.map(grant => `${grant.path} (${grant.access})`).join(", ") || "none"}; this setup flow grants none.</div>
                      <div>Provider connections: {pkg.connections.map(connection => `${connection.provider}/${connection.id}${connection.required ? " (required)" : " (optional)"}`).join(", ") || "none"}.</div>
                    </div>)}
                    {installReview.unavailable_dependencies.map(dep => <p key={`${dep.extension_id}@${dep.version}`} role="alert">{dep.extension_id}@{dep.version}: {dep.error}</p>)}
                    {!installReview.dependency_resolution.resolved && <p role="alert">Dependency resolution failed: {installReview.dependency_resolution.error}.</p>}
                    <p>Installation is a separate owner action. This flow grants no shared-folder access. After install, refresh the template preview to check every required pin again.</p>
                    {installReview.ready_to_install && installReview.review_token
                      ? <Button type="button" disabled={busy || dependencyImportBusy !== null || installReview.review_expires_at !== undefined && installReview.review_expires_at <= Date.now()}
                        onClick={() => void installTemplateDependency(item.extension_id)}>{busy ? "Installing exact release…" : "Install reviewed exact release"}</Button>
                      : <p role="status">Resolve the install-review blockers before installation.</p>}
                  </div>}
                  {progress.notice && <p role="status" style={{ color: "var(--text3)" }}>{progress.notice}</p>}
                </section>;
              })()}
              {item.status === "version_mismatch" && <p role="alert" style={{ marginLeft: 12 }}>A different version is already installed. This import flow will not replace an installed version; review the supported update path first.</p>}
            </li>)}</ul> : <p>None required</p>}
            <strong>Project runtimes</strong>
            {activationReview.preview.runtime_requirements.length ? <ul>{activationReview.preview.runtime_requirements.map(item => <li key={`${item.project_id}:${item.runtime_id}`}>{item.project_id} · {item.runtime_id}: {item.status === "installable" ? "will install after approval" : item.status} ({item.reason}){item.required ? item.status === "installable" ? " · required" : " · required; install is blocked" : " · optional; omitted from this install"}{item.project_slots_required !== undefined && item.project_slots_limit !== undefined ? ` · ${item.project_slots_required} of ${item.project_slots_limit} project container slots planned` : ""}{item.resources ? ` · ${item.resources.cpu_cores} CPU cores / ${item.resources.memory_mb} MiB combined declared resources` : ""}</li>)}</ul> : <p>None declared</p>}
            <strong>Connections to set up</strong>
            {activationReview.preview.setup_credentials.length ? <ul>{activationReview.preview.setup_credentials.map(item => <li key={item.name}>{item.name}{item.required ? " (required)" : " (optional)"}: {item.description}</li>)}</ul> : <p>None required</p>}
            {activationReview.preview.setup_fields.length > 0 && <section style={{ borderTop: "1px solid var(--border)", marginTop: 10, paddingTop: 10 }}>
              <strong>Template setup · schema v{activationReview.preview.setup_schema_version}</strong>
              <p style={{ color: "var(--text3)" }}>These values are saved with this Space Template installation. Do not enter passwords, API keys, tokens, or provider credentials here; use the host connection setup instead.</p>
              {setupDraftStatus && <p role="status" style={{ color: setupDraftNeedsReplacement ? "#b45309" : "var(--text3)" }}>{setupDraftStatus}</p>}
              {activationReview.preview.setup_fields.map(group => <fieldset key={group.project_id} style={{ border: 0, padding: 0, margin: "10px 0" }}>
                <legend style={{ fontWeight: 600 }}>{group.project_name}</legend>
                {group.fields.filter(field => isBlueprintSetupFieldVisible(group.fields, field, setupValues[group.project_id] ?? {})).map(field => <TemplateSetupInput key={`${group.project_id}:${field.id}`} projectId={group.project_id} field={field}
                  value={setupValues[group.project_id]?.[field.id]} onChange={value => setSetupValues(current => {
                    const projectValues = { ...current[group.project_id] };
                    if (value === undefined) delete projectValues[field.id]; else projectValues[field.id] = value;
                    for (const candidate of group.fields) if (!isBlueprintSetupFieldVisible(group.fields, candidate, projectValues)) delete projectValues[candidate.id];
                    const next = { ...current };
                    if (Object.keys(projectValues).length) next[group.project_id] = projectValues; else delete next[group.project_id];
                    return next;
                  })} />)}
              </fieldset>)}
            </section>}
            {activationReview.preview.coordination_defaults && activationReview.preview.coordination_policy_current && <section style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, margin: "8px 0" }}>
              <strong>Space coordination default</strong>
              <p style={{ margin: "4px 0", color: "var(--text3)" }}>
                This signed template suggests {activationReview.preview.coordination_defaults.memberFactsEnabled ? "allowing owners and admins to publish explicitly approved coordination facts to Space members" : "keeping new member-visible coordination facts disabled"}. These facts are advisory summaries; this setting never grants access to project files or services. Existing approved facts keep their individual visibility.
              </p>
              {activationReview.preview.coordination_policy_current.revision > 0
                ? <p role="status">This Space already has owner-configured coordination policy revision {activationReview.preview.coordination_policy_current.revision} ({activationReview.preview.coordination_policy_current.member_facts_enabled ? "member publication enabled" : "member publication disabled"}). The template will preserve it.</p>
                : !activationReview.preview.coordination_defaults.memberFactsEnabled && activationReview.preview.coordination_policy_current.active_member_facts > 0
                  ? <p role="status">Member publication is already disabled. {activationReview.preview.coordination_policy_current.active_member_facts} previously approved member facts remain visible; review and unpublish them individually before changing policy.</p>
                  : <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <input type="checkbox" checked={activationReview.applyCoordinationDefault === true}
                      onChange={event => setActivationReview(current => current ? { ...current, applyCoordinationDefault: event.target.checked } : current)} />
                    <span>Apply this suggested default to new member-visible coordination facts now. This requires explicit owner/admin approval and can be changed later in Space Settings.</span>
                  </label>}
            </section>}
            <strong>Assistant channel availability defaults</strong>
            {activationReview.preview.assistant_channel_defaults
              && (activationReview.preview.assistant_channel_defaults.spaceAssistant || activationReview.preview.assistant_channel_defaults.projectAssistants)
              ? <ul>{(["spaceAssistant", "projectAssistants"] as const).map(scope => {
                const defaults = activationReview.preview.assistant_channel_defaults?.[scope];
                if (!defaults) return null;
                const settings = [
                  ...Object.entries(defaults.enabled ?? {}).map(([channel, available]) => `${channel}: ${available ? "available by default" : "unavailable by default"}`),
                  ...(defaults.phonePrompt ? [`phone setup prompt: ${defaults.phonePrompt}`] : []),
                ];
                return settings.length ? <li key={scope}>{scope === "spaceAssistant" ? "Space Assistant" : "Project Assistants"}: {settings.join("; ")}</li> : null;
              })}</ul>
              : <p>No template channel defaults; platform defaults apply.</p>}
            <p>These preferences do not connect provider accounts, provision phone numbers or email addresses, or authorize spending. You can review connections and change channel preferences after installation.</p>
            <strong>Extension provider connections</strong>
            {activationReview.preview.extension_connections.length ? <ul>{activationReview.preview.extension_connections.map(connection => <li key={`${connection.extension_id}:${connection.connection_id}`}>
              {connection.extension_id} · {connection.provider}/{connection.connection_id}: {connection.required ? "required" : "optional"} · {connection.required ? "Space-wide provider connection is not supported yet" : "optional provider connection is also unsupported for Space-wide extensions"} — {connection.purpose}
            </li>)}</ul> : <p>None declared</p>}
            {(activationReview.preview.extension_requirements.knowledge.length > 0 || activationReview.preview.extension_requirements.actions.length > 0) && <section style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, margin: "8px 0" }}>
              <strong>Signed package knowledge and action requirements</strong>
              <p style={{ margin: "4px 0", color: "var(--text3)" }}>These references are checked against the exact trusted package declarations. They do not create collection grants, provider connections, or additional permissions. Space Template to Project Knowledge selection is not available yet; external channel search continues to require the package's existing owner-published collection policy.</p>
              {activationReview.preview.extension_requirements.knowledge.length > 0 && <><strong>Knowledge</strong><ul>{activationReview.preview.extension_requirements.knowledge.map(item => <li key={`${item.extension_id}:${item.knowledge_id}`}>
                {item.extension_id} · {item.knowledge_id} · {item.access} · {item.status}{item.required ? " · required" : " · optional"} — {item.purpose}{item.package_purpose ? ` (package: ${item.package_purpose})` : ""}
              </li>)}</ul></>}
              {activationReview.preview.extension_requirements.actions.length > 0 && <><strong>Actions</strong><ul>{activationReview.preview.extension_requirements.actions.map(item => <li key={`${item.extension_id}:${item.primitive_id}:${item.scope}:${item.resource}:${item.action}`}>
                {item.extension_id} · {item.primitive_id} · {item.scope}:{item.resource}:{item.action} · {item.status}{item.required ? " · required" : " · optional"} — {item.purpose}
              </li>)}</ul></>}
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input type="checkbox" checked={activationReview.extensionRequirementsReviewed === true}
                  onChange={event => setActivationReview(current => current ? { ...current, extensionRequirementsReviewed: event.target.checked } : current)} />
                <span>I reviewed these exact signed package requirements. This confirmation records template setup review and does not grant permissions or knowledge access.</span>
              </label>
            </section>}
            <strong>Template evaluation</strong>
            <p>{activationReview.preview.evaluation.passed}/{activationReview.preview.evaluation.total} checks passed · {activationReview.preview.evaluation.evidence} · issued {new Date(activationReview.preview.evaluation.issued_at).toLocaleDateString()}</p>
            <strong>Cost review · {activationReview.preview.cost_estimate.status === "partial" ? "partial" : "unavailable"}</strong>
            {activationReview.preview.cost_estimate.known_one_time_costs.length > 0 ? <ul>{activationReview.preview.cost_estimate.known_one_time_costs.map((cost, index) => <li key={`${cost.component}:${index}`}>
              Template license: {new Intl.NumberFormat(undefined, { style: "currency", currency: activationReview.preview.cost_estimate.currency }).format(cost.amount_cents / 100)}
              {cost.already_paid && cost.paid_at ? ` · recorded as paid ${new Date(cost.paid_at).toLocaleDateString()}` : cost.basis === "current_zero_price_listing" ? ` · current listing price as of ${new Date(activationReview.preview.cost_estimate.as_of).toLocaleDateString()}` : ""}
            </li>)}</ul> : <p>{activationReview.preview.cost_estimate.reason === "selected_listing_not_recorded" ? "This older Space has no saved Marketplace listing ID, so its template license price cannot be matched." : "No exact template license price is available for this installation."}</p>}
            <section style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, margin: "8px 0" }}>
              <strong>Expected monthly usage</strong>
              <p style={{ margin: "4px 0", color: "var(--text3)" }}>Enter planning assumptions. The projection refreshes automatically after you change them. Interactions are not billable units; one interaction can use multiple model or provider operations.</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }}>
                <label>Customer conversations per month<input aria-label="Expected conversations per month" type="number" min={1} max={1_000_000} step={1} value={expectedConversations} onChange={event => setExpectedConversations(event.target.value)} /></label>
                <label>Interactions per conversation<input aria-label="Expected interactions per conversation" type="number" min={1} max={500} step={1} value={expectedInteractions} onChange={event => setExpectedInteractions(event.target.value)} /></label>
              </div>
              <Button variant="secondary" onClick={() => void updateExpectedUsageEstimate()} disabled={updatingUsageEstimate}>{updatingUsageEstimate ? "Updating…" : "Refresh estimate"}</Button>
              {usageEstimateError && <p role="alert">{usageEstimateError}</p>}
              {activationReview.preview.cost_estimate.expected_monthly_usage && <p role="status">Customer-entered projection: {activationReview.preview.cost_estimate.expected_monthly_usage.conversations.toLocaleString()} conversations × {activationReview.preview.cost_estimate.expected_monthly_usage.interactions_per_conversation} interactions = {activationReview.preview.cost_estimate.expected_monthly_usage.projected_interactions.toLocaleString()} interactions/month. Estimated cost remains unknown.</p>}
            </section>
            <p>A total operating-cost estimate is not available. These costs are not estimated: {activationReview.preview.cost_estimate.not_estimated.join("; ")}.</p>
            <p>Any listed license amount is an already recorded payment or the current zero-price listing base; it is not a quote for future provider usage. Optional managed services still require their own current quote and owner confirmation.</p>
            {!activationReview.preview.ready && <><p role="alert">{activationReview.preview.blockers.join(", ")}</p><Button variant="secondary" disabled={refreshingPreview} onClick={() => void recheckTemplateActivation()}>{refreshingPreview ? "Checking…" : "Recheck dependencies"}</Button></>}
          </div>}
        </form>
      </Modal>
      <Modal open={templateStatusSpace !== null} onClose={() => setTemplateStatusSpace(null)} title={`Template status · ${templateStatusSpace?.name ?? "Space"}`} width={760}
        footer={<Button variant="secondary" onClick={() => setTemplateStatusSpace(null)}>Close</Button>}>
        {templateStatusLoading ? <p role="status">Loading installation records…</p> : templateStatusRecords.length === 0
          ? <p>No Space Template installation records are available for this Space.</p>
          : <div style={{ display: "grid", gap: 12 }}>
            {templateStatusRecords.map(record => <section key={`${record.blueprint_id}:${record.created_at}`} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <strong>{record.blueprint_id}</strong>
                <Badge color={record.status === "installed" ? "green" : record.status === "failed" ? "amber" : "blue"}>{record.status}</Badge>
              </div>
              <dl style={{ display: "grid", gridTemplateColumns: "minmax(130px,auto) minmax(0,1fr)", gap: "4px 12px", fontSize: 12, overflowWrap: "anywhere" }}>
                <dt>Artifact SHA-256</dt><dd style={{ margin: 0, fontFamily: "monospace" }}>{record.artifact_sha256}</dd>
                <dt>Marketplace listing</dt><dd style={{ margin: 0 }}>{record.listing_id ?? "Unknown for this legacy installation"}</dd>
                <dt>Setup schema / revision</dt><dd style={{ margin: 0 }}>{record.setup_schema_version ?? "Not recorded"} / {record.setup_revision}</dd>
                {record.extension_requirements_review && <><dt>Knowledge/action review</dt><dd style={{ margin: 0 }}>Reviewed by {record.extension_requirements_review.reviewed_by} on {new Date(record.extension_requirements_review.reviewed_at).toLocaleString()} · requirements SHA-256 {record.extension_requirements_review.requirements_sha256}</dd></>}
                <dt>Latest source check</dt><dd style={{ margin: 0 }}>
                  {record.source_update?.status === "current" ? "Installed source is current" :
                    record.source_update?.status === "update_available" ? "A newer signed listing is available for review" :
                      record.source_update?.status === "unknown_legacy" ? "Unknown for this legacy installation" : "Current source could not be verified"}
                  {record.source_update?.checked_at ? ` · checked ${new Date(record.source_update.checked_at).toLocaleString()}` : ""}
                </dd>
                {record.source_update?.status === "update_available" && <>
                  <dt>New source listing</dt><dd style={{ margin: 0 }}>{record.source_update.source_listing_id ?? "Unavailable"}</dd>
                  {record.source_update.source_artifact_sha256 && <><dt>New source SHA-256</dt><dd style={{ margin: 0, fontFamily: "monospace" }}>{record.source_update.source_artifact_sha256}</dd></>}
                  {record.source_update.terms_changed && <><dt>Listing terms</dt><dd style={{ margin: 0 }}>Price or license terms changed; review before any update.</dd></>}
                  {record.source_update.setup_schema_changed && <><dt>Setup fields</dt><dd style={{ margin: 0 }}>Setup schema changed; a reviewed migration is required.</dd></>}
                  {record.source_update.added_required_extensions.length > 0 && <><dt>New dependencies</dt><dd style={{ margin: 0 }}>{record.source_update.added_required_extensions.join(", ")}</dd></>}
                  {record.source_update.removed_required_extensions.length > 0 && <><dt>Removed dependencies</dt><dd style={{ margin: 0 }}>{record.source_update.removed_required_extensions.join(", ")}</dd></>}
                  {record.source_update.changed_required_extension_versions.length > 0 && <><dt>Dependency versions</dt><dd style={{ margin: 0 }}>{record.source_update.changed_required_extension_versions.map(change => `${change.extension_id}: ${change.installed_version ?? "unpinned"} → ${change.source_version ?? "unpinned"}`).join("; ")}</dd></>}
                  {record.source_update.setup_migration_available && <><dt>Setup migration</dt><dd style={{ margin: 0 }}>A signed migration matches this exact installed artifact and setup schema. It changes setup values only; price, permissions, dependencies, project code and provider resources are unchanged.</dd></>}
                </>}
                {record.source_update?.setup_migration_available && templateStatusSpace && (() => {
                  const key = templateUpdateKey(templateStatusSpace.id, record.blueprint_id);
                  const preview = templateSetupUpdatePreviews[key];
                  const values = templateSetupUpdateValues[key] ?? preview?.values ?? {};
                  const missing = preview?.setup_schema_groups.flatMap(group => group.fields.flatMap(field =>
                    field.required && isBlueprintSetupFieldVisible(group.fields, field, values[group.project_id] ?? {})
                      && values[group.project_id]?.[field.id] === undefined ? [field.id] : [])) ?? [];
                  return <div style={{ marginTop: 10, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
                    {!preview ? <Button variant="secondary" onClick={() => void previewTemplateSetupUpdate(record)} disabled={templateSetupUpdateBusy === key}>
                      {templateSetupUpdateBusy === key ? "Checking migration…" : "Review setup migration"}
                    </Button> : <>
                      <strong>Review setup fields · {preview.installed_listing_id} → {preview.source_listing_id}</strong>
                      <p style={{ margin: "4px 0 8px", color: "var(--text3)" }}>The preview is read-only. Existing values are retained or moved by the signed migration. Fill any new required fields, then choose Apply to update this installation's setup schema and provenance. No project code or provider resources change, and automatic rollback is not available.</p>
                      <strong>Signed migration actions</strong>
                      {preview.setup_migration_operations.length ? <ul>{preview.setup_migration_operations.map((operation, index) => <li key={`${operation.kind}:${index}`}>
                        {operation.kind === "rename" ? `Move ${operation.fromProjectId}.${operation.fromFieldId} to ${operation.toProjectId}.${operation.toFieldId}` :
                          operation.kind === "drop" ? `Discard saved value ${operation.projectId}.${operation.fieldId}` : `Set a default for ${operation.projectId}.${operation.fieldId}`}
                      </li>)}</ul> : <p>Fields with matching project and field IDs retain their saved values. No explicit field migration actions.</p>}
                      {preview.setup_schema_groups.map(group => <fieldset key={group.project_id} style={{ border: 0, padding: 0, margin: "10px 0" }}>
                        <legend style={{ fontWeight: 600 }}>{group.project_name}</legend>
                        {group.fields.filter(field => isBlueprintSetupFieldVisible(group.fields, field, values[group.project_id] ?? {})).map(field => <TemplateSetupInput
                          key={`${group.project_id}:${field.id}`} projectId={group.project_id} field={field} value={values[group.project_id]?.[field.id]}
                          onChange={value => {
                            setTemplateSetupUpdateValues(current => {
                              const next = { ...current }, projectValues = { ...(next[key]?.[group.project_id] ?? preview.values[group.project_id] ?? {}) };
                              if (value === undefined) delete projectValues[field.id]; else projectValues[field.id] = value;
                              for (const candidate of group.fields) if (!isBlueprintSetupFieldVisible(group.fields, candidate, projectValues)) delete projectValues[candidate.id];
                              next[key] = { ...(next[key] ?? preview.values), [group.project_id]: projectValues };
                              return next;
                            });
                            setTemplateSetupUpdateClearedFields(current => {
                              const existing = current[key] ?? [];
                              const has = existing.some(item => item.project_id === group.project_id && item.field_id === field.id);
                              const nextFields = value === undefined
                                ? has ? existing : [...existing, { project_id: group.project_id, field_id: field.id }]
                                : existing.filter(item => item.project_id !== group.project_id || item.field_id !== field.id);
                              return { ...current, [key]: nextFields };
                            });
                          }} />)}
                      </fieldset>)}
                      {missing.length > 0 && <p role="alert">Required setup fields need values: {missing.join(", ")}</p>}
                      {preview.setup_migration_operations.some(operation => operation.kind === "drop") && <label style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "8px 0" }}>
                        <input type="checkbox" checked={templateSetupUpdateDataLossConfirmed[key] === true} onChange={event => setTemplateSetupUpdateDataLossConfirmed(current => ({ ...current, [key]: event.target.checked }))} />
                        <span>I reviewed the signed migration and approve removing the listed saved values. This setup-only update has no automatic rollback.</span>
                      </label>}
                      <Button onClick={() => void confirmTemplateSetupUpdate(record)} disabled={templateSetupUpdateBusy === key || missing.length > 0
                        || (preview.setup_migration_operations.some(operation => operation.kind === "drop") && templateSetupUpdateDataLossConfirmed[key] !== true)}>
                        {templateSetupUpdateBusy === key ? "Applying…" : "Apply setup update"}
                      </Button>
                      <Button variant="secondary" onClick={() => {
                        setTemplateSetupUpdatePreviews(current => { const next = { ...current }; delete next[key]; return next; });
                        setTemplateSetupUpdateValues(current => { const next = { ...current }; delete next[key]; return next; });
                        setTemplateSetupUpdateClearedFields(current => { const next = { ...current }; delete next[key]; return next; });
                        setTemplateSetupUpdateDataLossConfirmed(current => { const next = { ...current }; delete next[key]; return next; });
                      }}>Close review</Button>
                    </>}
                  </div>;
                })()}
                <dt>Required extensions</dt><dd style={{ margin: 0 }}>{record.required_extension_ids.length ? record.required_extension_ids.join(", ") : "None recorded"}</dd>
                <dt>Generated projects</dt><dd style={{ margin: 0 }}>{record.project_ids.length ? record.project_ids.join(", ") : "None recorded"}</dd>
                <dt>Created</dt><dd style={{ margin: 0 }}>{new Date(record.created_at).toLocaleString()}</dd>
                <dt>Updated</dt><dd style={{ margin: 0 }}>{new Date(record.updated_at).toLocaleString()}</dd>
                {record.error_code && <><dt>Failure code</dt><dd style={{ margin: 0 }}>{record.error_code}</dd></>}
              </dl>
            </section>)}
            <p style={{ color: "var(--text3)", fontSize: 12, margin: 0 }}>Each view checks the newest published, signed listing for this publisher and blueprint. A newer listing needs a separate review of its license, price, permissions and setup migration. This read-only check does not update or uninstall the installation.</p>
          </div>}
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}
