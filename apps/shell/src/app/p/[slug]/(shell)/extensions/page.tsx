"use client";

import * as React from "react";
import { Button, Card, CardDesc, CardTitle } from "@naelao/ui";
import { MicroAppCanvas } from "@/components/viewports/MicroAppCanvas";
import { ExtensionSettingsForm } from "@/components/ExtensionSettingsForm";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProductAuth } from "@/lib/auth-provider";
import { callSpaceExtensionSettingsAudit, installSpaceSharedExtension, listSpaceSharedExtensionApps, listSpaceSharedExtensionCatalog, previewSpaceSharedExtensionUpdate, removeSpaceSharedExtension, setSpaceSharedExtensionEnabled, updateSpaceSharedExtensionFilesystemGrants, type SharedFilesystemGrant, type SpaceSharedExtensionApp, type SpaceSharedExtensionCatalogEntry, type SpaceSharedExtensionUpdateReview } from "@/lib/api";

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
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [changingLifecycle, setChangingLifecycle] = React.useState<string | null>(null);
  const [reviewingUpdate, setReviewingUpdate] = React.useState<string | null>(null);
  const [updateReviews, setUpdateReviews] = React.useState<Record<string, SpaceSharedExtensionUpdateReview>>({});
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
  async function install(entry: SpaceSharedExtensionCatalogEntry) {
    if (!credentials) return;
    setInstalling(entry.id); setError(null);
    try { await installSpaceSharedExtension(activeSpaceId, entry.id, credentials, selectedGrants[entry.id] ?? [], entry.version); await refresh(); }
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
  async function remove(app: SpaceSharedExtensionApp) {
    if (!credentials || removing) return;
    if (!window.confirm(`Remove ${app.name} from this Space? Its access and grants will be revoked. Stored extension data will be retained.`)) return;
    setRemoving(app.installation_id); setError(null);
    try { await removeSpaceSharedExtension(activeSpaceId, app.installation_id, credentials); setActive(null); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove extension."); }
    finally { setRemoving(null); }
  }
  async function changeLifecycle(app: SpaceSharedExtensionApp) {
    if (!credentials || changingLifecycle) return;
    const enabled = app.status !== "active";
    if (!enabled && !window.confirm(`Pause ${app.name}? New invocations will stop. Running jobs may finish; data and access grants will be retained.`)) return;
    setChangingLifecycle(app.installation_id); setError(null);
    try { await setSpaceSharedExtensionEnabled(activeSpaceId, app.installation_id, credentials, enabled); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update extension status."); }
    finally { setChangingLifecycle(null); }
  }
  async function reviewUpdate(app: SpaceSharedExtensionApp, candidate: SpaceSharedExtensionCatalogEntry) {
    if (!credentials || !app.release_version || !candidate.version) return;
    setReviewingUpdate(app.installation_id); setError(null);
    try {
      const review = await previewSpaceSharedExtensionUpdate(activeSpaceId, app.installation_id, credentials, app.release_version, candidate.version);
      setUpdateReviews(current => ({ ...current, [app.installation_id]: review }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not review the signed package update."); }
    finally { setReviewingUpdate(null); }
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
      {active.settings_schema && active.capabilities.includes("extension.settings.read") && <ExtensionSettingsForm spaceId={activeSpaceId} appId={active.app_id} schema={active.settings_schema} session={credentials} canConfigure={active.capabilities.includes("extension.settings.configure")}
        loadAudit={() => callSpaceExtensionSettingsAudit(activeSpaceId, active.installation_id, credentials)} />}
      <MicroAppCanvas spaceId={activeSpaceId} appId={active.app_id} projectId={active.app_id} projectScoped={false} session={credentials} capabilities={active.capabilities} onAction={() => {}} />
    </> : loading ? <p role="status">Loading installed extensions…</p> : error ? <div role="alert">{error} <Button variant="secondary" onClick={() => void refresh()}>Retry</Button></div> : apps.length ? <div className="grid-3">{apps.map(app => <Card key={`${app.installation_id}:${app.app_id}`}>
      <CardTitle>{app.name}</CardTitle><CardDesc>{app.extension_id}</CardDesc>
      <p style={{ color: "var(--text3)", fontSize: 12 }}>Shared across this Space · {app.status === "active" ? "Enabled" : "Paused"} · installed {new Date(app.installed_at).toLocaleDateString()}</p>
      {app.status === "disabled" && <p role="status" style={{ color: "var(--text3)", fontSize: 12 }}>New invocations are blocked. Existing runs may finish; saved data and grants are retained.</p>}
      {app.release_version && <p style={{ color: "var(--text3)", fontSize: 12 }}>Installed signed release: {app.release_version}</p>}
      {catalog.find(entry => entry.id === app.extension_id && entry.version && app.release_version && entry.version !== app.release_version) && (() => {
        const candidate = catalog.find(entry => entry.id === app.extension_id && entry.version && app.release_version && entry.version !== app.release_version)!;
        const review = updateReviews[app.installation_id];
        return <section style={{ margin: "12px 0", padding: 12, border: "1px solid var(--border, #ddd)", borderRadius: 8 }}>
          <strong>Signed update available: {candidate.version}</strong>
          <p style={{ color: "var(--text3)", fontSize: 12 }}>Review the pinned release, requested authority and schema before any update. Preview does not change the installation.</p>
          <Button variant="secondary" disabled={reviewingUpdate !== null} onClick={() => void reviewUpdate(app, candidate)}>
            {reviewingUpdate === app.installation_id ? "Reviewing…" : "Review update"}
          </Button>
          {review && <div role="status" style={{ marginTop: 12, fontSize: 12 }}>
            <p>Verified publisher: {review.candidate.publisher_id} · {review.current.version} → {review.candidate.version}</p>
            <p>Permissions added: {review.permissions.added.join(", ") || "none"}; removed: {review.permissions.removed.join(", ") || "none"}</p>
            <p>Capabilities added: {review.capabilities.added.join(", ") || "none"}; removed: {review.capabilities.removed.join(", ") || "none"}</p>
            <p>Schema changes — added: {review.schema_changes.added.join(", ") || "none"}; removed: {review.schema_changes.removed.join(", ") || "none"}; changed: {review.schema_changes.changed.join(", ") || "none"}</p>
            <p>Package dependencies: {review.dependencies.package.status}. Provider connection changes: {review.dependencies.provider_connections.added.length} added, {review.dependencies.provider_connections.removed.length} removed, {review.dependencies.provider_connections.changed.length} changed.</p>
            <p>Shared folders — added: {review.shared_filesystem.added.join(", ") || "none"}; removed: {review.shared_filesystem.removed.join(", ") || "none"}; changed: {review.shared_filesystem.changed.join(", ") || "none"}</p>
            <p>Price terms: {review.price_terms.status}. No package price is declared.</p>
            {review.review.explicit_owner_approval_required && <p>Owner approval is required for this update review.</p>}
            <p>Update activation is unavailable until safe migrations, rollback and active-work drain are supported.</p>
          </div>}
        </section>;
      })()}
      <p style={{ color: "var(--text3)", fontSize: 12 }}>Approved folders: {app.approved_shared_filesystem.length ? app.approved_shared_filesystem.map(item => `${item.path} (${item.access})`).join(", ") : "none"}</p>
      {editingGrants === app.installation_id ? grantsEditor(app.installation_id, app.requested_shared_filesystem, app.approved_shared_filesystem, true) : <Button variant="secondary" onClick={() => { setSelectedGrants(current => ({ ...current, [app.installation_id]: app.approved_shared_filesystem })); setEditingGrants(app.installation_id); }}>Manage access</Button>}
      <Button variant="secondary" disabled={changingLifecycle !== null || removing !== null} onClick={() => void changeLifecycle(app)}>{changingLifecycle === app.installation_id ? "Updating…" : app.status === "active" ? "Pause extension" : "Resume extension"}</Button>
      <Button variant="secondary" disabled={removing !== null} onClick={() => void remove(app)}>{removing === app.installation_id ? "Removing…" : "Remove extension"}</Button>
      <Button disabled={app.status !== "active"} onClick={() => setActive(app)}>Open extension</Button>
      </Card>)}</div> : null}
    {!active && !loading && catalog.some(entry => !installedIds.has(entry.id)) ? <section style={{ marginTop: 24 }}><h2>Available Space extensions</h2><div className="grid-3">{catalog.filter(entry => !installedIds.has(entry.id)).map(entry => <Card key={entry.id}>
      <CardTitle>{entry.name}</CardTitle><CardDesc>{entry.version ? `Signed release ${entry.version} from ${entry.publisher_id ?? "a trusted publisher"}. Its app and storage are isolated to the active Space.` : "Install this first-party Space-shared extension. Its app and storage are isolated to the active Space."}</CardDesc>
      {grantsEditor(entry.id, entry.requested_shared_filesystem, [])}
      <Button disabled={installing !== null} onClick={() => void install(entry)}>{installing === entry.id ? "Installing…" : "Install extension"}</Button>
    </Card>)}</div></section> : null}
    {!active && !loading && !error && !apps.length && !catalog.length ? <Card><CardTitle>No Space extensions available</CardTitle><CardDesc>Extensions included by an installed Space Template appear here. Each extension runs in its own scoped storage and receives only the host APIs it declares.</CardDesc></Card> : null}
  </div>;
}
