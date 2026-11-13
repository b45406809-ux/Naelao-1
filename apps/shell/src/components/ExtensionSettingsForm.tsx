"use client";

import * as React from "react";
import { Button } from "@naelao/ui";
import type { BlueprintSetupField, ExtensionSettingsSchema } from "@naelao/agent-sdk";
import { callProjectExtensionSettings, callSpaceSharedExtensionApi, type SessionCredentials } from "@/lib/api";
import { localizedExtensionFieldHelp, localizedExtensionFieldLabel, localizedExtensionOptionLabel } from "@/lib/extension-settings-locale";

type Value = string | number | boolean;
type Snapshot = { schema: ExtensionSettingsSchema; settings: Record<string, Value>; revision: number; can_configure?: boolean; migration_required?: boolean };

export function ExtensionSettingsForm({ spaceId, appId, schema, session, canConfigure, projectScope }: {
  spaceId: string; appId: string; schema: ExtensionSettingsSchema; session: SessionCredentials; canConfigure: boolean;
  projectScope?: { projectId: string; installationId: string };
}) {
  const [values, setValues] = React.useState<Record<string, Value>>({});
  const [revision, setRevision] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [serverCanConfigure, setServerCanConfigure] = React.useState<boolean | null>(null);
  const [migrationRequired, setMigrationRequired] = React.useState(false);
  const [locale, setLocale] = React.useState("en");
  const mayConfigure = canConfigure && serverCanConfigure !== false;
  const request = React.useCallback((method: "GET" | "PATCH", body?: unknown) => projectScope
    ? callProjectExtensionSettings(spaceId, projectScope.projectId, projectScope.installationId, session, { method, ...(body === undefined ? {} : { body }) })
    : callSpaceSharedExtensionApi(spaceId, appId, session, { method, path: "/api/settings", ...(body === undefined ? {} : { body }) }),
  [spaceId, appId, session, projectScope?.projectId, projectScope?.installationId]);
  const load = React.useCallback(async () => {
    setLoading(true); setError(null); setNotice(null);
    try {
      const snapshot = await request("GET") as Snapshot;
      setValues(snapshot.settings ?? {}); setRevision(snapshot.revision);
      setServerCanConfigure(typeof snapshot.can_configure === "boolean" ? snapshot.can_configure : null);
      setMigrationRequired(snapshot.migration_required === true);
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
      const snapshot = await request("PATCH", { settings: values, revision }) as Snapshot;
      setValues(snapshot.settings); setRevision(snapshot.revision); setMigrationRequired(snapshot.migration_required === true);
      setNotice(snapshot.migration_required ? "Settings still need review for the current schema." : "Settings saved for this installation.");
      setServerCanConfigure(typeof snapshot.can_configure === "boolean" ? snapshot.can_configure : null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save extension settings."); }
    finally { setSaving(false); }
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
    {migrationRequired && <p role="status" style={{ color: "var(--warning, #8a5a00)", fontSize: 13 }}>This extension changed its settings schema. Review the compatible values and save to confirm the current configuration. Incompatible or retired fields are omitted from this form.</p>}
    {projectScope && !loading && serverCanConfigure === false && <p role="status" style={{ color: "var(--text3)", fontSize: 12 }}>You can review this installation's settings. Project management permission is required to change them.</p>}
    {loading ? <p role="status">Loading settings…</p> : schema.fields.filter(isVisible).map(renderField)}
    {error && <p role="alert" style={{ color: "var(--danger, #c33)" }}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div style={{ display: "flex", gap: 8 }}>
      <Button variant="secondary" disabled={loading || saving} onClick={() => void load()}>Reload</Button>
      {mayConfigure && <Button disabled={loading || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</Button>}
    </div>
  </section>;
}
