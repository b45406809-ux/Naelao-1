"use client";

import * as React from "react";
import { Button } from "@naelao/ui";
import type { BlueprintSetupField, ExtensionSettingsSchema } from "@naelao/agent-sdk";
import { callProjectExtensionSettings, callSpaceSharedExtensionApi, type ExtensionSettingsAuditResponse, type SessionCredentials } from "@/lib/api";
import { localizedExtensionFieldHelp, localizedExtensionFieldLabel, localizedExtensionOptionLabel } from "@/lib/extension-settings-locale";

type Value = string | number | boolean;
type DraftSnapshot = { settings: Record<string, Value> | null; revision: number; base_active_revision: number; status: string; migration_required?: boolean };
type Snapshot = { schema: ExtensionSettingsSchema; settings: Record<string, Value>; revision: number; can_configure?: boolean; migration_required?: boolean;
  activation_policy?: "owner_publish"; active_revision?: number; draft?: DraftSnapshot | null; draft_revision?: number };

export function ExtensionSettingsForm({ spaceId, appId, schema, session, canConfigure, projectScope, loadAudit }: {
  spaceId: string; appId: string; schema: ExtensionSettingsSchema; session: SessionCredentials; canConfigure: boolean;
  projectScope?: { projectId: string; installationId: string };
  loadAudit?: () => Promise<ExtensionSettingsAuditResponse>;
}) {
  const [values, setValues] = React.useState<Record<string, Value>>({});
  const [activeValues, setActiveValues] = React.useState<Record<string, Value>>({});
  const [persistedDraftValues, setPersistedDraftValues] = React.useState<Record<string, Value> | null>(null);
  const [revision, setRevision] = React.useState(0);
  const [draftRevision, setDraftRevision] = React.useState(0);
  const [draftStatus, setDraftStatus] = React.useState<string | null>(null);
  const [draftBaseActiveRevision, setDraftBaseActiveRevision] = React.useState(0);
  const [ownerPublish, setOwnerPublish] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [serverCanConfigure, setServerCanConfigure] = React.useState<boolean | null>(null);
  const [migrationRequired, setMigrationRequired] = React.useState(false);
  const [locale, setLocale] = React.useState("en");
  const [auditEvents, setAuditEvents] = React.useState<ExtensionSettingsAuditResponse["events"] | null>(null);
  const [auditLoading, setAuditLoading] = React.useState(false);
  const [auditError, setAuditError] = React.useState<string | null>(null);
  const mayConfigure = canConfigure && serverCanConfigure !== false;
  const ownerDraftHasUnsavedEdits = ownerPublish && draftStatus === "draft"
    && JSON.stringify(values) !== JSON.stringify(persistedDraftValues ?? {});
  const request = React.useCallback((method: "GET" | "PATCH", body?: unknown) => projectScope
    ? callProjectExtensionSettings(spaceId, projectScope.projectId, projectScope.installationId, session, { method, ...(body === undefined ? {} : { body }) })
    : callSpaceSharedExtensionApi(spaceId, appId, session, { method, path: "/api/settings", ...(body === undefined ? {} : { body }) }),
  [spaceId, appId, session, projectScope?.projectId, projectScope?.installationId]);
  const load = React.useCallback(async () => {
    setLoading(true); setError(null); setNotice(null);
    try {
      const snapshot = await request("GET") as Snapshot;
      const active = snapshot.settings ?? {};
      const draft = snapshot.activation_policy === "owner_publish" ? snapshot.draft : null;
      setActiveValues(active);
      setValues(draft?.status === "draft" && draft.settings ? draft.settings : active);
      setPersistedDraftValues(draft?.status === "draft" ? draft.settings : null);
      setRevision(snapshot.revision);
      setOwnerPublish(snapshot.activation_policy === "owner_publish");
      setDraftRevision(snapshot.draft_revision ?? draft?.revision ?? 0);
      setDraftStatus(draft?.status ?? null);
      setDraftBaseActiveRevision(draft?.base_active_revision ?? snapshot.revision);
      setServerCanConfigure(typeof snapshot.can_configure === "boolean" ? snapshot.can_configure : null);
      setMigrationRequired(snapshot.migration_required === true || draft?.migration_required === true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load extension settings."); }
    finally { setLoading(false); }
  }, [request]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { if (typeof navigator !== "undefined") setLocale(navigator.language || "en"); }, []);
  const change = (field: BlueprintSetupField, value: Value | undefined) => setValues(current => {
    const next = { ...current };
    if (value === undefined) delete next[field.id]; else next[field.id] = value;
    return next;
  });
  async function save() {
    setSaving(true); setError(null); setNotice(null);
    try {
      const snapshot = await request("PATCH", ownerPublish
        ? { action: "save_draft", settings: values, draft_revision: draftRevision, base_active_revision: revision }
        : { settings: values, revision }) as Snapshot;
      if (ownerPublish) {
        const draft = snapshot.draft;
        setValues(draft?.settings ?? snapshot.settings ?? values);
        setPersistedDraftValues(draft?.settings ?? snapshot.settings ?? values);
        setDraftRevision(draft?.revision ?? snapshot.draft_revision ?? draftRevision + 1);
        setDraftStatus(draft?.status ?? "draft");
        setDraftBaseActiveRevision(draft?.base_active_revision ?? snapshot.revision);
        setRevision(snapshot.active_revision ?? snapshot.revision);
        setMigrationRequired(snapshot.migration_required === true || draft?.migration_required === true);
      } else {
        setValues(snapshot.settings); setActiveValues(snapshot.settings); setRevision(snapshot.revision);
        setMigrationRequired(snapshot.migration_required === true);
      }
      setAuditEvents(null); setAuditError(null);
      setNotice(ownerPublish ? "Draft saved. Review it and publish separately to make these settings active."
        : snapshot.migration_required ? "Settings still need review for the current schema." : "Settings saved for this installation.");
      setServerCanConfigure(typeof snapshot.can_configure === "boolean" ? snapshot.can_configure : null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save extension settings."); }
    finally { setSaving(false); }
  }
  async function publishDraft() {
    if (!ownerPublish || draftStatus !== "draft" || draftBaseActiveRevision !== revision || migrationRequired || saving) return;
    if (typeof window !== "undefined" && !window.confirm(`Publish settings draft revision ${draftRevision} for this extension installation? These values will become active.`)) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const snapshot = await request("PATCH", { action: "publish", draft_revision: draftRevision, expected_active_revision: revision, confirm: true }) as Snapshot;
      const active = snapshot.settings ?? values;
      setValues(active); setActiveValues(active); setRevision(snapshot.revision ?? revision + 1);
      setPersistedDraftValues(null);
      setDraftRevision(snapshot.draft_revision ?? draftRevision); setDraftStatus(null); setDraftBaseActiveRevision(snapshot.revision ?? revision + 1);
      setMigrationRequired(snapshot.migration_required === true);
      setAuditEvents(null); setAuditError(null);
      setNotice("Settings are active for this installation.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not publish extension settings."); }
    finally { setSaving(false); }
  }
  async function loadHistory() {
    if (!loadAudit) return;
    setAuditLoading(true); setAuditError(null);
    try { setAuditEvents((await loadAudit()).events); }
    catch (cause) { setAuditError(cause instanceof Error ? cause.message : "Could not load configuration history."); }
    finally { setAuditLoading(false); }
  }
  function renderField(field: BlueprintSetupField) {
    const value = values[field.id];
    const label = localizedExtensionFieldLabel(field, locale);
    const helpText = localizedExtensionFieldHelp(field, locale);
    const help = helpText ? <small style={{ display: "block", color: "var(--text3)" }}>{helpText}</small> : null;
    if (field.type === "boolean") return <label key={field.id} style={{ display: "block", margin: "12px 0" }}>
      <input type="checkbox" checked={typeof value === "boolean" ? value : field.defaultValue ?? false} disabled={!mayConfigure || loading || saving}
        onChange={event => change(field, event.target.checked)} /> {label}{help}
    </label>;
    if (field.type === "select") return <label key={field.id} style={{ display: "block", margin: "12px 0" }}>{label}
      <select className="input" required={field.required} value={typeof value === "string" ? value : field.defaultValue ?? ""} disabled={!mayConfigure || loading || saving}
        onChange={event => change(field, event.target.value || undefined)}>
        {!field.required && <option value="">Choose later</option>}
        {field.options.map(option => <option key={option.value} value={option.value}>{localizedExtensionOptionLabel(field, option.value, locale, option.label)}</option>)}
      </select>{help}
    </label>;
    if (field.type === "number") return <label key={field.id} style={{ display: "block", margin: "12px 0" }}>{label}
      <input className="input" type="number" required={field.required} min={field.minimum} max={field.maximum} step={field.integer ? 1 : "any"}
        value={typeof value === "number" ? value : field.defaultValue ?? ""} disabled={!mayConfigure || loading || saving}
        onChange={event => change(field, event.target.value === "" ? undefined : Number(event.target.value))} />{help}
    </label>;
    return <label key={field.id} style={{ display: "block", margin: "12px 0" }}>{label}
      <input className="input" type="text" required={field.required} minLength={field.minLength} maxLength={field.maxLength}
        value={typeof value === "string" ? value : field.defaultValue ?? ""} disabled={!mayConfigure || loading || saving}
        onChange={event => change(field, event.target.value === "" && !field.required ? undefined : event.target.value)} />{help}
    </label>;
  }
  function isVisible(field: BlueprintSetupField) {
    const condition = "visibleWhen" in field ? field.visibleWhen : undefined;
    return !condition || values[condition.fieldId] === condition.equals;
  }
  return <section aria-label="Extension settings" style={{ border: "1px solid var(--border, #ddd)", borderRadius: 10, padding: 16, marginBottom: 16 }}>
    <h2 style={{ marginTop: 0 }}>Installation settings</h2>
    <p style={{ color: "var(--text3)", fontSize: 13 }}>These values are validated by the host and saved for this installation. Manage provider credentials in Connections.</p>
    {ownerPublish && <p role="status" style={{ color: "var(--text3)", fontSize: 12 }}>Changes are saved as a draft. An owner must review and publish them before they affect the extension.</p>}
    {ownerPublish && draftStatus === "draft" && <div aria-label="Settings draft review" style={{ border: "1px solid var(--border)", borderRadius: 7, padding: 9, marginBottom: 10, fontSize: 12 }}>
      <strong>Draft revision {draftRevision} · based on active revision {draftBaseActiveRevision}</strong>
      {draftBaseActiveRevision !== revision && <p role="alert" style={{ color: "var(--warning, #8a5a00)" }}>The active settings changed after this draft was created. Reload and review a new draft before publishing.</p>}
      <ul style={{ margin: "6px 0", paddingLeft: 18 }}>{schema.fields.filter(field => JSON.stringify(activeValues[field.id] ?? field.defaultValue) !== JSON.stringify(values[field.id] ?? field.defaultValue))
        .map(field => <li key={field.id}>{localizedExtensionFieldLabel(field, locale)}: active <strong>{String(activeValues[field.id] ?? field.defaultValue ?? "(unset)")}</strong> → draft <strong>{String(values[field.id] ?? field.defaultValue ?? "(unset)")}</strong></li>)}
      </ul>
      <p style={{ margin: 0 }}>Review every value below before publishing.</p>
      {ownerDraftHasUnsavedEdits && <p role="status" style={{ margin: "6px 0 0", color: "var(--warning, #8a5a00)" }}>Save the edited draft before publishing it.</p>}
    </div>}
    {migrationRequired && <p role="status" style={{ color: "var(--warning, #8a5a00)", fontSize: 13 }}>This extension changed its settings schema. Review the compatible values and save to confirm the current configuration. Incompatible or retired fields are omitted from this form.</p>}
    {projectScope && !loading && serverCanConfigure === false && <p role="status" style={{ color: "var(--text3)", fontSize: 12 }}>You can review this installation's settings. Project management permission is required to change them.</p>}
    {loading ? <p role="status">Loading settings…</p> : schema.fields.filter(isVisible).map(renderField)}
    {error && <p role="alert" style={{ color: "var(--danger, #c33)" }}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div style={{ display: "flex", gap: 8 }}>
      <Button variant="secondary" disabled={loading || saving} onClick={() => void load()}>Reload</Button>
      {mayConfigure && <Button disabled={loading || saving} onClick={() => void save()}>{saving ? "Saving…" : ownerPublish ? "Save draft" : "Save settings"}</Button>}
      {mayConfigure && ownerPublish && draftStatus === "draft" && <Button disabled={loading || saving || migrationRequired || draftBaseActiveRevision !== revision || ownerDraftHasUnsavedEdits}
        onClick={() => void publishDraft()}>{saving ? "Publishing…" : "Publish reviewed draft"}</Button>}
    </div>
    {loadAudit && <details style={{ marginTop: 16, borderTop: "1px solid var(--border, #ddd)", paddingTop: 12 }}>
      <summary style={{ cursor: "pointer" }}>Configuration change history</summary>
      <p style={{ color: "var(--text3)", fontSize: 12 }}>History contains actor, revision, schema and changed field IDs. It never includes setting values.</p>
      <Button variant="secondary" disabled={auditLoading} onClick={() => void loadHistory()}>{auditLoading ? "Loading history…" : "Load history"}</Button>
      {auditError && <p role="alert" style={{ color: "var(--danger, #c33)" }}>{auditError}</p>}
      {auditEvents && (auditEvents.length ? <ol aria-label="Configuration changes">
        {auditEvents.map(event => <li key={event.event_id} style={{ margin: "8px 0", fontSize: 12 }}>
          <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time>{" · "}
          {event.actor_agent_id ? `Agent ${event.actor_agent_id} delegated by ${event.delegated_by ?? "unknown user"}` : event.actor_id} ({event.actor_role}) · revision {event.prior_revision} → {event.new_revision} · schema v{event.schema_version} · fields {event.changed_field_ids.length ? event.changed_field_ids.join(", ") : "unchanged"}
        </li>)}
      </ol> : <p role="status" style={{ fontSize: 12 }}>No settings changes recorded.</p>)}
      {auditEvents && auditEvents.length > 0 && <p style={{ color: "var(--text3)", fontSize: 12 }}>Showing up to the 50 most recent changes. {auditEvents.length === 50 ? "Older changes may exist." : ""}</p>}
    </details>}
  </section>;
}
