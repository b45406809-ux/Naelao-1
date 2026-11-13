"use client";

import * as React from "react";
import {
  getManagedRuntimeProfile,
  getProjectMainRuntimeProfile,
  getWorkspaceRetentionPolicy,
  getSidecarRuntimeExecutionProfile,
  getSidecarArtifactTransfers,
  listContainerInstallations,
  resetManagedRuntimeProfile,
  saveProjectMainRuntimeProfile,
  saveWorkspaceRetentionPolicy,
  saveSidecarRuntimeExecutionProfile,
  type ManagedRuntimeProfile,
  type ProjectMainRuntimeProfile,
  type SidecarRuntimeExecutionProfile,
  type SidecarArtifactTransferReceipt,
  type SessionCredentials,
  type WorkspaceRetentionPolicy,
} from "@/lib/api";

type ProfileRow = { installationId: string; extensionName: string; containerId: string; branch?: string; profile?: ManagedRuntimeProfile; error?: string;
  executionProfile?: SidecarRuntimeExecutionProfile; executionProfileDraft?: number; executionProfileError?: string;
  transfers?: SidecarArtifactTransferReceipt[]; transferError?: string };

function asLocalDateTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Shows the provider-backed state of installed project containers. This is a whole-container
 * checkpoint/reset control; it does not claim to migrate or health-check app-specific profiles. */
