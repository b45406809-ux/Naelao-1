"use client";

import * as React from "react";
import { Button } from "@naelao/ui";
import type { BlueprintSetupField, ExtensionSettingsSchema } from "@naelao/agent-sdk";
import { callSpaceSharedExtensionApi, type SessionCredentials } from "@/lib/api";

type Value = string | number | boolean;
type Snapshot = { schema: ExtensionSettingsSchema; settings: Record<string, Value>; revision: number };

export function ExtensionSettingsForm({ spaceId, appId, schema, session, canConfigure }: {
  spaceId: string; appId: string; schema: ExtensionSettingsSchema; session: SessionCredentials; canConfigure: boolean;
}) {
  const [values, setValues] = React.useState<Record<string, Value>>({});
  const [revision, setRevision] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    setLoading(true); setError(null); setNotice(null);
    try {
      const snapshot = await callSpaceSharedExtensionApi(spaceId, appId, session, { method: "GET", path: "/api/settings" }) as Snapshot;
      setValues(snapshot.settings ?? {}); setRevision(snapshot.revision);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load extension settings."); }
    finally { setLoading(false); }
  }, [spaceId, appId, session]);
  React.useEffect(() => { void load(); }, [load]);
  const change = (field: BlueprintSetupField, value: Value | undefined) => setValues(current => {
    const next = { ...current };
    if (value === undefined) delete next[field.id]; else next[field.id] = value;
    return next;
  });
  async function save() {
    setSaving(true); setError(null); setNotice(null);
    try {
      const snapshot = await callSpaceSharedExtensionApi(spaceId, appId, session, { method: "PATCH", path: "/api/settings", body: { settings: values, revision } }) as Snapshot;
      setValues(snapshot.settings); setRevision(snapshot.revision); setNotice("Settings saved for this installation.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save extension settings."); }
    finally { setSaving(false); }
  }
  function renderField(field: BlueprintSetupField) {
    const value = values[field.id];
    const help = field.helpText ? <small style={{ display: "block", color: "var(--text3)" }}>{field.helpText}</small> : null;
    if (field.type === "boolean") return <label key={field.id} style={{ display: "block", margin: "12px 0" }}>
      <input type="checkbox" checked={typeof value === "boolean" ? value : field.defaultValue ?? false} disabled={!canConfigure || loading || saving}
        onChange={event => change(field, event.target.checked)} /> {field.label}{help}
    </label>;
    if (field.type === "select") return <label key={field.id} style={{ display: "block", margin: "12px 0" }}>{field.label}
      <select className="input" required={field.required} value={typeof value === "string" ? value : field.defaultValue ?? ""} disabled={!canConfigure || loading || saving}
        onChange={event => change(field, event.target.value || undefined)}>
        {!field.required && <option value="">Choose later</option>}
        {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>{help}
    </label>;
    if (field.type === "number") return <label key={field.id} style={{ display: "block", margin: "12px 0" }}>{field.label}
      <input className="input" type="number" required={field.required} min={field.minimum} max={field.maximum} step={field.integer ? 1 : "any"}
        value={typeof value === "number" ? value : field.defaultValue ?? ""} disabled={!canConfigure || loading || saving}
        onChange={event => change(field, event.target.value === "" ? undefined : Number(event.target.value))} />{help}
    </label>;
    return <label key={field.id} style={{ display: "block", margin: "12px 0" }}>{field.label}
      <input className="input" type="text" required={field.required} minLength={field.minLength} maxLength={field.maxLength}
        value={typeof value === "string" ? value : field.defaultValue ?? ""} disabled={!canConfigure || loading || saving}
        onChange={event => change(field, event.target.value === "" && !field.required ? undefined : event.target.value)} />{help}
    </label>;
  }
  return <section aria-label="Extension settings" style={{ border: "1px solid var(--border, #ddd)", borderRadius: 10, padding: 16, marginBottom: 16 }}>
    <h2 style={{ marginTop: 0 }}>Installation settings</h2>
    <p style={{ color: "var(--text3)", fontSize: 13 }}>These values are validated by the host and saved for this installation. Manage provider credentials in Connections.</p>
    {loading ? <p role="status">Loading settings…</p> : schema.fields.map(renderField)}
    {error && <p role="alert" style={{ color: "var(--danger, #c33)" }}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div style={{ display: "flex", gap: 8 }}>
      <Button variant="secondary" disabled={loading || saving} onClick={() => void load()}>Reload</Button>
      {canConfigure && <Button disabled={loading || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</Button>}
    </div>
  </section>;
}
