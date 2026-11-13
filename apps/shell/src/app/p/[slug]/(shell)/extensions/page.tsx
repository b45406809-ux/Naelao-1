"use client";

import * as React from "react";
import { Button, Card, CardDesc, CardTitle } from "@naelao/ui";
import { MicroAppCanvas } from "@/components/viewports/MicroAppCanvas";
import { ExtensionSettingsForm } from "@/components/ExtensionSettingsForm";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProductAuth } from "@/lib/auth-provider";
import { applySpaceSharedExtensionUpdate, callSpaceExtensionSettingsAudit, importSpaceSharedExtension, installSpaceSharedExtension,
  listSpaceSharedExtensionApps, listSpaceSharedExtensionCatalog, listSpaceSharedExtensionUpdateReceipts,
  previewSpaceSharedExtensionImport, previewSpaceSharedExtensionInstall,
  previewSpaceSharedExtensionUpdate, removeSpaceSharedExtension, setSpaceSharedExtensionEnabled, updateSpaceSharedExtensionFilesystemGrants,
  type SharedFilesystemGrant, type SpaceSharedExtensionApp, type SpaceSharedExtensionCatalogEntry, type SpaceSharedExtensionInstallReview,
  type SpaceSharedExtensionImportReview, type SpaceSharedExtensionInstallReviewPackage, type SpaceSharedExtensionUpdateReceipt,
  type SpaceSharedExtensionUpdateReview } from "@/lib/api";

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
  const [installReviews, setInstallReviews] = React.useState<Record<string, SpaceSharedExtensionInstallReview>>({});
  const [reviewingInstall, setReviewingInstall] = React.useState<string | null>(null);
  const [importSourceSpaceId, setImportSourceSpaceId] = React.useState("");
  const [importExtensionId, setImportExtensionId] = React.useState("");
  const [importVersion, setImportVersion] = React.useState("");
  const [importReview, setImportReview] = React.useState<SpaceSharedExtensionImportReview | null>(null);
  const [reviewingImport, setReviewingImport] = React.useState(false);
  const [importingPackage, setImportingPackage] = React.useState(false);
  const [importCompleted, setImportCompleted] = React.useState<string[] | null>(null);
  const refresh = React.useCallback(async () => {
    if (!credentials) return;
    setLoading(true); setError(null);
    try {
      const [result, available, updateHistory] = await Promise.all([
        listSpaceSharedExtensionApps(activeSpaceId, credentials), listSpaceSharedExtensionCatalog(activeSpaceId, credentials),
        listSpaceSharedExtensionUpdateReceipts(activeSpaceId, credentials).catch(() => ({ receipts: [] as SpaceSharedExtensionUpdateReceipt[] })),
      ]);
      setApps(result.apps); setCatalog(available.extensions); setInstallReviews({});
      setUpdateReceipts(updateHistory.receipts);
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
  const [updateReceipts, setUpdateReceipts] = React.useState<SpaceSharedExtensionUpdateReceipt[]>([]);
  const [applyingUpdate, setApplyingUpdate] = React.useState<string | null>(null);
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
    setInstallReviews(current => { const next = { ...current }; delete next[key]; return next; });
  }
  async function reviewInstall(entry: SpaceSharedExtensionCatalogEntry) {
    if (!credentials || !entry.version) return;
    setReviewingInstall(entry.id); setError(null);
    try {
      const review = await previewSpaceSharedExtensionInstall(activeSpaceId, entry.id, credentials, entry.version, selectedGrants[entry.id] ?? []);
      setInstallReviews(current => ({ ...current, [entry.id]: review }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not verify this package and its dependencies."); }
    finally { setReviewingInstall(null); }
  }
  async function install(entry: SpaceSharedExtensionCatalogEntry) {
    if (!credentials) return;
    setInstalling(entry.id); setError(null);
    const review = entry.version ? installReviews[entry.id] : undefined;
    if (entry.version && (!review?.ready_to_install || !review.review_token)) {
      setInstalling(null); setError("Review the exact package and install its required dependencies first."); return;
    }
    try { await installSpaceSharedExtension(activeSpaceId, entry.id, credentials, selectedGrants[entry.id] ?? [], entry.version, review?.review_token); await refresh(); }
    catch (cause) { await refresh(); setError(cause instanceof Error ? cause.message : "Could not install extension; completed dependencies remain installed and can be resumed after review."); }
    finally { setInstalling(null); }
  }
  async function reviewImport() {
    if (!credentials) return;
    setReviewingImport(true); setError(null); setImportCompleted(null);
    try {
      const review = await previewSpaceSharedExtensionImport(activeSpaceId, importSourceSpaceId.trim(), importExtensionId.trim(), importVersion.trim(), credentials);
      setImportReview(review);
    } catch (cause) { setImportReview(null); setError(cause instanceof Error ? cause.message : "Could not verify this package for the destination Space."); }
    finally { setReviewingImport(false); }
  }
  async function importReviewedPackage() {
    if (!credentials || !importReview || importReview.expires_at <= Date.now()) return;
    setImportingPackage(true); setError(null); setImportCompleted(null);
    try {
      const result = await importSpaceSharedExtension(activeSpaceId, importReview, credentials);
      setImportCompleted(result.completed_packages.map(item => `${item.extension_id}@${item.version}`));
      setImportReview(null);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Import paused. Completed package releases can be resumed by refreshing the review and retrying."); }
    finally { setImportingPackage(false); }
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
  async function applyUpdate(app: SpaceSharedExtensionApp) {
    if (!credentials) return;
    const review = updateReviews[app.installation_id];
    if (!review?.review.apply_supported || !review.update_review_token || !review.update_review_expires_at
      || review.update_review_expires_at <= Date.now() || app.status !== "disabled") {
      setError("Refresh the update review after pausing the installation. Only eligible static Canvas updates can be applied here."); return;
    }
    if (!window.confirm(`Apply signed release ${review.candidate.version} to ${app.name}? The extension will remain paused until an owner enables it again.`)) return;
    setApplyingUpdate(app.installation_id); setError(null);
    try {
      const result = await applySpaceSharedExtensionUpdate(activeSpaceId, app.installation_id, credentials, review.update_review_token);
      setUpdateReceipts(current => [result.receipt, ...current.filter(receipt => receipt.request_id !== result.receipt.request_id)].slice(0, 50));
      setUpdateReviews(current => { const next = { ...current }; delete next[app.installation_id]; return next; });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not apply the reviewed package update. Refresh the installation and review again."); }
    finally { setApplyingUpdate(null); }
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
          <p style={{ color: "var(--text3)", fontSize: 12 }}>Review verifies the signed candidate and compares its authority, settings, dependencies, connections and storage. Preview does not change the installation.</p>
          <Button variant="secondary" disabled={reviewingUpdate !== null} onClick={() => void reviewUpdate(app, candidate)}>
            {reviewingUpdate === app.installation_id ? "Reviewing…" : "Review update"}
          </Button>
          {review && <div role="status" style={{ marginTop: 12, fontSize: 12 }}>
            <p>Verified publisher: {review.candidate.publisher_id} · {review.current.version} → {review.candidate.version}</p>
            <p>Permissions added: {review.permissions.added.join(", ") || "none"}; removed: {review.permissions.removed.join(", ") || "none"}</p>
            <p>Capabilities added: {review.capabilities.added.join(", ") || "none"}; removed: {review.capabilities.removed.join(", ") || "none"}</p>
            <p>Schema changes — added: {review.schema_changes.added.join(", ") || "none"}; removed: {review.schema_changes.removed.join(", ") || "none"}; changed: {review.schema_changes.changed.join(", ") || "none"}</p>
            <p>Package dependencies: {review.dependencies.package.status}. Candidate pins: {review.dependencies.package.candidate_pins.map(pin => `${pin.extensionId}@${pin.version} (${pin.manifestSha256.slice(0, 12)})`).join(", ") || "none"}. Provider connection changes: {review.dependencies.provider_connections.added.length} added, {review.dependencies.provider_connections.removed.length} removed, {review.dependencies.provider_connections.changed.length} changed.</p>
            {!review.dependency_resolution.candidate.resolved && <p role="alert">Dependency closure is unresolved: {review.dependency_resolution.candidate.error}. The host will not activate this package.</p>}
            <p>Shared folders — added: {review.shared_filesystem.added.join(", ") || "none"}; removed: {review.shared_filesystem.removed.join(", ") || "none"}; changed: {review.shared_filesystem.changed.join(", ") || "none"}</p>
            <p>Price terms: {review.price_terms.status}. No package price is declared.</p>
            {review.review.explicit_owner_approval_required && <p>Owner approval is required for this update review.</p>}
            {review.review.apply_supported
              ? <><p>This candidate changes only version pins and static Canvas code. It declares no permissions and only the Canvas mounting capability; it has no settings, connections, dependencies, channels, or state migrations. The installation must be paused, and stays paused after the update.</p>
                <Button disabled={applyingUpdate !== null || app.status !== "disabled" || !review.update_review_token || (review.update_review_expires_at ?? 0) <= Date.now()}
                  onClick={() => void applyUpdate(app)}>{applyingUpdate === app.installation_id ? "Applying reviewed update…" : "Apply update and keep paused"}</Button></>
              : <p>Update is unavailable: {review.review.apply_block_reason ?? "refresh the review"}.</p>}
          </div>}
        </section>;
      })()}
      {updateReceipts.filter(receipt => receipt.installation_id === app.installation_id).slice(0, 5).map(receipt => <p key={receipt.request_id}
        style={{ color: "var(--text3)", fontSize: 12 }}>Applied {receipt.from_version} → {receipt.to_version} · {new Date(receipt.created_at).toLocaleString()} · signed artifact {receipt.artifact_sha256.slice(0, 12)} · installation remains paused unless enabled.</p>)}
      <p style={{ color: "var(--text3)", fontSize: 12 }}>Approved folders: {app.approved_shared_filesystem.length ? app.approved_shared_filesystem.map(item => `${item.path} (${item.access})`).join(", ") : "none"}</p>
      {editingGrants === app.installation_id ? grantsEditor(app.installation_id, app.requested_shared_filesystem, app.approved_shared_filesystem, true) : <Button variant="secondary" onClick={() => { setSelectedGrants(current => ({ ...current, [app.installation_id]: app.approved_shared_filesystem })); setEditingGrants(app.installation_id); }}>Manage access</Button>}
      <Button variant="secondary" disabled={changingLifecycle !== null || removing !== null} onClick={() => void changeLifecycle(app)}>{changingLifecycle === app.installation_id ? "Updating…" : app.status === "active" ? "Pause extension" : "Resume extension"}</Button>
      <Button variant="secondary" disabled={removing !== null} onClick={() => void remove(app)}>{removing === app.installation_id ? "Removing…" : "Remove extension"}</Button>
      <Button disabled={app.status !== "active"} onClick={() => setActive(app)}>Open extension</Button>
      </Card>)}</div> : null}
    {!active && !loading && catalog.some(entry => !installedIds.has(entry.id)) ? <section style={{ marginTop: 24 }}><h2>Available Space extensions</h2><div className="grid-3">{catalog.filter(entry => !installedIds.has(entry.id)).map(entry => {
      const review = installReviews[entry.id];
      const reviewedPackages = review ? [review.requested_package, ...review.dependency_packages] : [];
      const installStateLabel = (state: SpaceSharedExtensionInstallReviewPackage["installed_state"]) => state === "installed_exact" ? "Installed at exact pin"
        : state === "installed_disabled" ? "Installed but paused" : state === "pin_conflict" ? "Conflicting version is installed" : "Must be installed first";
      return <Card key={entry.id}>
        <CardTitle>{entry.name}</CardTitle><CardDesc>{entry.version ? `Signed release ${entry.version} from ${entry.publisher_id ?? "a trusted publisher"}. Its app and storage are isolated to the active Space.` : "Install this first-party Space-shared extension. Its app and storage are isolated to the active Space."}</CardDesc>
        {entry.dependencies?.length ? <p style={{ color: "var(--text3)", fontSize: 12 }}>Requires exact installed releases: {entry.dependencies.map(item => `${item.extensionId}@${item.version}`).join(", ")}.</p> : null}
        {grantsEditor(entry.id, entry.requested_shared_filesystem, [])}
        {entry.version ? <Button variant="secondary" disabled={reviewingInstall !== null || installing !== null} onClick={() => void reviewInstall(entry)}>
          {reviewingInstall === entry.id ? "Verifying package…" : review ? "Refresh package review" : "Review package"}
        </Button> : <Button disabled={installing !== null} onClick={() => void install(entry)}>{installing === entry.id ? "Installing…" : "Install extension"}</Button>}
        {review && <div role="status" style={{ marginTop: 12, padding: 12, border: "1px solid var(--border, #ddd)", borderRadius: 8, fontSize: 12 }}>
          <strong>Signed package review · {review.version}</strong>
          <p>Review is read-only. Publisher artifact signatures are verified for the requested package and each exact dependency. No package is installed by this review.</p>
          {reviewedPackages.map(pkg => {
            const dependencyEntry = !pkg.is_requested ? catalog.find(candidate => candidate.id === pkg.extension_id && candidate.version === pkg.version) : undefined;
            return <section key={`${pkg.extension_id}@${pkg.version}`} style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border, #ddd)" }}>
              <strong>{pkg.is_requested ? "Requested package" : "Dependency"}: {pkg.extension_id}@{pkg.version}</strong>
              <p>Publisher: {pkg.publisher_id} · signing key: {pkg.publisher_key_id} · manifest SHA-256: {pkg.manifest_sha256} · signature and artifact digest verified · {installStateLabel(pkg.installed_state)}</p>
              <p>Permissions: {pkg.permissions.join(", ") || "none"}. Capabilities: {pkg.capabilities.join(", ") || "none"}.</p>
              <p>Shared folders: {pkg.shared_filesystem.map(grant => `${grant.path} (${grant.access})`).join(", ") || "none"}.</p>
              <p>Provider connections: {pkg.connections.map(connection => `${connection.id} (${connection.provider}${connection.required ? ", required" : ""})`).join(", ") || "none"}.</p>
              {!pkg.is_requested && pkg.installed_state === "install_required" && (dependencyEntry
                ? <Button variant="secondary" disabled={reviewingInstall !== null || installing !== null} onClick={() => void reviewInstall(dependencyEntry)}>
                  {reviewingInstall === dependencyEntry.id ? "Verifying dependency…" : `Review ${pkg.extension_id}@${pkg.version}`}
                </Button>
                : <p role="alert">This exact release is not available in the Space catalog, so it cannot be installed from this screen.</p>)}
              {!pkg.is_requested && pkg.installed_state === "pin_conflict" && <p role="alert">Remove or resolve the conflicting installation before this package can be enabled.</p>}
              {!pkg.is_requested && pkg.installed_state === "installed_disabled" && <p role="status">Resume this exact release from its installed extension card, then refresh this package review.</p>}
              {!pkg.installable && <p role="alert">This package does not match the supported Space package installation contract.</p>}
            </section>;
          })}
          {review.unavailable_dependencies.map(item => <p key={`${item.extension_id}@${item.version}`} role="alert">{item.extension_id}@{item.version}: {item.error}</p>)}
          {!review.dependency_resolution.resolved && <p role="alert">Dependency closure cannot be verified: {review.dependency_resolution.error}.</p>}
          <p>Package price terms: not declared by the current contract.</p>
          {review.dependency_packages.some(pkg => pkg.installed_state === "install_required") && <p>Installing will add the exact missing dependencies listed above before the requested package. Dependencies receive no shared-folder grants; the requested package receives only the folders you selected.</p>}
          {review.ready_to_install && review.review_token
            ? <Button disabled={installing !== null || review.review_expires_at !== undefined && review.review_expires_at <= Date.now()} onClick={() => void install(entry)}>
              {installing === entry.id ? "Installing…" : "Install reviewed package"}
            </Button>
            : <p>Resolve paused or conflicting dependency installations, then refresh this review.</p>}
        </div>}
      </Card>;
    })}</div></section> : null}
    {!active && !loading && <section style={{ marginTop: 24, padding: 16, border: "1px solid var(--border, #ddd)", borderRadius: 10 }}>
      <h2>Import a signed package from another Space</h2>
      <p style={{ color: "var(--text3)", fontSize: 12 }}>An owner or admin in both Spaces can copy a verified release and its exact dependency closure. The destination must already trust each active publisher key. Import does not install or grant access.</p>
      <div style={{ display: "grid", gap: 8, maxWidth: 520 }}>
        <label>Source Space ID<input value={importSourceSpaceId} onChange={event => { setImportSourceSpaceId(event.target.value); setImportReview(null); }} /></label>
        <label>Extension ID<input value={importExtensionId} onChange={event => { setImportExtensionId(event.target.value); setImportReview(null); }} placeholder="ext_example" /></label>
        <label>Release version<input value={importVersion} onChange={event => { setImportVersion(event.target.value); setImportReview(null); }} placeholder="1.2.3" /></label>
        <Button variant="secondary" disabled={reviewingImport || importingPackage || !importSourceSpaceId.trim() || !importExtensionId.trim() || !importVersion.trim()}
          onClick={() => void reviewImport()}>{reviewingImport ? "Verifying source package…" : importReview ? "Refresh import review" : "Review import"}</Button>
      </div>
      {importReview && <div role="status" style={{ marginTop: 12, padding: 12, border: "1px solid var(--border, #ddd)", borderRadius: 8, fontSize: 12 }}>
        <strong>Verified release closure · {importReview.source_space_id} → {importReview.destination_space_id}</strong>
        <p>Review is read only. Every package signature and artifact digest was checked; destination trust was checked for each exact active publisher key. Nothing has been copied yet.</p>
        {importReview.packages.map(pkg => <p key={`${pkg.extension_id}@${pkg.version}`}>{pkg.extension_id}@{pkg.version} · publisher {pkg.publisher_id} · key {pkg.publisher_key_id} · manifest SHA-256 {pkg.manifest_sha256} · artifact SHA-256 {pkg.artifact_sha256}</p>)}
        <p>Import copies release artifacts and immutable release metadata. It does not install packages, enable them, or grant shared-folder access. Installation remains a separate review and approval step.</p>
        <Button disabled={importingPackage || importReview.expires_at <= Date.now()} onClick={() => void importReviewedPackage()}>
          {importingPackage ? "Copying verified packages…" : "Import reviewed package closure"}
        </Button>
      </div>}
      {importCompleted && <p role="status">Imported package releases: {importCompleted.join(", ")}. Review and install them from Available Space extensions.</p>}
    </section>}
    {!active && !loading && !error && !apps.length && !catalog.length ? <Card><CardTitle>No Space extensions available</CardTitle><CardDesc>Extensions included by an installed Space Template appear here. Each extension runs in its own scoped storage and receives only the host APIs it declares.</CardDesc></Card> : null}
  </div>;
}
