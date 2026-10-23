"use client";

import * as React from "react";
import { Button, Card, CardDesc, CardTitle } from "@naelao/ui";
import { MicroAppCanvas } from "@/components/viewports/MicroAppCanvas";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProductAuth } from "@/lib/auth-provider";
import { installSpaceSharedExtension, listSpaceSharedExtensionApps, listSpaceSharedExtensionCatalog, updateSpaceSharedExtensionFilesystemGrants, type SharedFilesystemGrant, type SpaceSharedExtensionApp, type SpaceSharedExtensionCatalogEntry } from "@/lib/api";

/** Generic mount point for every installed Space-shared extension canvas. Product-specific
 * features belong in extension artifacts; the shell only discovers and mounts them. */
export default function ExtensionsPage() {
  const { activeSpaceId } = useActiveSpace();
  const { session } = useProductAuth();
  const [apps, setApps] = React.useState<SpaceSharedExtensionApp[]>([]);
  const [catalog, setCatalog] = React.useState<SpaceSharedExtensionCatalogEntry[]>([]);
  const [active, setActive] = React.useState<SpaceSharedExtensionApp | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const credentials = React.useMemo(() => session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null, [session]);
  const refresh = React.useCallback(async () => {
    if (!credentials) return;
    setLoading(true); setError(null);
    try {
      const [result, available] = await Promise.all([listSpaceSharedExtensionApps(activeSpaceId, credentials), listSpaceSharedExtensionCatalog(activeSpaceId, credentials)]);
      setApps(result.apps); setCatalog(available.extensions);
      setActive(current => current && result.apps.some(app => app.app_id === current.app_id) ? current : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Space extensions.");
    } finally { setLoading(false); }
  }, [activeSpaceId, credentials]);
  React.useEffect(() => { void refresh(); }, [refresh]);
  const installedIds = new Set(apps.map(app => app.extension_id));
  const [installing, setInstalling] = React.useState<string | null>(null);
  const [selectedGrants, setSelectedGrants] = React.useState<Record<string, SharedFilesystemGrant[]>>({});
  const [editingGrants, setEditingGrants] = React.useState<string | null>(null);
  const [savingGrants, setSavingGrants] = React.useState<string | null>(null);
  React.useEffect(() => setSelectedGrants(current => {
    const next = { ...current };
    for (const entry of catalog) if (!(entry.id in next)) next[entry.id] = [];
    for (const app of apps) if (!(app.installation_id in next)) next[app.installation_id] = app.approved_shared_filesystem;
    return next;
  }), [apps, catalog]);
  function toggleGrant(key: string, requested: SharedFilesystemGrant, access?: "READ" | "READ_WRITE") {
    setSelectedGrants(current => {
      const grants = (current[key] ?? []).filter(item => item.path !== requested.path);
      if (access) grants.push({ path: requested.path, access });
      return { ...current, [key]: grants };
    });
  }
  async function install(id: string) {
    if (!credentials) return;
    setInstalling(id); setError(null);
    try { await installSpaceSharedExtension(activeSpaceId, id, credentials, selectedGrants[id] ?? []); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not install extension."); }
    finally { setInstalling(null); }
  }
  async function saveGrants(app: SpaceSharedExtensionApp) {
    if (!credentials) return;
    setSavingGrants(app.installation_id); setError(null);
    try { await updateSpaceSharedExtensionFilesystemGrants(activeSpaceId, app.installation_id, credentials, selectedGrants[app.installation_id] ?? []); setEditingGrants(null); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update shared-drive access."); }
    finally { setSavingGrants(null); }
  }
  function grantsEditor(key: string, requested: SharedFilesystemGrant[], current: SharedFilesystemGrant[], allowSave = false) {
    if (!requested.length) return <p style={{ color: "var(--text3)", fontSize: 12 }}>This extension requests no shared-drive access.</p>;
    const selected = selectedGrants[key] ?? current;
    return <div style={{ margin: "12px 0", padding: 12, border: "1px solid var(--border, #ddd)", borderRadius: 8 }}>
      <strong>Shared drive access</strong><p style={{ color: "var(--text3)", fontSize: 12 }}>Approve only the folders this extension needs. Access is limited to this installation and can be revoked later.</p>
      {requested.map(grant => {
        const access = selected.find(item => item.path === grant.path)?.access;
        return <div key={grant.path} style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0" }}>
          <input aria-label={`Allow ${grant.path}`} type="checkbox" checked={Boolean(access)} onChange={event => toggleGrant(key, grant, event.target.checked ? (grant.access === "READ" ? "READ" : "READ_WRITE") : undefined)} />
          <code>{grant.path}</code><span style={{ color: "var(--text3)", fontSize: 12 }}>{access ?? "No access"}</span>
          {grant.access === "READ_WRITE" && access && <select aria-label={`Access level for ${grant.path}`} value={access} onChange={event => toggleGrant(key, grant, event.target.value as "READ" | "READ_WRITE")}><option value="READ">Read only</option><option value="READ_WRITE">Read and write</option></select>}
        </div>;
      })}
      {allowSave && <Button variant="secondary" disabled={savingGrants === key} onClick={() => { const app = apps.find(item => item.installation_id === key); if (app) void saveGrants(app); }}>{savingGrants === key ? "Saving…" : "Save access"}</Button>}
    </div>;
  }

  return <div className="page-view">
    <div className="page-header"><h1 className="page-title">Extensions</h1><p className="page-subtitle">Space-shared tools and canvases installed from templates or the extension catalog.</p></div>
    {active && credentials ? <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <Button variant="secondary" onClick={() => setActive(null)}>All extensions</Button><strong>{active.name}</strong>
        <span style={{ color: "var(--text3)", fontSize: 12 }}>{active.extension_id} · Space shared</span>
      </div>
      <MicroAppCanvas spaceId={activeSpaceId} appId={active.app_id} projectId={active.app_id} projectScoped={false} session={credentials} capabilities={active.capabilities} onAction={() => {}} />
    </> : loading ? <p role="status">Loading installed extensions…</p> : error ? <div role="alert">{error} <Button variant="secondary" onClick={() => void refresh()}>Retry</Button></div> : apps.length ? <div className="grid-3">{apps.map(app => <Card key={`${app.installation_id}:${app.app_id}`}>
      <CardTitle>{app.name}</CardTitle><CardDesc>{app.extension_id}</CardDesc>
      <p style={{ color: "var(--text3)", fontSize: 12 }}>Shared across this Space · installed {new Date(app.installed_at).toLocaleDateString()}</p>
      <p style={{ color: "var(--text3)", fontSize: 12 }}>Approved folders: {app.approved_shared_filesystem.length ? app.approved_shared_filesystem.map(item => `${item.path} (${item.access})`).join(", ") : "none"}</p>
      {editingGrants === app.installation_id ? grantsEditor(app.installation_id, app.requested_shared_filesystem, app.approved_shared_filesystem, true) : <Button variant="secondary" onClick={() => { setSelectedGrants(current => ({ ...current, [app.installation_id]: app.approved_shared_filesystem })); setEditingGrants(app.installation_id); }}>Manage access</Button>}
      <Button onClick={() => setActive(app)}>Open extension</Button>
      </Card>)}</div> : null}
    {!active && !loading && catalog.some(entry => !installedIds.has(entry.id)) ? <section style={{ marginTop: 24 }}><h2>Available Space extensions</h2><div className="grid-3">{catalog.filter(entry => !installedIds.has(entry.id)).map(entry => <Card key={entry.id}>
      <CardTitle>{entry.name}</CardTitle><CardDesc>Install this first-party Space-shared extension. Its app and storage are isolated to the active Space.</CardDesc>
      {grantsEditor(entry.id, entry.requested_shared_filesystem, [])}
      <Button disabled={installing !== null} onClick={() => void install(entry.id)}>{installing === entry.id ? "Installing…" : "Install extension"}</Button>
    </Card>)}</div></section> : null}
    {!active && !loading && !error && !apps.length && !catalog.length ? <Card><CardTitle>No Space extensions available</CardTitle><CardDesc>Extensions included by an installed Space Template appear here. Each extension runs in its own scoped storage and receives only the host APIs it declares.</CardDesc></Card> : null}
  </div>;
}
