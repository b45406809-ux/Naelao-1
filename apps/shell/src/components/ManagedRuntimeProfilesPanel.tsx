"use client";

import * as React from "react";
import {
  ApiError,
  getModalSandboxOperationStatus,
  getManagedRuntimeProfile,
  captureProjectMainPrivateState,
  getProjectMainRuntimeProfile,
  getProjectMainPrivateState,
  getWorkspaceRetentionPolicy,
  getSidecarRuntimeExecutionProfile,
  getSidecarArtifactTransfers,
  listContainerInstallations,
  resetManagedRuntimeProfile,
  restoreProjectMainPrivateState,
  saveProjectMainPrivateState,
  saveProjectMainRuntimeProfile,
  saveWorkspaceRetentionPolicy,
  saveSidecarRuntimeExecutionProfile,
  listProjectComputeAdmissions,
  cancelProjectComputeAdmission,
  listProjectRuntimeBudgetReservations,
  type ManagedRuntimeProfile,
  type ModalSandboxOperationStatus,
  type ProjectMainRuntimeProfile,
  type ProjectMainPrivateState,
  type SidecarRuntimeExecutionProfile,
  type SidecarArtifactTransferReceipt,
  type ProjectComputeAdmission,
  type ExpiredProjectComputeAdmission,
  type ProjectRuntimeBudgetReservation,
  type SessionCredentials,
  type WorkspaceRetentionPolicy,
} from "@/lib/api";
import { ProjectMainRestartRecipesEditor } from "@/components/ProjectMainRestartRecipesEditor";

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
  const [modalOperations, setModalOperations] = React.useState<ModalSandboxOperationStatus[] | null>(null);
  const [modalOperationsError, setModalOperationsError] = React.useState("");
  const [privateState, setPrivateState] = React.useState<ProjectMainPrivateState | null>(null);
  const [privateStateDraft, setPrivateStateDraft] = React.useState("");
  const [privateStateError, setPrivateStateError] = React.useState("");
  const [privateStateCaptureRequestId, setPrivateStateCaptureRequestId] = React.useState<string | null>(null);
  const [retentionPolicy, setRetentionPolicy] = React.useState<WorkspaceRetentionPolicy | null>(null);
  const [retentionDaysDraft, setRetentionDaysDraft] = React.useState("7");
  const [legalHoldDraft, setLegalHoldDraft] = React.useState(false);
  const [legalHoldExpiryDraft, setLegalHoldExpiryDraft] = React.useState("");
  const [retentionReasonDraft, setRetentionReasonDraft] = React.useState("");
  const [retentionError, setRetentionError] = React.useState("");
  const [branchDraft, setBranchDraft] = React.useState("");
  const [branchScope, setBranchScope] = React.useState("");
  const [computeAdmissions, setComputeAdmissions] = React.useState<ProjectComputeAdmission[]>([]);
  const [expiredComputeAdmissions, setExpiredComputeAdmissions] = React.useState<ExpiredProjectComputeAdmission[]>([]);
  const [computeAdmissionsError, setComputeAdmissionsError] = React.useState("");
  const [runtimeBudgetReservations, setRuntimeBudgetReservations] = React.useState<ProjectRuntimeBudgetReservation[]>([]);
  const [runtimeBudgetError, setRuntimeBudgetError] = React.useState("");

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    setMainProfile(null);
    setMainProfileDraft("");
    setMainProfileError("");
    setModalOperations(null);
    setModalOperationsError("");
    setComputeAdmissions([]);
    setComputeAdmissionsError("");
    setRuntimeBudgetReservations([]);
    setRuntimeBudgetError("");
    setPrivateState(null);
    setPrivateStateDraft("");
    setPrivateStateError("");
    setRetentionPolicy(null);
    setRetentionDaysDraft("7");
    setLegalHoldDraft(false);
    setLegalHoldExpiryDraft("");
    setRetentionReasonDraft("");
    setRetentionError("");
    try {
      const [inventory, savedMainProfile, savedRetentionPolicy, savedPrivateState, savedModalOperations, savedComputeAdmissions, savedRuntimeBudget] = await Promise.all([
        listContainerInstallations(spaceId, stableSession, projectId),
        getProjectMainRuntimeProfile(spaceId, projectId, stableSession).catch((failure) => {
          setMainProfileError(failure instanceof Error ? failure.message : "Main computer profile unavailable");
          return null;
        }),
        getWorkspaceRetentionPolicy(spaceId, projectId, stableSession).catch((failure) => {
          setRetentionError(failure instanceof Error ? failure.message : "Workspace retention policy unavailable");
          return null;
        }),
        getProjectMainPrivateState(spaceId, projectId, stableSession).catch((failure) => {
          setPrivateStateError(failure instanceof Error ? failure.message : "Private-state recovery settings unavailable");
          return null;
        }),
        getModalSandboxOperationStatus(spaceId, projectId, stableSession).catch((failure) => {
          setModalOperationsError(failure instanceof ApiError && failure.status === 403
            ? "Operation history is available to Project or Space owners and administrators."
            : "Saved Modal operation history is unavailable.");
          return null;
        }),
        listProjectComputeAdmissions(spaceId, projectId, stableSession).catch((failure) => {
          setComputeAdmissionsError(failure instanceof ApiError && failure.status === 403
            ? "Compute admission status is available to Space owners and administrators."
            : "Compute admission status is unavailable.");
          return null;
        }),
        listProjectRuntimeBudgetReservations(spaceId, projectId, stableSession).catch(() => {
          setRuntimeBudgetError("Runtime budget reservation history is unavailable.");
          return null;
        }),
      ]);
      const { installations } = inventory;
      if (savedMainProfile) {
        setMainProfile(savedMainProfile);
        setMainProfileDraft(savedMainProfile.profile);
        setMainProfileError("");
      }
      if (savedPrivateState) {
        setPrivateState(savedPrivateState);
        setPrivateStateDraft(savedPrivateState.paths.join("\n"));
        setPrivateStateError("");
      }
      if (savedModalOperations) {
        setModalOperations(savedModalOperations.operations);
        setModalOperationsError("");
      }
      if (savedComputeAdmissions) {
        setComputeAdmissions(savedComputeAdmissions.admissions);
        setComputeAdmissionsError("");
      }
      if (savedRuntimeBudget) {
        setRuntimeBudgetReservations(savedRuntimeBudget.reservations);
        setRuntimeBudgetError("");
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

  async function cancelComputeAdmission(admission: ProjectComputeAdmission) {
    if (busy || admission.status !== "waiting_for_capacity"
      || !window.confirm("Cancel this waiting execution? Its guest command has not started.")) return;
    setBusy(`compute-admission:${admission.execution_id}`);
    setNotice("");
    try {
      await cancelProjectComputeAdmission(spaceId, projectId, admission.execution_id, stableSession);
      setNotice("Waiting execution cancelled.");
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not cancel waiting execution"); }
    finally { setBusy(null); }
  }

  async function reloadComputeAdmissions() {
    if (busy) return;
    setBusy("compute-admissions-refresh");
    try {
      const current = await listProjectComputeAdmissions(spaceId, projectId, stableSession);
      setComputeAdmissions(current.admissions);
      setExpiredComputeAdmissions(current.expired);
      setComputeAdmissionsError("");
    } catch (error) {
      setComputeAdmissionsError(error instanceof ApiError && error.status === 403
        ? "Compute admission status is available to Space owners and administrators."
        : "Compute admission status is unavailable.");
    } finally { setBusy(null); }
  }

  async function reloadRuntimeBudgetReservations() {
    if (busy) return;
    setBusy("runtime-budget-refresh");
    try {
      const current = await listProjectRuntimeBudgetReservations(spaceId, projectId, stableSession);
      setRuntimeBudgetReservations(current.reservations);
      setRuntimeBudgetError("");
    } catch { setRuntimeBudgetError("Runtime budget reservation history is unavailable."); }
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

  function selectedPrivateStatePaths() {
    return privateStateDraft.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
  }

  async function savePrivateStateSelection() {
    if (!privateState || busy) return;
    setBusy("private-state-selection"); setNotice(""); setPrivateStateError("");
    try {
      const saved = await saveProjectMainPrivateState(spaceId, projectId, stableSession, {
        paths: selectedPrivateStatePaths(), expected_version: privateState.version,
      });
      setPrivateState(current => current ? { ...current, paths: saved.paths, version: saved.version } : current);
      setPrivateStateDraft(saved.paths.join("\n"));
      setNotice("Private-state selection saved. No files were read or uploaded.");
    } catch (error) { setPrivateStateError(error instanceof Error ? error.message : "Private-state selection could not be saved"); }
    finally { setBusy(null); }
  }

  async function capturePrivateState() {
    if (!privateState || busy || !privateState.paths.length || !privateState.backupAvailability.enabled || !privateState.runtimeEnabled) return;
    if (!window.confirm(`Encrypt and store up to ${privateState.paths.length} explicitly selected files from .naelao/private/? Files will be capped at 512 KiB total and retained for ${privateState.backupAvailability.retentionDays} days.`)) return;
    setBusy("private-state-capture"); setNotice(""); setPrivateStateError("");
    const requestId = privateStateCaptureRequestId ?? crypto.randomUUID();
    setPrivateStateCaptureRequestId(requestId);
    try {
      const saved = await captureProjectMainPrivateState(spaceId, projectId, stableSession, {
        request_id: requestId, expected_version: privateState.version,
      });
      setPrivateStateCaptureRequestId(null);
      setNotice(`Encrypted private-state backup ${saved.backup.backupId} recorded for generation ${saved.backup.allocationGeneration}.`);
      await refresh();
    } catch (error) { setPrivateStateError(error instanceof Error ? error.message : "Private-state backup failed"); }
    finally { setBusy(null); }
  }

  async function restorePrivateState(backupId: string) {
    if (busy || !window.confirm("Restore only selected files that are missing from .naelao/private/. Existing files will be preserved. Restore requires the same image and toolchain fingerprints and is blocked after project erasure.")) return;
    setBusy(`private-state-restore:${backupId}`); setNotice(""); setPrivateStateError("");
    try {
      const result = await restoreProjectMainPrivateState(spaceId, projectId, backupId, stableSession);
      setNotice(`Private-state recovery added ${result.restoredPaths.length} file(s) and preserved ${result.preservedPaths.length} existing file(s).`);
      await refresh();
    } catch (error) { setPrivateStateError(error instanceof Error ? error.message : "Private-state restore failed"); }
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
            {" "}{mainProfile.runtimeStatus.liveHealthVerified ? "Provider health verified." : "This control-plane record does not verify provider health or snapshot contents."}
            {mainProfile.runtimeStatus.budgetReservation ? <> Budget hold {mainProfile.runtimeStatus.budgetReservation.status.replaceAll("_", " ")}
              {mainProfile.runtimeStatus.budgetReservation.expiresAt ? ` until ${new Date(mainProfile.runtimeStatus.budgetReservation.expiresAt).toLocaleString()}` : ""}; this is an internal credit reservation, not a provider invoice.</> : " No runtime budget reservation is attached to this allocation."}</>}
    </div>}
    {mainProfile && <p style={{ color: "var(--text3)", fontSize: 12, margin: "0 0 12px" }}>
      {!mainProfile.snapshotRetention ? "No provider snapshot receipt is recorded. This does not establish whether older provider snapshots exist."
        : mainProfile.snapshotRetention.state === "ttl_elapsed_unverified"
          ? <>The last recorded provider snapshot passed its retention window on {new Date(mainProfile.snapshotRetention.expiresAt).toLocaleString()}; provider-side deletion is unverified.</>
          : <>{mainProfile.snapshotRetention.state === "erasure_notified" ? "Project erasure was sent to the runtime. "
            : mainProfile.snapshotRetention.state === "reference_dropped" ? "The local restore reference was removed. " : "A provider snapshot is recorded. "}
            Its recorded retention window ends {new Date(mainProfile.snapshotRetention.expiresAt).toLocaleString()}; provider-side deletion is not supported or verified.</>}
    </p>}
    {privateState && <div style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", padding: "12px 0", marginBottom: 12 }}>
      <div className="section-label" style={{ margin: "0 0 6px" }}>Encrypted private-state fallback</div>
      <p style={{ color: "var(--text3)", fontSize: 12, margin: "0 0 8px" }}>
        Select relative paths below <code>.naelao/private/</code>. These files stay outside canonical workspace sync. Do not select credentials, browser profiles, caches, or shared workspace files. Backups use the same project scope, jurisdiction and image/toolchain fingerprints; restore adds missing files and preserves files already present. Provider snapshots remain separate and cannot be physically purged through this interface.
      </p>
      <label htmlFor="project-main-private-state-paths" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Selected paths (one per line)</label>
      <textarea id="project-main-private-state-paths" rows={3} maxLength={8192} value={privateStateDraft} disabled={busy !== null}
        placeholder="settings/preferences.json" onChange={event => setPrivateStateDraft(event.target.value)} style={{ width: "100%", maxWidth: 560 }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null || privateStateCaptureRequestId !== null
          || privateStateDraft.split(/\r?\n/).map(path => path.trim()).filter(Boolean).join("\n") === privateState.paths.join("\n")}
          onClick={() => void savePrivateStateSelection()}>{busy === "private-state-selection" ? "Saving…" : "Save file selection"}</button>
        <span style={{ color: "var(--text3)", fontSize: 11 }}>Manifest revision {privateState.version} · {privateState.paths.length}/20 files selected · default is empty</span>
      </div>
      <p role="status" style={{ color: "var(--text3)", fontSize: 12, margin: "8px 0" }}>
        {privateState.backupAvailability.enabled
          ? `Encrypted backup is configured for ${privateState.backupAvailability.retentionDays} days with a ${Math.round(privateState.backupAvailability.quotaBytes / (1024 * 1024))} MiB per-Project quota.`
          : `Encrypted backup is unavailable: ${privateState.backupAvailability.reason}. Runtime rollout remains ${privateState.runtimeEnabled ? "deployment controlled" : "disabled"}.`}
      </p>
      {privateStateCaptureRequestId && <p role="status" style={{ color: "var(--text3)", fontSize: 11, margin: "0 0 8px" }}>
        The last capture response is unresolved. Retry capture with the same request ID before changing the selected paths.
      </p>}
      {privateState.paths.length > 0 && <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null || !privateState.backupAvailability.enabled || !privateState.runtimeEnabled}
        onClick={() => void capturePrivateState()}>{busy === "private-state-capture" ? "Encrypting…" : "Capture selected private state"}</button>}
      {privateState.backups.length > 0 && <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
        {privateState.backups.map(backup => <div key={backup.backupId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: 6, fontSize: 11 }}>
          <span>{new Date(backup.createdAt).toLocaleString()} · generation {backup.allocationGeneration} · {backup.fileCount} files · {backup.ciphertextBytes.toLocaleString()} encrypted bytes · expires {new Date(backup.expiresAt).toLocaleDateString()} · {backup.state}</span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null || backup.state !== "available" || !privateState.runtimeEnabled || !privateState.backupAvailability.enabled}
            onClick={() => void restorePrivateState(backup.backupId)}>{busy === `private-state-restore:${backup.backupId}` ? "Restoring…" : "Restore missing files"}</button>
        </div>)}
      </div>}
      {privateStateError && <p role="alert" style={{ color: "var(--danger,#b42318)", fontSize: 12, margin: "6px 0 0" }}>{privateStateError}</p>}
    </div>}
    {mainProfile && <ProjectMainRestartRecipesEditor spaceId={spaceId} projectId={projectId} session={stableSession} />}
    <div className="section-label" style={{ marginTop: 12 }}>GPU operation history</div>
    <p style={{ color: "var(--text3)", fontSize: 12, margin: "0 0 8px" }}>
      This owner/admin view reads saved operation records only and does not contact Modal. Modal GPU creation remains unavailable until usage reconciliation and customer pricing are approved.
    </p>
    {modalOperations ? modalOperations.length === 0
      ? <p role="status" style={{ color: "var(--text3)", fontSize: 12 }}>No Modal operation records.</p>
      : <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
        {modalOperations.map(operation => <div key={operation.operationId} style={{ borderTop: "1px solid var(--border)", paddingTop: 6, fontSize: 12 }}>
          <strong>{operation.state.replaceAll("_", " ")}</strong> · {operation.region} · revision {operation.revision}
          <div>Reserved: {operation.reservedCredits.toLocaleString()} credits · provider-reported usage: {operation.actualCredits === null ? "not recorded" : `${operation.actualCredits.toLocaleString()} credits`}
            {operation.overrunCredits !== null ? ` · overrun ${operation.overrunCredits.toLocaleString()} credits` : ""}</div>
          <div>Created {new Date(operation.createdAt).toLocaleString()} · updated {new Date(operation.updatedAt).toLocaleString()}
            {operation.errorCode ? ` · ${operation.errorCode}` : ""}</div>
        </div>)}
      </div>
      : modalOperationsError ? <p role="status" style={{ color: "var(--text3)", fontSize: 12 }}>{modalOperationsError}</p>
        : <p role="status" style={{ color: "var(--text3)", fontSize: 12 }}>Loading saved operation history…</p>}
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
    <div style={{ margin: "8px 0 18px" }}>
      <div className="section-label">Project compute admissions</div>
      <button type="button" className="btn btn-ghost btn-sm" style={{ marginBottom: 8 }} disabled={busy !== null || loading}
        onClick={() => void reloadComputeAdmissions()}>
        {busy === "compute-admissions-refresh" ? "Refreshing…" : "Refresh queue"}
      </button>
      <p style={{ color: "var(--text3)", fontSize: 13, margin: "0 0 8px" }}>
        Waiting entries contain no command text. A capacity reservation means a slot was assigned; it does not verify provider health or execution completion.
      </p>
      {computeAdmissionsError ? <p role="status" style={{ color: "var(--text3)", fontSize: 13 }}>{computeAdmissionsError}</p>
        : computeAdmissions.length === 0 ? <p style={{ color: "var(--text3)", fontSize: 13 }}>No current Project compute admissions.</p>
          : <div className="settings-block" aria-label="Project compute admissions">
            {computeAdmissions.map(admission => (
              <div className="settings-row" key={admission.execution_id}>
                <div>
                  <div className="settings-row-label">{admission.status === "waiting_for_capacity" ? "Waiting for capacity" : "Capacity reserved"}</div>
                  <div className="settings-row-sub">
                    Execution {admission.execution_id} · actor {admission.actor_id}
                    {admission.queue_position !== undefined ? ` · Project queue position ${admission.queue_position}` : ""}
                    · requested {new Date(admission.requested_at).toLocaleString()}
                  </div>
                </div>
                {admission.status === "waiting_for_capacity" && <button type="button" className="btn btn-secondary btn-sm"
                  disabled={busy !== null} onClick={() => void cancelComputeAdmission(admission)}>
                  {busy === `compute-admission:${admission.execution_id}` ? "Cancelling…" : "Cancel"}
                </button>}
              </div>
            ))}
          </div>}
      {!computeAdmissionsError && expiredComputeAdmissions.length > 0 && <div className="settings-block" aria-label="Expired Project compute admissions">
        {expiredComputeAdmissions.map(admission => <div className="settings-row" key={`expired:${admission.execution_id}`}>
          <div>
            <div className="settings-row-label">Admission expired</div>
            <div className="settings-row-sub">Execution {admission.execution_id} · actor {admission.actor_id} · expired {new Date(admission.expired_at).toLocaleString()}</div>
          </div>
        </div>)}
      </div>}
    </div>
    <div style={{ margin: "8px 0 18px" }}>
      <div className="section-label">Project runtime budget reservations</div>
      <p style={{ color: "var(--text3)", fontSize: 13, margin: "0 0 8px" }}>
        Amounts cover this Project's main runtime and active Project-bound sidecars. Personal member installations are omitted. These are internal plan credits, not provider invoices or USD estimates.
      </p>
      <button type="button" className="btn btn-ghost btn-sm" style={{ marginBottom: 8 }} disabled={busy !== null || loading}
        onClick={() => void reloadRuntimeBudgetReservations()}>
        {busy === "runtime-budget-refresh" ? "Refreshing…" : "Refresh reservations"}
      </button>
      {runtimeBudgetError ? <p role="status" style={{ color: "var(--text3)", fontSize: 13 }}>{runtimeBudgetError}</p>
        : runtimeBudgetReservations.length === 0 ? <p style={{ color: "var(--text3)", fontSize: 13 }}>No Project runtime budget reservations are recorded.</p>
          : <div className="settings-block" aria-label="Project runtime budget reservations">
            {runtimeBudgetReservations.map(reservation => (
              <div className="settings-row" key={reservation.reservationId}>
                <div>
                  <div className="settings-row-label">{reservation.runtimeKind === "project_sidecar"
                    ? `Sidecar ${reservation.installationId ?? "(installation unknown)"}` : "Main runtime"} · {reservation.status.replaceAll("_", " ")} · {reservation.reservedCredits} reserved credits</div>
                  <div className="settings-row-sub">
                    {reservation.chargedCredits === null ? "No settled usage receipt" : `${reservation.chargedCredits} charged credits`}
                    {` · created ${new Date(reservation.createdAt).toLocaleString()}`}
                    {` · expires ${new Date(reservation.expiresAt).toLocaleString()}`}
                  </div>
                </div>
              </div>
            ))}
          </div>}
    </div>
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
