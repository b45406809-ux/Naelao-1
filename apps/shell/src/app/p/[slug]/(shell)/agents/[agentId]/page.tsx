"use client";

export const runtime = "edge";

// One agent's own settings.
//
// Per-agent policy already existed as an inline expander tucked inside a dashboard tile, which
// meant "configure this agent" was a thing you had to already know was there. This is the page it
// should have been: what the agent is, what it may do unattended, and which actions always come
// back to a human.
//
// An agent with no override of its own inherits the space-wide assistant policy — the same
// three-step fallback SpaceDO's resolveAgentPolicy documents. That's stated on the page rather
// than left as an empty form, because "no override" and "allowed nothing" look identical
// otherwise.

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useSessionCredentials } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  getAgentPolicy,
  updateAgentPolicy,
  getAssistantPolicy,
  listAgentDefinitions,
  listMyBusinesses,
  getAssistantCapabilities,
  type AgentPolicy,
  type AssistantPolicy,
  type AgentDefinitionSummary,
  type Business,
  type AssistantCapabilities,
} from "@/lib/api";
import { ApprovedActionsEditor } from "@/components/ApprovedActionsEditor";
import { SettingsSection, SettingsRow } from "@/components/SettingsSection";
import { canManageSpaceSettings } from "@/lib/roles";

