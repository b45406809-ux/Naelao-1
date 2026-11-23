"use client";

import * as React from "react";
import type { ProjectJournalDecision, ProjectJournalDecisionRegister, SessionCredentials } from "@/lib/api";
import { listProjectJournalDecisions, reviewProjectJournalDecision } from "@/lib/api";
import { ApiError } from "@/lib/request";

export function ProjectDecisionReviewPanel({ spaceId, projectId, session }: {
  spaceId: string;
  projectId: string;
  session: SessionCredentials;
}) {
  const [register, setRegister] = React.useState<ProjectJournalDecisionRegister | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busyDecisionId, setBusyDecisionId] = React.useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = React.useState<Record<string, string>>({});
  const [supersessions, setSupersessions] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");

  const refresh = React.useCallback(async () => {
    try {
      const current = await listProjectJournalDecisions(spaceId, projectId, session);
      setRegister(current);
      setError("");
    } catch {
      setError("Project decisions could not be loaded. Check your Project access and reload.");
    } finally { setLoading(false); }
  }, [spaceId, projectId, session]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  async function review(decision: ProjectJournalDecision, outcome: "approve" | "reject") {
    if (busyDecisionId) return;
    const supersedes = supersessions[decision.id] ?? "";
    const activeSameTopic = register?.decisions.filter(item => item.status === "active" && item.topicKey === decision.topicKey) ?? [];
    if (outcome === "approve" && activeSameTopic.length > 0 && !activeSameTopic.some(item => item.id === supersedes)) {
      setError("Choose the exact active decision this proposal replaces.");
      return;
    }
    setBusyDecisionId(decision.id);
    setError("");
    setNotice("");
    try {
      await reviewProjectJournalDecision(spaceId, projectId, decision.id, session, {
        expectedRevision: decision.revision,
        outcome,
        ...(reviewNotes[decision.id]?.trim() ? { reviewNote: reviewNotes[decision.id]!.trim() } : {}),
        ...(outcome === "approve" && supersedes ? { supersedes } : {}),
      });
      setNotice(outcome === "approve" ? "Decision approved at the reviewed revision." : "Stale or current proposal rejected; it was not activated.");
      await refresh();
    } catch (reviewError) {
      const code = reviewError instanceof ApiError ? reviewError.errorCode ?? "" : "";
      setError(code.includes("decision_workspace_revision_stale")
        ? "The Project workspace changed after this proposal was created. Approval is blocked; reload the register before reviewing again."
        : code.includes("decision_workspace_revision_unavailable")
          ? "The current Project workspace revision could not be verified, so approval was blocked."
          : code.includes("active_decision_requires_explicit_supersession")
            ? "An active decision already covers this topic. Select that exact decision before approving."
            : code.includes("decision_revision_conflict") || code.includes("project_decision_write_conflict")
              ? "This proposal changed during review. Reload the current revision before taking another action."
              : "The decision could not be reviewed. Reload the current register and check your authority." );
      await refresh();
    } finally { setBusyDecisionId(null); }
  }

  const decisions = register?.decisions ?? [];
  const proposals = decisions.filter(item => item.status === "proposed");
  return <section className="settings-block" aria-labelledby="project-decision-review-heading" style={{ marginTop: 18 }}>
    <div style={{ padding: 16 }}>
      <div id="project-decision-review-heading" className="settings-row-label">Project decision review</div>
      <p className="settings-row-sub" style={{ margin: "6px 0 12px" }}>
        Proposals become active only after an authorized owner review at the exact current revision. Approval checks its pinned workspace revision again on the server. A stale proposal can be rejected, but never approved from an old pin.
      </p>
      {loading ? <p className="settings-row-sub">Loading decision register…</p>
        : error && !register ? <p className="settings-row-sub" role="alert" style={{ color: "var(--danger, #b42318)" }}>{error}</p>
          : <>
            {register?.can_review !== true && <p className="settings-row-sub" role="status">Review actions are available to the current Project owner or a Space administrator.</p>}
            {error && <p className="settings-row-sub" role="alert" style={{ color: "var(--danger, #b42318)" }}>{error}</p>}
            {notice && <p className="settings-row-sub" role="status">{notice}</p>}
            {proposals.length === 0 ? <p className="settings-row-sub" style={{ marginBottom: 4 }}>No pending decision proposals.</p> : proposals.map(decision => {
              const activeSameTopic = decisions.filter(item => item.status === "active" && item.topicKey === decision.topicKey);
              const stale = decision.workspaceStatus === "stale";
              const unavailable = decision.workspaceStatus === "unavailable";
              const approvalBlocked = stale || unavailable;
              return <article key={decision.id} style={{ borderTop: "1px solid var(--border)", padding: "12px 0 4px" }}>
                <div className="settings-row-label">{decision.topicKey} · revision {decision.revision}</div>
                <p style={{ margin: "5px 0", fontSize: 13, color: "var(--text)" }}>{decision.proposal}</p>
                <p className="settings-row-sub" style={{ margin: "4px 0" }}>{decision.rationale}</p>
                {decision.interfaces.length > 0 && <p className="settings-row-sub" style={{ margin: "4px 0" }}>References: {decision.interfaces.join(" · ")}</p>}
                <p className="settings-row-sub" style={{ margin: "4px 0", overflowWrap: "anywhere" }}>
                  Proposed by {decision.proposer} on {new Date(decision.proposedAt).toLocaleString()} · workspace pin {decision.baseWorkspace
                    ? `${decision.baseWorkspace.branch}@${decision.baseWorkspace.revision} (${decision.baseWorkspace.manifestHash.slice(0, 12)}…)`
                    : "not recorded"} · {decision.workspaceStatus ?? "workspace status unavailable"}
                </p>
                {stale && <p className="settings-row-sub" role="status" style={{ color: "var(--danger, #b42318)", margin: "5px 0" }}>The workspace moved past this proposal’s pin. Approval is blocked; rejection remains available.</p>}
                {unavailable && <p className="settings-row-sub" role="status" style={{ color: "var(--danger, #b42318)", margin: "5px 0" }}>The current workspace pin could not be verified. Approval is blocked; rejection remains available.</p>}
                {register?.can_review === true && <div style={{ display: "grid", gap: 8, marginTop: 9, maxWidth: 640 }}>
                  {activeSameTopic.length > 0 && <label className="settings-row-sub">
                    Replaces an active decision
                    <select aria-label={`Active decision replaced by ${decision.topicKey}`} value={supersessions[decision.id] ?? ""}
                      onChange={event => setSupersessions(value => ({ ...value, [decision.id]: event.target.value }))}>
                      <option value="">Choose the exact active decision</option>
                      {activeSameTopic.map(active => <option key={active.id} value={active.id}>{active.proposal} · {active.id}</option>)}
                    </select>
                  </label>}
                  <label className="settings-row-sub">
                    Review note (optional)
                    <textarea maxLength={500} rows={2} value={reviewNotes[decision.id] ?? ""}
                      onChange={event => setReviewNotes(value => ({ ...value, [decision.id]: event.target.value }))} />
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busyDecisionId !== null || approvalBlocked || (activeSameTopic.length > 0 && !activeSameTopic.some(item => item.id === (supersessions[decision.id] ?? "")))}
                      onClick={() => void review(decision, "approve")}>{busyDecisionId === decision.id ? "Saving…" : "Approve proposal"}</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busyDecisionId !== null}
                      onClick={() => void review(decision, "reject")}>{busyDecisionId === decision.id ? "Saving…" : "Reject proposal"}</button>
                  </div>
                </div>}
              </article>;
            })}
            {decisions.some(item => item.status === "active") && <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 12 }}>
              <div className="settings-row-label">Active reviewed decisions</div>
              {decisions.filter(item => item.status === "active").map(decision => <p key={decision.id} className="settings-row-sub" style={{ margin: "5px 0", overflowWrap: "anywhere" }}>
                <strong>{decision.topicKey}</strong>: {decision.proposal} · revision {decision.revision} · {decision.workspaceStatus ?? "workspace status unavailable"}
                {decision.workspaceStatus === "stale" && " — current workspace has advanced; task references to this revision require review."}
              </p>)}
            </div>}
            {register?.legacy_active_decisions.length ? <details style={{ marginTop: 10 }}>
              <summary className="settings-row-sub" style={{ cursor: "pointer" }}>Legacy decision strings (unreviewed)</summary>
              <ul className="settings-row-sub" style={{ marginTop: 5 }}>{register.legacy_active_decisions.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}</ul>
            </details> : null}
          </>}
    </div>
  </section>;
}
