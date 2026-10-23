"use client";

import * as React from "react";
import { Button, Card, CardDesc, CardTitle } from "@naelao/ui";
import { MicroAppCanvas } from "@/components/viewports/MicroAppCanvas";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProductAuth } from "@/lib/auth-provider";
import { installSpaceSharedExtension, listSpaceSharedExtensionApps, listSpaceSharedExtensionCatalog, type SpaceSharedExtensionApp, type SpaceSharedExtensionCatalogEntry } from "@/lib/api";

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
  async function install(id: string) {
    if (!credentials) return;
    setInstalling(id); setError(null);
    try { await installSpaceSharedExtension(activeSpaceId, id, credentials); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not install extension."); }
    finally { setInstalling(null); }
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
      <Button onClick={() => setActive(app)}>Open extension</Button>
      </Card>)}</div> : null}
    {!active && !loading && catalog.some(entry => !installedIds.has(entry.id)) ? <section style={{ marginTop: 24 }}><h2>Available Space extensions</h2><div className="grid-3">{catalog.filter(entry => !installedIds.has(entry.id)).map(entry => <Card key={entry.id}>
      <CardTitle>{entry.name}</CardTitle><CardDesc>Install this first-party Space-shared extension. Its app and storage are isolated to the active Space.</CardDesc>
      <Button disabled={installing !== null} onClick={() => void install(entry.id)}>{installing === entry.id ? "Installing…" : "Install extension"}</Button>
    </Card>)}</div></section> : null}
    {!active && !loading && !error && !apps.length && !catalog.length ? <Card><CardTitle>No Space extensions available</CardTitle><CardDesc>Extensions included by an installed Space Template appear here. Each extension runs in its own scoped storage and receives only the host APIs it declares.</CardDesc></Card> : null}
  </div>;
}