export default function AgentDetailPage() {
  const product = useProduct();
  const params = useParams<{ agentId: string }>();
  const agentId = decodeURIComponent(String(params?.agentId ?? ""));
  const creds = useSessionCredentials();
  const { activeSpaceId, isBusinessSpace } = useActiveSpace();

  const [agent, setAgent] = React.useState<AgentDefinitionSummary | null>(null);
  const [policy, setPolicy] = React.useState<AgentPolicy | null>(null);
  const [spacePolicy, setSpacePolicy] = React.useState<AssistantPolicy | null>(null);
  const [business, setBusiness] = React.useState<Business | null>(null);
  const [capabilities, setCapabilities] = React.useState<AssistantCapabilities | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!creds || !activeSpaceId || !agentId) return;
    let cancelled = false;
    setLoading(true);
    const settle = <T,>(p: Promise<T>, set: (v: T) => void) =>
      p.then((v) => { if (!cancelled) set(v); }).catch(() => {});

    const calls = [
      settle(getAgentPolicy(activeSpaceId, agentId, creds), setPolicy),
      settle(getAssistantPolicy(activeSpaceId, creds), setSpacePolicy),
      settle(listAgentDefinitions(activeSpaceId, creds).then((list) => list.find((a) => a.id === agentId) ?? null), setAgent),
      settle(getAssistantCapabilities(activeSpaceId, creds), setCapabilities),
    ];
    if (isBusinessSpace) {
      calls.push(
        settle(listMyBusinesses(product.space_id, creds).then((l) => l.find((b) => b.id === activeSpaceId) ?? null), setBusiness)
      );
    }
    Promise.allSettled(calls).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds, activeSpaceId, agentId, isBusinessSpace, product.space_id]);

  const canEdit = canManageSpaceSettings(isBusinessSpace, business?.role);

  function flash(message: string) {
    setSaved(message);
    window.setTimeout(() => setSaved((cur) => (cur === message ? null : cur)), 2500);
  }

  async function save(patch: Partial<AgentPolicy>, message: string) {
    if (!activeSpaceId || !creds) return;
    setSaving(true);
    setError(null);
    try {
      setPolicy(await updateAgentPolicy(activeSpaceId, agentId, creds, patch));
      flash(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setSaving(false);
    }
  }

  if (!creds) return null;

  const isAutonomous = policy?.approval_mode === "yolo";
  // The agent's own list is empty AND the space has one → this agent is running on the inherited
  // policy, which is worth saying out loud.
  const inheriting = (policy?.auto_approved_actions?.length ?? 0) === 0 && (spacePolicy?.auto_approved_actions?.length ?? 0) > 0;

  return (
    <div className="page-view">
      <div className="page-header">
        <div style={{ fontSize: 12, marginBottom: 6 }}>
          <Link href={`/p/${product.slug}/agents`} style={{ color: "var(--text3)", textDecoration: "none" }}>
            Agents
          </Link>
          <span style={{ color: "var(--text3)" }}> / {agent?.name ?? agentId}</span>
        </div>
        <div className="page-title">{agent?.name ?? agentId}</div>
        <div className="page-subtitle">
          {agent?.description ?? "A specialist agent in this space. It works on the projects it's assigned to."}
        </div>
      </div>

      {loading && <p style={{ fontSize: 12.5, color: "var(--text3)" }}>Loading…</p>}

      {!canEdit && !loading && (
        <div
          style={{
            padding: "10px 14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)",
            background: "var(--surface2)", fontSize: 12.5, color: "var(--text2)", marginBottom: 18,
          }}
        >
          {isBusinessSpace
            ? "You can see this agent's settings but not change them — that needs the owner or an admin of this business."
            : "This space's agents are configured by its owner in the builder dashboard."}
        </div>
      )}

      <SettingsSection
        title="Autonomy"
        desc="Whether this agent checks with a human before it does something with real consequences, independently of the rest of the space."
      >
        <div style={{ display: "grid", gap: 8 }}>
          {[
            { id: "always_ask" as const, title: "Ask first", desc: "Stops and waits for a person before anything irreversible. Anything on the list below still goes straight through." },
            { id: "yolo" as const, title: "Fully autonomous", desc: "Never stops to ask. Use once you've seen how this agent behaves on real work." },
          ].map((mode) => {
            const active = policy?.approval_mode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                className={`dock-row${active ? " active" : ""}`}
                style={{ width: "100%", textAlign: "left", cursor: canEdit ? "pointer" : "default", background: active ? "var(--surface2)" : "transparent", fontFamily: "inherit" }}
                disabled={!canEdit || saving || active}
                onClick={() => void save({ approval_mode: mode.id }, `Switched to "${mode.title}"`)}
              >
                <div className="dock-row-main">
                  <div className="dock-row-title">{mode.title}</div>
                  <div className="dock-row-desc" style={{ whiteSpace: "normal", lineHeight: 1.5 }}>{mode.desc}</div>
                </div>
                <div className="dock-row-action">
                  {active ? <Badge color="green">Current</Badge> : canEdit ? <span className="dock-pill">Use this</span> : null}
                </div>
              </button>
            );
          })}
        </div>
        {isAutonomous && (
          <p style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 10 }}>
            Nothing this agent does will come to you for approval. The record of what it did is still in the activity
            feed on each run.
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        title="Actions it never needs to ask about"
        desc="Named exactly as they appear on an approval request. Anything here runs without interrupting anyone."
      >
        <ApprovedActionsEditor
          actions={policy?.auto_approved_actions ?? []}
          canEdit={canEdit}
          busy={saving}
          catalogue={capabilities?.prebuilts.map((p) => ({ script: p.name, description: p.description, operations: p.operations }))}
          onAdd={(a) => void save({ auto_approved_actions: [...(policy?.auto_approved_actions ?? []), a] }, `Added ${a}`)}
          onRemove={(a) => void save({ auto_approved_actions: (policy?.auto_approved_actions ?? []).filter((x) => x !== a) }, `Removed ${a}`)}
        />
        {inheriting && (
          <p style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 10, lineHeight: 1.6 }}>
            This agent has no list of its own, so it follows the space-wide one
            ({spacePolicy?.auto_approved_actions.length} action
            {spacePolicy?.auto_approved_actions.length === 1 ? "" : "s"}). Adding anything here gives this agent its own
            list instead.{" "}
            <Link href={`/p/${product.slug}/dashboard/assistant`} style={{ color: "var(--accent)", textDecoration: "none" }}>
              See the space-wide settings →
            </Link>
          </p>
        )}
      </SettingsSection>

      <SettingsSection title="About this agent" desc="Where it came from and what it's for.">
        <SettingsRow label="Identifier" sub="What appears in approval requests and the activity feed.">
          <code style={{ fontSize: 11.5, color: "var(--text3)" }}>{agentId}</code>
        </SettingsRow>
        <SettingsRow label="Instructions" sub="An agent's own prompt is set by whoever authored the template it came from.">
          <span style={{ fontSize: 12, color: "var(--text3)" }}>Not editable here</span>
        </SettingsRow>
      </SettingsSection>

      {error && <p style={{ fontSize: 12.5, color: "#dc2626", marginTop: 12 }}>{error}</p>}
      {saved && <p style={{ fontSize: 12.5, color: "var(--text3)", marginTop: 12 }}>{saved}</p>}
    </div>
  );
}