export function ManagedRuntimeProfilesPanel({ spaceId, projectId, session }: { spaceId: string; projectId: string; session: SessionCredentials }) {
  const stableSession = React.useMemo(() => session, [session.sessionToken, session.endUserId]);
  const [rows, setRows] = React.useState<ProfileRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState("");
  const [mainProfile, setMainProfile] = React.useState<ProjectMainRuntimeProfile | null>(null);
  const [mainProfileDraft, setMainProfileDraft] = React.useState<ProjectMainRuntimeProfile["profile"] | "">("");
  const [mainProfileError, setMainProfileError] = React.useState("");
  const [retentionPolicy, setRetentionPolicy] = React.useState<WorkspaceRetentionPolicy | null>(null);
  const [retentionDaysDraft, setRetentionDaysDraft] = React.useState("7");
  const [legalHoldDraft, setLegalHoldDraft] = React.useState(false);
  const [legalHoldExpiryDraft, setLegalHoldExpiryDraft] = React.useState("");
  const [retentionReasonDraft, setRetentionReasonDraft] = React.useState("");
  const [retentionError, setRetentionError] = React.useState("");
  const [branchDraft, setBranchDraft] = React.useState("");
  const [branchScope, setBranchScope] = React.useState("");

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    setMainProfile(null);
    setMainProfileDraft("");
    setMainProfileError("");
    setRetentionPolicy(null);
    setRetentionDaysDraft("7");
    setLegalHoldDraft(false);
    setLegalHoldExpiryDraft("");
    setRetentionReasonDraft("");
    setRetentionError("");
    try {
      const [inventory, savedMainProfile, savedRetentionPolicy] = await Promise.all([
        listContainerInstallations(spaceId, stableSession, projectId),
        getProjectMainRuntimeProfile(spaceId, projectId, stableSession).catch((failure) => {
          setMainProfileError(failure instanceof Error ? failure.message : "Main computer profile unavailable");
          return null;
        }),
        getWorkspaceRetentionPolicy(spaceId, projectId, stableSession).catch((failure) => {
          setRetentionError(failure instanceof Error ? failure.message : "Workspace retention policy unavailable");
          return null;
        }),
      ]);
      const { installations } = inventory;
      if (savedMainProfile) {
        setMainProfile(savedMainProfile);
        setMainProfileDraft(savedMainProfile.profile);
        setMainProfileError("");
      }
      if (savedRetentionPolicy) {
        setRetentionPolicy(savedRetentionPolicy);
        setRetentionDaysDraft(String(savedRetentionPolicy.stagingRetentionDays));
        setLegalHoldDraft(Boolean(savedRetentionPolicy.legalHold
          && (!savedRetentionPolicy.legalHold.expiresAt || Date.parse(savedRetentionPolicy.legalHold.expiresAt) > Date.now())));
        setLegalHoldExpiryDraft(asLocalDateTime(savedRetentionPolicy.legalHold?.expiresAt));
      }
      const targets = installations.filter(({ instance }) => instance.status === "active" && instance.project_id === projectId)
        .flatMap(({ instance, manifest }) => {
          const ids = new Set<string>();
          for (const primitive of manifest.bundle?.primitives ?? []) if (primitive.kind === "container" && primitive.id) ids.add(primitive.id);
          for (const container of manifest.containers ?? []) if (container.id) ids.add(container.id);
          return [...ids].map(containerId => ({ installationId: instance.instance_id ?? "", extensionName: manifest.name ?? manifest.id ?? "Installed extension", containerId }));
        }).filter(target => target.installationId);
      const profiles = await Promise.all(targets.map(async target => {
        const branch = branchScope || undefined;
        const [runtime, execution, transfers] = await Promise.allSettled([
          getManagedRuntimeProfile(spaceId, projectId, target.installationId, target.containerId, stableSession, branch),
          getSidecarRuntimeExecutionProfile(spaceId, projectId, target.installationId, target.containerId, stableSession),
          getSidecarArtifactTransfers(spaceId, projectId, target.installationId, target.containerId, stableSession, branch),
        ]);
        return {
          ...target, ...(branch ? { branch } : {}),
          ...(runtime.status === "fulfilled" ? { profile: runtime.value } : { error: runtime.reason instanceof Error ? runtime.reason.message : "Runtime status unavailable" }),
          ...(execution.status === "fulfilled" ? { executionProfile: execution.value, executionProfileDraft: execution.value.maxExecutionSeconds }
            : { executionProfileError: execution.reason instanceof Error ? execution.reason.message : "Execution limit unavailable" }),
          ...(transfers.status === "fulfilled" ? { transfers: transfers.value.transfers }
            : { transferError: transfers.reason instanceof Error ? transfers.reason.message : "Artifact transfer status unavailable" }),
        };
      }));
      setRows(profiles);
    } catch {
      setLoadError(true);
      setRows([]);
    } finally { setLoading(false); }
  }, [spaceId, projectId, stableSession, branchScope]);

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

  async function saveMainProfile() {
    if (!mainProfile || !mainProfileDraft || busy) return;
    setBusy("main-profile"); setNotice(""); setMainProfileError("");
    try {
      const saved = await saveProjectMainRuntimeProfile(spaceId, projectId, stableSession, {
        profile: mainProfileDraft, expected_version: mainProfile.version,
      });
      setMainProfile(saved);
      setNotice(saved.runtimeEnabled ? "Main computer profile saved for new allocations." : "Main computer profile saved; runtime allocation remains disabled on this deployment.");
    } catch (error) { setMainProfileError(error instanceof Error ? error.message : "Main computer profile could not be saved"); }
    finally { setBusy(null); }
  }

  async function saveRetentionPolicy() {
    const days = Number(retentionDaysDraft);
    if (!Number.isSafeInteger(days) || days < 7 || days > 3650) {
      setRetentionError("Staging retention must be a whole number from 7 to 3650 days.");
      return;
    }
    if (retentionReasonDraft.trim().length < 10 || retentionReasonDraft.trim().length > 500) {
      setRetentionError("Add an audit reason of 10 to 500 characters for this policy change.");
      return;
    }
    if (retentionPolicy?.legalHold && !legalHoldDraft
      && (!retentionPolicy.legalHold.expiresAt || Date.parse(retentionPolicy.legalHold.expiresAt) > Date.now())
      && !window.confirm("Release the active legal hold? This resumes eligible workspace cleanup and permits project erasure admission.")) return;
    const expiry = legalHoldExpiryDraft ? new Date(legalHoldExpiryDraft) : null;
    if (expiry && !Number.isFinite(expiry.getTime())) {
      setRetentionError("Choose a valid hold expiry date and time.");
      return;
    }
    setBusy("retention-policy"); setRetentionError(""); setNotice("");
    try {
      const saved = await saveWorkspaceRetentionPolicy(spaceId, projectId, stableSession, {
        stagingRetentionDays: days,
        legalHold: legalHoldDraft,
        ...(legalHoldDraft && expiry ? { legalHoldExpiresAt: expiry.toISOString() } : {}),
        reason: retentionReasonDraft.trim(),
      });
      setRetentionPolicy(saved);
      setRetentionDaysDraft(String(saved.stagingRetentionDays));
      setLegalHoldDraft(Boolean(saved.legalHold
        && (!saved.legalHold.expiresAt || Date.parse(saved.legalHold.expiresAt) > Date.now())));
      setLegalHoldExpiryDraft(asLocalDateTime(saved.legalHold?.expiresAt));
      setRetentionReasonDraft("");
      setNotice("Workspace retention policy saved and audited.");
    } catch (error) {
      setRetentionError(error instanceof Error ? error.message : "Workspace retention policy could not be saved.");
    } finally { setBusy(null); }
  }

  async function saveSidecarExecutionProfile(row: ProfileRow) {
    if (!row.executionProfile || row.executionProfileDraft === undefined || busy) return;
    const key = `${row.installationId}:${row.containerId}:execution`;
    setBusy(key); setNotice("");
    try {
      const saved = await saveSidecarRuntimeExecutionProfile(spaceId, projectId, row.installationId, row.containerId, stableSession, {
        max_execution_seconds: row.executionProfileDraft, expected_version: row.executionProfile.version,
      });
      setRows(current => current.map(item => {
        if (item.installationId !== row.installationId || item.containerId !== row.containerId) return item;
        const updated = { ...item, executionProfile: saved, executionProfileDraft: saved.maxExecutionSeconds };
        delete updated.executionProfileError;
        return updated;
      }));
      setNotice(`Execution limit saved for new runs of ${row.extensionName} / ${row.containerId}.`);
    } catch (error) {
      setRows(current => current.map(item => item.installationId === row.installationId && item.containerId === row.containerId
        ? { ...item, executionProfileError: error instanceof Error ? error.message : "Execution limit could not be saved" } : item));
    } finally { setBusy(null); }
  }

  return <section className="settings-block" style={{ marginTop: 24, padding: 16 }}>
    <div className="section-label" style={{ marginTop: 0 }}>Project main computer</div>
    <p style={{ color: "var(--text3)", fontSize: 13, margin: "0 0 12px" }}>
      Choose an approved Cloudflare size for future main-computer allocations. Provider and image remain deployment controlled; the plan sets the maximum size.
    </p>
    {mainProfile ? <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
      <label htmlFor="project-main-runtime-profile">Runtime size</label>
      <select id="project-main-runtime-profile" value={mainProfileDraft || mainProfile.profile}
        onChange={(event) => setMainProfileDraft(event.target.value as ProjectMainRuntimeProfile["profile"])} disabled={busy !== null}>
        {!mainProfile.allowedProfiles.includes(mainProfile.profile) && <option value={mainProfile.profile}>{mainProfile.profile} · above current plan limit</option>}
        {mainProfile.allowedProfiles.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
      </select>
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null || !mainProfileDraft
        || !mainProfile.allowedProfiles.includes(mainProfileDraft) || mainProfileDraft === mainProfile.profile} onClick={() => void saveMainProfile()}>
        {busy === "main-profile" ? "Saving…" : "Save main profile"}
      </button>
      <span style={{ color: "var(--text3)", fontSize: 12 }}>{mainProfile.runtimeEnabled ? "Applies to new allocations." : "Saved preference; runtime allocation is disabled here."}</span>
    </div> : mainProfileError ? <p role="status" style={{ color: "var(--text3)", fontSize: 13 }}>{mainProfileError}</p>
      : <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading project profile…</p>}
    {mainProfile && <div role="status" aria-live="polite" style={{ color: "var(--text3)", fontSize: 12, margin: "0 0 12px" }}>
      <strong>Last recorded main-runtime state: </strong>
      {mainProfile.runtimeStatus === undefined ? "unavailable from this server."
        : !mainProfile.runtimeStatus ? "no allocation is recorded in the control-plane registry."
          : <>{mainProfile.runtimeStatus.state.replaceAll("_", " ")} · generation {mainProfile.runtimeStatus.allocationGeneration}
            {mainProfile.runtimeStatus.lastSeenAt ? ` · last seen ${new Date(mainProfile.runtimeStatus.lastSeenAt).toLocaleString()}` : ""}.
            {" "}{mainProfile.runtimeStatus.liveHealthVerified ? "Provider health verified." : "This control-plane record does not verify provider health or snapshot contents."}</>}
    </div>}
    {mainProfile && <p style={{ color: "var(--text3)", fontSize: 12, margin: "0 0 12px" }}>
      {!mainProfile.snapshotRetention ? "No provider snapshot receipt is recorded. This does not establish whether older provider snapshots exist."
        : mainProfile.snapshotRetention.state === "ttl_elapsed_unverified"
          ? <>The last recorded provider snapshot passed its retention window on {new Date(mainProfile.snapshotRetention.expiresAt).toLocaleString()}; provider-side deletion is unverified.</>
          : <>{mainProfile.snapshotRetention.state === "erasure_notified" ? "Project erasure was sent to the runtime. "
            : mainProfile.snapshotRetention.state === "reference_dropped" ? "The local restore reference was removed. " : "A provider snapshot is recorded. "}
            Its recorded retention window ends {new Date(mainProfile.snapshotRetention.expiresAt).toLocaleString()}; provider-side deletion is not supported or verified.</>}
    </p>}
    <div className="section-label">Workspace retention and legal hold</div>
    <p style={{ color: "var(--text3)", fontSize: 13, margin: "0 0 12px" }}>
      This project policy controls staged-artifact cleanup and canonical workspace-content collection, and an active hold blocks project-erasure admission. It does not retain or delete opaque Cloudflare Container snapshots or third-party backups; snapshot export, extension and physical purge are unsupported or unverified.
    </p>
    {retentionPolicy ? <div style={{ display: "grid", gap: 9, maxWidth: 560 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span>Staging retention (7–3650 days)</span>
        <input aria-label="Staging retention days" type="number" min={7} max={3650} step={1} value={retentionDaysDraft}
          disabled={busy !== null} onChange={event => setRetentionDaysDraft(event.target.value)} />
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input aria-label="Legal hold active" type="checkbox" checked={legalHoldDraft} disabled={busy !== null}
          onChange={event => setLegalHoldDraft(event.target.checked)} />
        Preserve eligible workspace content under an owner-attributed legal hold
      </label>
      {legalHoldDraft && <label style={{ display: "grid", gap: 4 }}>
        <span>Optional hold expiry</span>
        <input aria-label="Legal hold expiry" type="datetime-local" value={legalHoldExpiryDraft} disabled={busy !== null}
          onChange={event => setLegalHoldExpiryDraft(event.target.value)} />
      </label>}
      <label style={{ display: "grid", gap: 4 }}>
        <span>Audit reason for this change</span>
        <textarea aria-label="Retention policy reason" minLength={10} maxLength={500} rows={2} value={retentionReasonDraft}
          disabled={busy !== null} onChange={event => setRetentionReasonDraft(event.target.value)} />
      </label>
      {retentionPolicy.legalHold && <p style={{ color: "var(--text3)", fontSize: 12, margin: 0 }}>
        {retentionPolicy.legalHold.expiresAt && Date.parse(retentionPolicy.legalHold.expiresAt) <= Date.now() ? "The recorded legal hold has expired. " : "An owner-attributed legal hold is recorded. "}
        {retentionPolicy.legalHold.reason} · set by {retentionPolicy.legalHold.actorId}{retentionPolicy.legalHold.expiresAt ? ` · expires ${new Date(retentionPolicy.legalHold.expiresAt).toLocaleString()}` : " · no expiry"}
      </p>}
      {retentionError && <p role="alert" style={{ color: "var(--danger,#b42318)", fontSize: 12, margin: 0 }}>{retentionError}</p>}
      <div><button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null || !retentionReasonDraft.trim()}
        onClick={() => void saveRetentionPolicy()}>{busy === "retention-policy" ? "Saving…" : "Save retention policy"}</button></div>
    </div> : <p role="status" style={{ color: "var(--text3)", fontSize: 13 }}>{retentionError || "Loading workspace retention policy…"}</p>}
    <div className="section-label" style={{ marginTop: 0 }}>Managed runtime state</div>
    <p style={{ color: "var(--text3)", fontSize: 13, margin: "0 0 12px" }}>
      Set a per-container execution ceiling within the image limit and inspect or reset saved container state. Changes affect new executions; they do not interrupt a run already admitted.
    </p>
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 12 }}>
      Workspace branch for runtime and transfer receipts
      <input value={branchDraft} maxLength={160} placeholder="Default branch" disabled={busy !== null}
        onChange={event => setBranchDraft(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") setBranchScope(branchDraft.trim()); }} />
    </label>
    <button type="button" className="btn btn-ghost btn-sm" style={{ margin: "0 0 10px 8px" }} disabled={busy !== null || loading}
      onClick={() => setBranchScope(branchDraft.trim())}>Load branch status</button>
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
            {row.executionProfile ? <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <label htmlFor={`sidecar-execution-${key}`} style={{ fontSize: 12 }}>Maximum run time</label>
              <select id={`sidecar-execution-${key}`} value={row.executionProfileDraft ?? row.executionProfile.maxExecutionSeconds}
                disabled={busy !== null} onChange={event => setRows(current => current.map(item => item.installationId === row.installationId && item.containerId === row.containerId
                  ? { ...item, executionProfileDraft: Number(event.target.value) } : item))}>
                {[1, 5, 10, 15, 30, row.executionProfile.maximumSeconds].filter((value, index, values) => value <= row.executionProfile!.maximumSeconds && values.indexOf(value) === index).map(value =>
                  <option key={value} value={value}>{value} seconds{value === row.executionProfile!.maximumSeconds ? " · image limit" : ""}</option>)}
              </select>
              <button className="btn btn-secondary btn-sm" disabled={busy !== null || row.executionProfileDraft === row.executionProfile.maxExecutionSeconds}
                onClick={() => void saveSidecarExecutionProfile(row)}>{busy === `${row.installationId}:${row.containerId}:execution` ? "Saving…" : "Save limit"}</button>
              <span style={{ color: "var(--text3)", fontSize: 11 }}>Maximum {row.executionProfile.maximumSeconds}s from the approved image</span>
            </div> : row.executionProfileError && <div style={{ color: "var(--text3)", fontSize: 12, marginTop: 8 }}>{row.executionProfileError}</div>}
            {row.transferError ? <div role="status" style={{ color: "var(--text3)", fontSize: 12, marginTop: 8 }}>Transfer receipts unavailable: {row.transferError}</div>
              : <details style={{ marginTop: 8, fontSize: 12 }}>
                <summary>{row.transfers?.length ?? 0} recent artifact transfers (owner/admin)</summary>
                {row.transfers?.length ? <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                  {row.transfers.map(receipt => {
                    const conflict = receipt.status === "conflicted" || receipt.publicationStatus === "conflicted";
                    const pending = receipt.status === "dispatching" || receipt.status === "indeterminate" || receipt.publicationStatus === "pending";
                    const digest = receipt.result?.digest;
                    return <div key={receipt.requestId} style={{ borderTop: "1px solid var(--border)", paddingTop: 7 }}>
                      <strong>{receipt.direction} · {conflict ? "needs review" : pending ? "outcome pending" : receipt.status}</strong>
                      <div>Request ID: {receipt.requestId}</div>
                      <div>{receipt.path}{receipt.workspacePath ? ` → ${receipt.workspacePath}` : ""} · {new Date(receipt.updatedAt).toLocaleString()}</div>
                      {digest && <div>Artifact SHA-256: {digest} · {receipt.result?.bytes ?? 0} bytes</div>}
                      {receipt.expectedHash !== undefined && <div>Expected workspace revision: {receipt.expectedHash ?? "absent"}</div>}
                      {receipt.currentHash !== undefined && <div>Observed sidecar revision: {receipt.currentHash ?? "absent"}</div>}
                      {receipt.errorCode && <div>Recorded outcome: {receipt.errorCode}</div>}
                      {conflict && <div role="status">{receipt.direction === "export"
                        ? "The immutable artifact remains staged. The workspace file was not overwritten; review the current file before retrying with a new request ID."
                        : "The sidecar destination file was preserved. Review its current revision before retrying with a new request ID."}</div>}
                      {pending && <div role="status">The durable receipt does not confirm the final outcome. Inspect the destination before retrying.</div>}
                    </div>;
                  })}
                </div> : <p style={{ color: "var(--text3)" }}>No recent sidecar artifact transfers for this branch.</p>}
              </details>}
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
