"use client";

import * as React from "react";
import type { ArchiveRewrapJob, SessionCredentials, SpaceArchiveRecord, SpaceArchiveRestore, SpaceArchiveRestorePreview } from "@/lib/api";
import { applySpaceArchiveRestore, exportSpaceArchive, getSpaceDataOps, previewSpaceArchiveRestore, resumeArchiveRewrap, startArchiveRewrap } from "@/lib/api";
import { clearPendingSpaceArchiveExportRequest, getOrCreateSpaceArchiveExportRequest, readPendingSpaceArchiveExportRequest, spaceArchiveExportRequestKey } from "@/lib/archive-export-request";

export function ArchiveKeyRotationPanel({ spaceId, session, canManage }: { spaceId: string; session: SessionCredentials | null; canManage: boolean }) {
  const [jobs, setJobs] = React.useState<ArchiveRewrapJob[]>([]);
  const [archives, setArchives] = React.useState<SpaceArchiveRecord[]>([]);
  const [restores, setRestores] = React.useState<SpaceArchiveRestore[]>([]);
  const [restorePreview, setRestorePreview] = React.useState<SpaceArchiveRestorePreview | null>(null);
  const [pendingExport, setPendingExport] = React.useState<{ key: string; requestId: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const exportRequestKey = session ? spaceArchiveExportRequestKey(spaceId, session.endUserId) : null;
  const refresh = React.useCallback(async () => {
    if (!session || !canManage) return;
    const result = await getSpaceDataOps(spaceId, session);
    setJobs(result.rewrap_jobs ?? []);
    setArchives(result.archives ?? []);
    setRestores(result.restores ?? []);
  }, [canManage, session, spaceId]);
  React.useEffect(() => { void refresh().catch((e) => setError(e instanceof Error ? e.message : "Could not load archive rotation jobs")); }, [refresh]);
  React.useEffect(() => {
    if (!session || !exportRequestKey) { setPendingExport(null); return; }
    try {
      const requestId = readPendingSpaceArchiveExportRequest(sessionStorage, spaceId, session.endUserId);
      setPendingExport(requestId ? { key: exportRequestKey, requestId } : null);
    } catch {
      setError("This browser could not read the saved archive request. No new archive was started.");
    }
  }, [exportRequestKey, session, spaceId]);

  const pendingExportRequestId = pendingExport?.key === exportRequestKey ? pendingExport.requestId : null;

  async function createFullArchive() {
    if (!session || !canManage || !exportRequestKey) return;
    const description = [
      "Create an encrypted snapshot of this Space's local database rows and supported R2 workspace/extension objects?",
      "The operation writes to R2. It does not capture other services, third-party provider data, or opaque Cloudflare Container snapshots.",
      "The encrypted archive manifest fails closed above 8 MiB plaintext. Limits are 10,000 rows per table, 5,000 object references, 16 MiB per object, and 64 MiB total captured object bytes. New larger captures use encrypted chunks; existing v1 archives remain readable.",
    ].join("\n\n");
    if (!window.confirm(description)) return;

    setBusy(true); setError(""); setMessage("");
    let requestId: string;
    try {
      requestId = getOrCreateSpaceArchiveExportRequest(sessionStorage, spaceId, session.endUserId);
      setPendingExport({ key: exportRequestKey, requestId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "A recoverable archive request could not be saved in this browser.");
      setBusy(false);
      return;
    }

    try {
      const result = await exportSpaceArchive(spaceId, session, requestId);
      setMessage(`Encrypted archive verified: ${result.archive_id} · ${result.plaintext_bytes?.toLocaleString() ?? "size recorded"} bytes${result.replayed ? " · recovered existing request" : result.resumed ? " · resumed upload" : ""}.`);
      try {
        clearPendingSpaceArchiveExportRequest(sessionStorage, spaceId, session.endUserId);
        setPendingExport(null);
      } catch {
        // The confirmed request ID remains safe to replay; the server returns the same verified archive.
        setPendingExport({ key: exportRequestKey, requestId });
        setMessage(`Archive ${result.archive_id} is verified. Its saved request ID could not be cleared, so a retry will return this same archive.`);
      }
      try { await refresh(); }
      catch { setError("The archive completed, but the archive list could not refresh. Reload this panel to view it."); }
    } catch (e) {
      setError(`${e instanceof Error ? e.message : "Archive export could not be confirmed."} The saved request ID is retained; retrying will resume or recover the same archive.`);
    } finally { setBusy(false); }
  }

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
      const insertedRows = Object.values(result.restored_counts).reduce((sum, count) => sum + count, 0);
      const skippedRows = Object.values(result.skipped_counts).reduce((sum, count) => sum + count, 0);
      setMessage(`Restore completed in merge mode. ${insertedRows} rows added, ${skippedRows} archived rows skipped by existing keys/constraints, ${result.restored_object_count} workspace objects verified; ${result.safety_actions.restored_event_triggers_inserted_disabled} restored event triggers were inserted disabled.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore could not complete. A partial restore can be resumed below.");
      await refresh().catch(() => undefined);
    } finally { setBusy(false); }
  }

  if (!session || !canManage) return null;
  return <section style={{ marginTop: 24 }}>
    <h3 className="settings-section-title">Space archives and key rotation</h3>
    <p className="settings-section-sub">Create encrypted Space-local snapshots and restore them as additive merges. Exports are resumable and retain a request ID in this browser until the server confirms the verified archive.</p>
    <div className="settings-block" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Encrypted Space archives</strong>
        <p style={{ margin: 0, color: "var(--text3)", fontSize: 12 }}>Full archives include supported SpaceDO rows and listed workspace/extension objects. They exclude other services, provider data and opaque Container snapshots. Limits: 8 MiB encrypted-manifest plaintext, 10,000 rows per table, 5,000 object references, 16 MiB per object and 64 MiB total captured object bytes. New larger captures use encrypted chunks; older archives remain readable.</p>
        <button type="button" disabled={busy} onClick={() => void createFullArchive()}>{busy ? "Working…" : pendingExportRequestId ? "Retry same full-archive request" : "Create encrypted full archive"}</button>
        <p style={{ margin: 0, color: "var(--text3)", fontSize: 12 }}>Restore is an additive merge, not a point-in-time rollback. Existing rows and objects remain. Archived event triggers are inserted disabled and require admin review before they can run.</p>
        {archives.filter(archive => archive.status === "verified").map(archive => <div key={archive.archive_id} className="settings-row" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <span style={{ flex: 1 }}>{archive.kind === "retention_messages" ? "Retention archive" : "Full archive"} · {new Date(archive.created_at).toLocaleString()} · {archive.plaintext_bytes.toLocaleString()} bytes</span>
          <button type="button" disabled={busy} onClick={() => void previewRestore(archive.archive_id)}>{busy ? "Working…" : "Review restore"}</button>
        </div>)}
        {archives.every(archive => archive.status !== "verified") && <span style={{ color: "var(--text3)", fontSize: 12 }}>No verified archives are available.</span>}
        {restorePreview && <div className="settings-block" style={{ display: "grid", gap: 8 }}>
          <strong style={{ fontSize: 12 }}>Review archive {restorePreview.archive_id.slice(0, 8)}</strong>
        <span style={{ color: "var(--text3)", fontSize: 12 }}>Merge mode · {restorePreview.object_references_verified} object references verified · {restorePreview.object_restore_required_count} missing objects need restoration · {restorePreview.safety_actions.archived_active_event_trigger_count} archived active event triggers will not be reactivated.</span>
        <span style={{ color: "var(--text3)", fontSize: 12 }}>Temporary database merge simulation ({new Date(restorePreview.merge_snapshot_at).toLocaleString()}): {Object.values(restorePreview.row_merge.would_insert).reduce((sum, count) => sum + count, 0)} rows would be added; {Object.values(restorePreview.row_merge.would_skip_by_constraints).reduce((sum, count) => sum + count, 0)} archived rows would be skipped by existing keys or constraints. Per table: {Object.entries(restorePreview.row_merge.would_insert).map(([table, count]) => `${table} +${count}/skip ${restorePreview.row_merge.would_skip_by_constraints[table] ?? 0}`).join(" · ") || "none"}.</span>
        <span style={{ color: "var(--text3)", fontSize: 11 }}>Preview runs in a rolled-back transaction; concurrent changes before apply can change these counts. Apply remains additive and keeps existing rows.</span>
          <span style={{ color: "var(--text3)", fontSize: 11 }}>Rows: {Object.entries(restorePreview.row_counts).map(([table, count]) => `${table} ${count}`).join(" · ") || "none"}</span>
          <button type="button" disabled={busy} onClick={() => void applyRestore(restorePreview.archive_id, restorePreview.preview_id)}>{busy ? "Restoring…" : "Apply reviewed restore"}</button>
        </div>}
        {restores.filter(restore => restore.status === "partial" || restore.status === "restoring").map(restore => <div key={restore.id} className="settings-row" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <span style={{ flex: 1 }}>Restore {restore.archive_id.slice(0, 8)} · {restore.status} · {restore.restored_object_count} objects verified · {Object.values(restore.row_counts).reduce((sum, count) => sum + count, 0)} rows added · {Object.values(restore.skipped_counts).reduce((sum, count) => sum + count, 0)} rows skipped{restore.last_error ? ` · ${restore.last_error}` : ""}</span>
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
