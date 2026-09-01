"use client";

// An in-chat approval card — rendered at the exact turn a run stopped at a gate, instead of only
// in the separate /approvals inbox. Approving/declining here calls the SAME endpoints that page
// uses; the agent resumes automatically once answered (server-side, via the HITL resume path) —
// this card just reports the decision and lets the person move on, rather than making them find
// the same request again in a different page.

import * as React from "react";
import { approveAction, rejectAction, getAssistantPolicy, updateAssistantPolicy, type RunPendingApproval } from "@/lib/api";
import type { SessionCredentials } from "@/lib/api";

function formatHumanAction(actionName: string, params: Record<string, unknown>): { title: string; subtitle: string; icon: string } {
  if (actionName.includes("artifacts.merge") || actionName.includes("git.pr") || actionName.includes("git.merge")) {
    return {
      title: "Review Proposed Changes",
      subtitle: (params.title as string) || (params.summary as string) || "The team drafted improvements for this project.",
      icon: "📬",
    };
  }
  if (actionName.includes("email") || actionName.includes("send_email")) {
    return {
      title: "Send Email Campaign / Message",
      subtitle: `To: ${params.to || params.recipient || "Customer"}`,
      icon: "✉️",
    };
  }
  if (actionName.includes("twitter") || actionName.includes("tweet") || actionName.includes("social")) {
    return {
      title: "Publish Social Media Update",
      subtitle: (params.text as string) || (params.content as string) || "Post update to social channels",
      icon: "📢",
    };
  }
  if (actionName.includes("calendar") || actionName.includes("schedule.book")) {
    return {
      title: "Schedule Calendar Event",
      subtitle: (params.summary as string) || (params.title as string) || "Book appointment on calendar",
      icon: "📅",
    };
  }
  return {
    title: `Action: ${actionName.replace(/[._]/g, " ")}`,
    subtitle: "Waiting for your confirmation to proceed.",
    icon: "🔒",
  };
}

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
  // Whether this exact action ended up on the space's own auto-approved allowlist — only known
  // once an "always allow" attempt actually succeeds, so this stays unset (not silently claimed)
  // when the caller isn't a business admin (PATCH is admin-gated; approving itself is not).
  const [alwaysAllowed, setAlwaysAllowed] = React.useState(false);
  const [alwaysAllowFailed, setAlwaysAllowFailed] = React.useState(false);

  const human = formatHumanAction(approval.action_name, approval.params ?? {});

  async function handleApprove(alwaysAllow: boolean) {
    setBusy(true);
    try {
      await approveAction(spaceId, approval.approval_id, session);
      setResolved("approved");
      onResolved?.("approved");
      // "Approve and don't ask again" — self-serve fix for a business whose stored policy
      // predates a default auto-approved action (e.g. web search) being added, or for any action
      // a person has simply decided is fine going forward. Read-then-write against the real
      // stored list rather than assuming it's empty, since PATCH replaces the whole array.
      if (alwaysAllow) {
        try {
          const policy = await getAssistantPolicy(spaceId, session);
          if (!policy.auto_approved_actions.includes(approval.action_name)) {
            await updateAssistantPolicy(spaceId, session, {
              auto_approved_actions: [...policy.auto_approved_actions, approval.action_name],
            });
          }
          setAlwaysAllowed(true);
        } catch {
          // Most likely: this person isn't a business admin. The approval itself already
          // succeeded — just say so rather than failing the whole action silently.
          setAlwaysAllowFailed(true);
        }
      }
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
        marginTop: 8, maxWidth: 460, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
        background: "var(--surface2)", padding: 14, boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span aria-hidden style={{ fontSize: 16 }}>{human.icon}</span>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>{human.title}</span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: 10, lineHeight: 1.45 }}>
        {human.subtitle}
      </div>
      {paramEntries.length > 0 && (
        <details style={{ marginBottom: 10 }}>
          <summary style={{ fontSize: 11.5, color: "var(--text3)", cursor: "pointer", userSelect: "none" }}>
            View technical details
          </summary>
          <div
            style={{
              fontSize: 11.5, color: "var(--text3)", background: "var(--surface)", borderRadius: 6,
              padding: 8, marginTop: 6, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}
          >
            {paramEntries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")}
          </div>
        </details>
      )}

      {resolved ? (
        <div>
          <div style={{ fontSize: 12.5, color: resolved === "approved" ? "#16a34a" : "var(--text3)", fontWeight: 600 }}>
            {resolved === "approved" ? "✅ Applied to project — the agent will continue." : "Declined."}
          </div>
          {alwaysAllowed && (
            <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 4 }}>
              Won&apos;t ask for this action again.
            </div>
          )}
          {alwaysAllowFailed && (
            <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 4 }}>
              Approved, but couldn&apos;t update the always-allow list (needs a business admin).
            </div>
          )}
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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-primary btn-sm" style={{ background: "#16a34a", color: "#fff", border: "none" }} onClick={() => void handleApprove(false)} disabled={busy}>
            {busy ? "…" : "Apply to Live Project"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void handleApprove(true)}
            disabled={busy}
            title="Approve this and auto-approve similar updates"
          >
            {busy ? "…" : "Always allow"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeclining(true)} disabled={busy}>
            Decline
          </button>
        </div>
      )}
    </div>
  );
}
