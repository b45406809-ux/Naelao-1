"use client";

import * as React from "react";
import type { ArchiveRewrapJob, SessionCredentials, SpaceArchiveRecord, SpaceArchiveRestore, SpaceArchiveRestorePreview } from "@/lib/api";
import { applySpaceArchiveRestore, getSpaceDataOps, previewSpaceArchiveRestore, resumeArchiveRewrap, startArchiveRewrap } from "@/lib/api";

export function ArchiveKeyRotationPanel({ spaceId, session, canManage }: { spaceId: string; session: SessionCredentials | null; canManage: boolean }) {
  const [jobs, setJobs] = React.useState<ArchiveRewrapJob[]>([]);
  const [archives, setArchives] = React.useState<SpaceArchiveRecord[]>([]);
  const [restores, setRestores] = React.useState<SpaceArchiveRestore[]>([]);
  const [restorePreview, setRestorePreview] = React.useState<SpaceArchiveRestorePreview | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const refresh = React.useCallback(async () => {
    if (!session || !canManage) return;
    const result = await getSpaceDataOps(spaceId, session);
    setJobs(result.rewrap_jobs ?? []);
    setArchives(result.archives ?? []);
    setRestores(result.restores ?? []);
  }, [canManage, session, spaceId]);
  React.useEffect(() => { void refresh().catch((e) => setError(e instanceof Error ? e.message : "Could not load archive rotation jobs")); }, [refresh]);

  async function run(jobId?: string) {
    if (!session) return;
    if (!window.confirm("Re-encrypt this Space’s verified archives with the current SPACE_ARCHIVE_KEY? This may create R2 write operations; old copies are removed only after each replacement is verified. Keep the previous key configured until the job completes.")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const started = jobId ? { job_id: jobId } : await startArchiveRewrap(spaceId, session);
      let latest: ArchiveRewrapJob | null = null;
      for (let batch = 0; batch < 100; batch++) {
        latest = await resumeArchiveRewrap(spaceId, session, started.job_id);
        if (latest.status !== "active") break;
      }
      await refresh();
      setMessage(latest?.status === "completed" ? `Archive rotation complete: ${latest.rewrapped_count} rewritten across ${latest.scanned_count} archives.` : "Archive rotation paused safely. Resume it here to continue.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Archive rotation could not continue");
      await refresh().catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function previewRestore(archiveId: string) {
    if (!session) return;
    setBusy(true); setError(""); setMessage(""); setRestorePreview(null);
    try { setRestorePreview(await previewSpaceArchiveRestore(spaceId, session, archiveId)); }
    catch (e) { setError(e instanceof Error ? e.message : "Restore preview could not be created"); }
    finally { setBusy(false); }
  }

  async function applyRestore(archiveId: string, previewId: string) {
    if (!session) return;
    if (!window.confirm("Apply this encrypted archive as an additive merge? Existing rows and objects will remain. Newly restored event triggers will be paused until an admin reviews and re-enables them.")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await applySpaceArchiveRestore(spaceId, session, archiveId, previewId);
      setRestorePreview(null);
      setMessage(`Restore completed. ${result.restored_object_count} workspace objects verified; ${result.safety_actions.restored_event_triggers_inserted_disabled} restored event triggers were inserted disabled.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore could not complete. A partial restore can be resumed below.");
      await refresh().catch(() => undefined);
    } finally { setBusy(false); }
  }

  if (!session || !canManage) return null;
  return <section style={{ marginTop: 24 }}>
    <h3 className="settings-section-title">Archive key rotation</h3>
    <p className="settings-section-sub">Re-encrypt verified archives after configuring a new active SPACE_ARCHIVE_KEY. Rotation is resumable; keep the previous key available until completion.</p>
    <div className="settings-block" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Encrypted Space archives</strong>
        <p style={{ margin: 0, color: "var(--text3)", fontSize: 12 }}>Restore is an additive merge, not a point-in-time rollback. Existing rows and objects remain. Archived event triggers are inserted disabled and require admin review before they can run.</p>
        {archives.filter(archive => archive.status === "verified").map(archive => <div key={archive.archive_id} className="settings-row" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <span style={{ flex: 1 }}>{archive.kind === "retention_messages" ? "Retention archive" : "Full archive"} · {new Date(archive.created_at).toLocaleString()} · {archive.plaintext_bytes.toLocaleString()} bytes</span>
          <button type="button" disabled={busy} onClick={() => void previewRestore(archive.archive_id)}>{busy ? "Working…" : "Review restore"}</button>
        </div>)}
        {archives.every(archive => archive.status !== "verified") && <span style={{ color: "var(--text3)", fontSize: 12 }}>No verified archives are available.</span>}
        {restorePreview && <div className="settings-block" style={{ display: "grid", gap: 8 }}>
          <strong style={{ fontSize: 12 }}>Review archive {restorePreview.archive_id.slice(0, 8)}</strong>
          <span style={{ color: "var(--text3)", fontSize: 12 }}>Merge mode · {restorePreview.object_references_verified} object references verified · {restorePreview.object_restore_required_count} missing objects need restoration · {restorePreview.safety_actions.archived_active_event_trigger_count} archived active event triggers will not be reactivated.</span>
          <span style={{ color: "var(--text3)", fontSize: 11 }}>Rows: {Object.entries(restorePreview.row_counts).map(([table, count]) => `${table} ${count}`).join(" · ") || "none"}</span>
          <button type="button" disabled={busy} onClick={() => void applyRestore(restorePreview.archive_id, restorePreview.preview_id)}>{busy ? "Restoring…" : "Apply reviewed restore"}</button>
        </div>}
        {restores.filter(restore => restore.status === "partial" || restore.status === "restoring").map(restore => <div key={restore.id} className="settings-row" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <span style={{ flex: 1 }}>Restore {restore.archive_id.slice(0, 8)} · {restore.status} · {restore.restored_object_count} objects verified{restore.last_error ? ` · ${restore.last_error}` : ""}</span>
          <button type="button" disabled={busy} onClick={() => void applyRestore(restore.archive_id, restore.id)}>{busy ? "Working…" : "Resume restore"}</button>
        </div>)}
      </div>
      {jobs.map((job) => <div key={job.job_id} className="settings-row" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <span style={{ flex: 1 }}>Job {job.job_id.slice(0, 8)} · {job.scanned_count} scanned · {job.rewrapped_count} rewritten{job.last_error ? ` · Paused: ${job.last_error}` : ""}</span>
        <button type="button" disabled={busy} onClick={() => void run(job.job_id)}>{busy ? "Working…" : "Resume rotation"}</button>
      </div>)}
      <div className="settings-row" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <span style={{ flex: 1 }}>Verified archives are processed in small batches and verified before the old R2 object is deleted.</span>
        <button type="button" disabled={busy} onClick={() => void run()}>{busy ? "Working…" : "Start rotation"}</button>
      </div>
      {error && <p role="alert" style={{ color: "#b42318", fontSize: 12 }}>{error}</p>}
      {message && <p role="status" style={{ color: "var(--text3)", fontSize: 12 }}>{message}</p>}
    </div>
  </section>;
}
