"use client";

// An in-chat approval card — rendered at the exact turn a run stopped at a gate, instead of only
// in the separate /approvals inbox. Approving/declining here calls the SAME endpoints that page
// uses; the agent resumes automatically once answered (server-side, via the HITL resume path) —
// this card just reports the decision and lets the person move on, rather than making them find
// the same request again in a different page.

import * as React from "react";
import { approveAction, rejectAction, type RunPendingApproval } from "@/lib/api";
import type { SessionCredentials } from "@/lib/api";

export function InlineApprovalCard({
  spaceId,
  approval,
  session,
  onResolved,
}: {
  spaceId: string;
  approval: RunPendingApproval;
  session: SessionCredentials;
  /** Called once approved/declined — the caller can refresh messages a moment later to pick up
   *  whatever the resumed run eventually says. */
  onResolved?: (decision: "approved" | "declined") => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [resolved, setResolved] = React.useState<"approved" | "declined" | null>(null);
  const [declining, setDeclining] = React.useState(false);
  const [reason, setReason] = React.useState("");

  async function handleApprove() {
    setBusy(true);
    try {
      await approveAction(spaceId, approval.approval_id, session);
      setResolved("approved");
      onResolved?.("approved");
    } catch {
      /* the card stays actionable — the approvals inbox is the fallback if this keeps failing */
    } finally {
      setBusy(false);
    }
  }

  async function handleDecline() {
    setBusy(true);
    try {
      await rejectAction(spaceId, approval.approval_id, reason.trim() || "Declined from chat", session);
      setResolved("declined");
      onResolved?.("declined");
    } catch {
      /* same fallback as approve */
    } finally {
      setBusy(false);
    }
  }

  const paramEntries = Object.entries(approval.params ?? {});

  return (
    <div
      style={{
        marginTop: 6, maxWidth: 440, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
        background: "var(--surface2)", padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span aria-hidden style={{ fontSize: 13 }}>🔒</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>Waiting for your approval</span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: paramEntries.length ? 6 : 10 }}>
        The agent wants to run <code style={{ fontSize: 12 }}>{approval.action_name}</code>
      </div>
      {paramEntries.length > 0 && (
        <div
          style={{
            fontSize: 11.5, color: "var(--text3)", background: "var(--surface)", borderRadius: 8,
            padding: 8, marginBottom: 10, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}
        >
          {paramEntries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")}
        </div>
      )}

      {resolved ? (
        <div style={{ fontSize: 12.5, color: resolved === "approved" ? "var(--accent)" : "var(--text3)", fontWeight: 600 }}>
          {resolved === "approved" ? "Approved — the agent will continue." : "Declined."}
        </div>
      ) : declining ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <input
            className="form-input"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ flex: 1, minWidth: 160, fontSize: 12.5 }}
          />
          <button type="button" className="btn btn-sm" style={{ background: "#dc2626", color: "#fff", border: "none" }} onClick={handleDecline} disabled={busy}>
            {busy ? "…" : "Confirm decline"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeclining(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleApprove} disabled={busy}>
            {busy ? "…" : "Approve"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeclining(true)} disabled={busy}>
            Decline
          </button>
        </div>
      )}
    </div>
  );
}
