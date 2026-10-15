"use client";

import * as React from "react";
import type { ArchiveRewrapJob, SessionCredentials } from "@/lib/api";
import { getSpaceDataOps, resumeArchiveRewrap, startArchiveRewrap } from "@/lib/api";

export function ArchiveKeyRotationPanel({ spaceId, session, canManage }: { spaceId: string; session: SessionCredentials | null; canManage: boolean }) {
  const [jobs, setJobs] = React.useState<ArchiveRewrapJob[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const refresh = React.useCallback(async () => {
    if (!session || !canManage) return;
    const result = await getSpaceDataOps(spaceId, session);
    setJobs(result.rewrap_jobs ?? []);
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

  if (!session || !canManage) return null;
  return <section style={{ marginTop: 24 }}>
    <h3 className="settings-section-title">Archive key rotation</h3>
    <p className="settings-section-sub">Re-encrypt verified archives after configuring a new active SPACE_ARCHIVE_KEY. Rotation is resumable; keep the previous key available until completion.</p>
    <div className="settings-block" style={{ display: "grid", gap: 10 }}>
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
