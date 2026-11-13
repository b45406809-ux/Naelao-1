"use client";

import * as React from "react";
import Link from "next/link";
import { Button, Badge, Card, CardTitle, CardDesc, FormInput, FormSelect, Modal, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { listMySpaces, createSpace, getSpaceAnalytics, listSpaceTemplates, forkSpaceTemplate, activateSpaceTemplate, previewSpaceTemplateActivation, getSpaceTemplateSetupDraft, saveSpaceTemplateSetupDraft, listSpaceTemplateInstallations, type SpaceTemplateInstallationRecord, type SpaceTemplateActivationPreview, type SpaceTemplateExpectedUsageV1, type SpaceTemplateSetupValue, type SpaceTemplateSetupValues, type SpaceSummary, type SpaceTemplateListing } from "@/lib/api";
import { listModelBenchmarks, DEFAULT_WORKING_MODEL, type CostTier } from "@naelao/billing-core";
import { isBlueprintSetupFieldVisible, resolveBlueprintSetupFieldHelpText, resolveBlueprintSetupFieldLabel, resolveBlueprintSetupOptionLabel, type BlueprintSetupField } from "@naelao/agent-sdk";
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
  const locale = typeof navigator === "undefined" ? "en" : navigator.language;
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
  const [activationReview, setActivationReview] = React.useState<{ spaceId: string; blueprintId: string; preview: SpaceTemplateActivationPreview; filesystemGrantSelections?: Record<string, Record<string, "KEEP" | "NONE" | "READ" | "READ_WRITE">> } | null>(null);
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
  const pendingPreviewed = React.useRef(new Set<string>());
  const creds = React.useMemo(() => session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null, [session]);
  const selectedTemplate = templates.find(template => template.id === templateId);

  async function openTemplateStatus(space: SpaceSummary) {
    if (!creds) return;
    setTemplateStatusSpace(space);
    setTemplateStatusRecords([]);
    setTemplateStatusLoading(true);
    try {
      const result = await listSpaceTemplateInstallations(space.id, creds);
      setTemplateStatusRecords(result.installations);
    } catch (error) {
      show(`Template status unavailable: ${error instanceof Error ? error.message : "request failed"}`);
      setTemplateStatusSpace(null);
    } finally { setTemplateStatusLoading(false); }
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

  async function updateExpectedUsageEstimate() {
    if (!creds || !activationReview || updatingUsageEstimate) return;
    const usage: SpaceTemplateExpectedUsageV1 = {
      conversations_per_month: Number(expectedConversations),
      interactions_per_conversation: Number(expectedInteractions),
    };
    if (!Number.isSafeInteger(usage.conversations_per_month) || usage.conversations_per_month < 1 || usage.conversations_per_month > 1_000_000
      || !Number.isSafeInteger(usage.interactions_per_conversation) || usage.interactions_per_conversation < 1 || usage.interactions_per_conversation > 500) {
      setUsageEstimateError("Enter 1–1,000,000 conversations per month and 1–500 interactions per conversation.");
      return;
    }
    setUpdatingUsageEstimate(true); setUsageEstimateError("");
    try {
      const preview = await previewSpaceTemplateActivation(activationReview.spaceId, activationReview.blueprintId, creds, usage);
      setActivationReview(current => current ? { ...current, preview } : current);
    } catch (error) { setUsageEstimateError(`Usage estimate was not refreshed: ${error instanceof Error ? error.message : "request failed"}`); }
    finally { setUpdatingUsageEstimate(false); }
  }

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
          setActivationReview({ spaceId: created.id, blueprintId: fork.space_type_id, preview });
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
      await activateSpaceTemplate(activationReview.spaceId, activationReview.blueprintId, creds, approvedSharedFilesystem, setupValues);
      setCreateOpen(false);
      window.location.assign(`/p/${product.slug}/spaces/${activationReview.spaceId}`);
    } catch (error) { setCreateError(`Template was not activated: ${error instanceof Error ? error.message : "activation failed"}`); }
    finally { setActivatingTemplate(false); }
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
      setActivationReview({ ...activationReview, preview });
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
      setActivationReview({ spaceId: space.id, blueprintId: space.pending_blueprint_id, preview });
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
        setActivationReview({ spaceId: pending.id, blueprintId: pending.pending_blueprint_id!, preview });
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
        <Button onClick={() => void confirmTemplateActivation()} disabled={!activationReview.preview.ready || activatingTemplate}>{activatingTemplate ? "Installing…" : "Approve and install"}</Button>
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
            <strong>Extension provider connections</strong>
            {activationReview.preview.extension_connections.length ? <ul>{activationReview.preview.extension_connections.map(connection => <li key={`${connection.extension_id}:${connection.connection_id}`}>
              {connection.extension_id} · {connection.provider}/{connection.connection_id}: {connection.required ? "required" : "optional"} · {connection.required ? "Space-wide provider connection is not supported yet" : "optional provider connection is also unsupported for Space-wide extensions"} — {connection.purpose}
            </li>)}</ul> : <p>None declared</p>}
            <strong>Template evaluation</strong>
            <p>{activationReview.preview.evaluation.passed}/{activationReview.preview.evaluation.total} checks passed · {activationReview.preview.evaluation.evidence} · issued {new Date(activationReview.preview.evaluation.issued_at).toLocaleDateString()}</p>
            <strong>Cost review · {activationReview.preview.cost_estimate.status === "partial" ? "partial" : "unavailable"}</strong>
            {activationReview.preview.cost_estimate.known_one_time_costs.length > 0 ? <ul>{activationReview.preview.cost_estimate.known_one_time_costs.map((cost, index) => <li key={`${cost.component}:${index}`}>
              Template license: {new Intl.NumberFormat(undefined, { style: "currency", currency: activationReview.preview.cost_estimate.currency }).format(cost.amount_cents / 100)}
              {cost.already_paid && cost.paid_at ? ` · recorded as paid ${new Date(cost.paid_at).toLocaleDateString()}` : cost.basis === "current_zero_price_listing" ? ` · current listing price as of ${new Date(activationReview.preview.cost_estimate.as_of).toLocaleDateString()}` : ""}
            </li>)}</ul> : <p>{activationReview.preview.cost_estimate.reason === "selected_listing_not_recorded" ? "This older Space has no saved Marketplace listing ID, so its template license price cannot be matched." : "No exact template license price is available for this installation."}</p>}
            <section style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, margin: "8px 0" }}>
              <strong>Expected monthly usage</strong>
              <p style={{ margin: "4px 0", color: "var(--text3)" }}>Enter your planning assumptions. Interactions are not billable units; one interaction can use multiple model or provider operations.</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }}>
                <label>Customer conversations per month<input aria-label="Expected conversations per month" type="number" min={1} max={1_000_000} step={1} value={expectedConversations} onChange={event => setExpectedConversations(event.target.value)} /></label>
                <label>Interactions per conversation<input aria-label="Expected interactions per conversation" type="number" min={1} max={500} step={1} value={expectedInteractions} onChange={event => setExpectedInteractions(event.target.value)} /></label>
              </div>
              <Button variant="secondary" onClick={() => void updateExpectedUsageEstimate()} disabled={updatingUsageEstimate}>{updatingUsageEstimate ? "Updating…" : "Update usage estimate"}</Button>
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
                </>}
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
