"use client";

import * as React from "react";
import {
  getManagedRuntimeProfile,
  listContainerInstallations,
  resetManagedRuntimeProfile,
  type ManagedRuntimeProfile,
  type SessionCredentials,
} from "@/lib/api";

type ProfileRow = { installationId: string; extensionName: string; containerId: string; branch?: string; profile?: ManagedRuntimeProfile; error?: string };

/** Shows the provider-backed state of installed project containers. This is a whole-container
 * checkpoint/reset control; it does not claim to migrate or health-check app-specific profiles. */
export function ManagedRuntimeProfilesPanel({ spaceId, projectId, session }: { spaceId: string; projectId: string; session: SessionCredentials }) {
  const stableSession = React.useMemo(() => session, [session.sessionToken, session.endUserId]);
  const [rows, setRows] = React.useState<ProfileRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState("");

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const { installations } = await listContainerInstallations(spaceId, stableSession, projectId);
      const targets = installations.filter(({ instance }) => instance.status === "active" && instance.project_id === projectId)
        .flatMap(({ instance, manifest }) => {
          const ids = new Set<string>();
          for (const primitive of manifest.bundle?.primitives ?? []) if (primitive.kind === "container" && primitive.id) ids.add(primitive.id);
          for (const container of manifest.containers ?? []) if (container.id) ids.add(container.id);
          return [...ids].map(containerId => ({ installationId: instance.instance_id ?? "", extensionName: manifest.name ?? manifest.id ?? "Installed extension", containerId }));
        }).filter(target => target.installationId);
      const profiles = await Promise.all(targets.map(async target => {
        try { return { ...target, profile: await getManagedRuntimeProfile(spaceId, projectId, target.installationId, target.containerId, stableSession) }; }
        catch (error) { return { ...target, error: error instanceof Error ? error.message : "Profile status unavailable" }; }
      }));
      setRows(profiles);
    } catch {
      setLoadError(true);
      setRows([]);
    } finally { setLoading(false); }
  }, [spaceId, projectId, stableSession]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  async function reset(row: ProfileRow) {
    const key = `${row.installationId}:${row.containerId}`;
    if (busy || !window.confirm(`Reset all runtime state for ${row.extensionName} / ${row.containerId}? This stops the container and deletes its saved checkpoint. Workspace files outside the container are not changed.`)) return;
    setBusy(key); setNotice("");
    try {
      await resetManagedRuntimeProfile(spaceId, projectId, row.installationId, row.containerId, stableSession, row.branch);
      setNotice("Runtime state reset.");
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Runtime reset failed"); }
    finally { setBusy(null); }
  }

  return <section className="settings-block" style={{ marginTop: 24, padding: 16 }}>
    <div className="section-label" style={{ marginTop: 0 }}>Managed runtime state</div>
    <p style={{ color: "var(--text3)", fontSize: 13, margin: "0 0 12px" }}>
      Inspect installed project containers and reset their saved container checkpoint. App-specific login profiles and cross-provider restore are not managed here.
    </p>
    {loading ? <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading runtime state…</p>
      : loadError ? <p style={{ color: "var(--text3)", fontSize: 13 }}>Runtime inventory is unavailable. Check the deployed container configuration.</p>
      : rows.length === 0 ? <p style={{ color: "var(--text3)", fontSize: 13 }}>No active project containers are installed.</p>
      : <div style={{ display: "grid", gap: 10 }}>{rows.map(row => {
        const key = `${row.installationId}:${row.containerId}`;
        return <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: 12, border: "1px solid var(--border)", borderRadius: 10 }}>
          <div style={{ minWidth: 0 }}>
            <strong style={{ fontSize: 13 }}>{row.extensionName} · {row.containerId}</strong>
            {row.error ? <div style={{ color: "var(--text3)", fontSize: 12, marginTop: 4 }}>{row.error}</div> : row.profile && <div style={{ color: "var(--text3)", fontSize: 12, marginTop: 4 }}>
              State: {row.profile.state}{row.profile.checkpoint_created_at ? ` · checkpoint ${new Date(row.profile.checkpoint_created_at).toLocaleString()}` : ""}{row.profile.enabled ? " · snapshots enabled" : " · snapshots disabled by deployment"}
            </div>}
          </div>
          <button className="btn btn-secondary btn-sm" disabled={!row.profile || busy !== null} onClick={() => void reset(row)}>
            {busy === key ? "Resetting…" : "Reset runtime state"}
          </button>
        </div>;
      })}</div>}
    {notice && <p role="status" style={{ color: "var(--text2)", fontSize: 12, margin: "10px 0 0" }}>{notice}</p>}
    <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => void refresh()} disabled={loading || busy !== null}>Refresh status</button>
  </section>;
}
