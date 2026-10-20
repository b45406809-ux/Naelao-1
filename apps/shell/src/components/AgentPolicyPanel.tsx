"use client";

// Per-agent approval-policy override — expandable "Configure" control shown next to an agent in
// the Dashboard's "Agents in this space" panel and the Projects page's "Agents in this project"
// grid. Falls back to the space-wide assistant_policy row when the agent has no override of its
// own (same three-step fallback SpaceDO's resolveAgentPolicy documents), so this is genuinely "one
// agent's own settings," not a duplicate of the space-wide Configuration panel.

import * as React from "react";
import { getAgentPolicy, updateAgentPolicy, getAssistantCapabilities, type AgentPolicy, type AssistantCapabilities } from "@/lib/api";
import type { SessionCredentials } from "@/lib/api";
import { ApprovedActionsEditor } from "./ApprovedActionsEditor";
import { presentAutonomyPolicy } from "@naelao/agent-sdk";

export function AgentPolicyPanel({
  spaceId,
  agentId,
  session,
  canEdit,
}: {
  spaceId: string;
  agentId: string;
  session: SessionCredentials;
  /** Whether the CALLER might be able to save a change — the backend (requireBusinessMembership's
   *  admin floor) is what actually enforces this; a plain member sees the same panel read-only
   *  rather than the write buttons being pre-hidden AND separately re-checked. */
  canEdit: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [policy, setPolicy] = React.useState<AgentPolicy | null>(null);
  const [capabilities, setCapabilities] = React.useState<AssistantCapabilities | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function load() {
    if (policy || loading) return;
    setLoading(true);
    setError(null);
    try {
      setPolicy(await getAgentPolicy(spaceId, agentId, session));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load this agent's settings");
    } finally {
      setLoading(false);
    }
    // Best-effort, independent of the policy load above — a capabilities-fetch failure must not
    // block seeing/editing the policy itself, just fall back to the plain free-text field.
    getAssistantCapabilities(spaceId, session).then(setCapabilities).catch(() => undefined);
  }

  function toggle() {
    setExpanded((v) => {
      if (!v) void load();
      return !v;
    });
  }

  async function setMode(mode: "always_ask" | "yolo") {
    setSaving(true);
    setError(null);
    try {
      setPolicy(await updateAgentPolicy(spaceId, agentId, session, { approval_mode: mode }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update autonomy");
    } finally {
      setSaving(false);
    }
  }

  async function addAction(action: string) {
    if (!policy) return;
    setSaving(true);
    setError(null);
    try {
      setPolicy(await updateAgentPolicy(spaceId, agentId, session, { auto_approved_actions: [...policy.auto_approved_actions, action] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the allowlist");
    } finally {
      setSaving(false);
    }
  }

  async function removeAction(action: string) {
    if (!policy) return;
    setSaving(true);
    setError(null);
    try {
      setPolicy(await updateAgentPolicy(spaceId, agentId, session, { auto_approved_actions: policy.auto_approved_actions.filter((a) => a !== action) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the allowlist");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: "2px 8px" }} onClick={toggle}>
        {expanded ? "Hide settings" : "Configure"}
      </button>
      {expanded && (
        <div
          style={{
            marginTop: 8, padding: 10, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
            background: "var(--surface)",
          }}
        >
          {loading && <div style={{ fontSize: 11.5, color: "var(--text3)" }}>Loading…</div>}
          {policy && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 11.5, color: "var(--text2)" }}>Autonomy</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className={policy.approval_mode === "always_ask" ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}
                    style={{ padding: "3px 8px", fontSize: 11 }}
                    disabled={saving || !canEdit || policy.approval_mode === "always_ask"}
                    onClick={() => void setMode("always_ask")}
                  >
                    Ask first
                  </button>
                  <button
                    type="button"
                    className={policy.approval_mode === "yolo" ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}
                    style={{ padding: "3px 8px", fontSize: 11 }}
                    disabled={saving || !canEdit || policy.approval_mode === "yolo"}
                    onClick={() => void setMode("yolo")}
                  >
                    Run within limits
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--text3)", marginBottom: 8 }}>
                {presentAutonomyPolicy(policy).explanation}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text2)", marginBottom: 4 }}>Pre-approved actions</div>
              <ApprovedActionsEditor
                actions={policy.auto_approved_actions}
                canEdit={canEdit}
                busy={saving}
                catalogue={capabilities?.prebuilts.map((p) => ({ script: p.name, description: p.description, operations: p.operations }))}
                onAdd={(a) => void addAction(a)}
                onRemove={(a) => void removeAction(a)}
              />
            </>
          )}
          {error && <div style={{ marginTop: 8, fontSize: 11, color: "#dc2626" }}>{error}</div>}
        </div>
      )}
    </div>
  );
}
