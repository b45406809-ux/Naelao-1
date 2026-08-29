"use client";

export const runtime = "edge";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useSessionCredentials } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  getAgentManifest,
  updateAgentManifest,
  getAssistantPolicy,
  listAgentDefinitions,
  listMyBusinesses,
  getAssistantCapabilities,
  type UniversalAgentManifest,
  type AssistantPolicy,
  type AgentDefinitionSummary,
  type Business,
  type AssistantCapabilities,
} from "@/lib/api";
import { ApprovedActionsEditor } from "@/components/ApprovedActionsEditor";
import { SettingsSection, SettingsRow } from "@/components/SettingsSection";
import { canManageSpaceSettings } from "@/lib/roles";

const ARCHETYPE_ROLES = [
  {
    id: "DEV_OPERATOR" as const,
    title: "Developer Operator",
    tier: 5,
    desc: "Full code execution, AST editing, isolate shells, and container sandboxes (Tier 1–5).",
  },
  {
    id: "GROWTH_OPERATOR" as const,
    title: "Growth & Marketing Operator",
    tier: 4,
    desc: "Web search, browser automation, marketing email, and content generation (Tier 1–4).",
  },
  {
    id: "CUSTOMER_SUPPORT" as const,
    title: "Customer Support Specialist",
    tier: 1,
    desc: "Knowledge base retrieval, conversation, and instant notifications (Tier 1 Safe In-Memory).",
  },
  {
    id: "ARCHITECT_DELEGATE" as const,
    title: "Architect & Orchestrator",
    tier: 2,
    desc: "Sub-agent orchestration, dynamic workflows, wiki maintenance, and project journaling.",
  },
  {
    id: "CUSTOM" as const,
    title: "Custom Configured",
    tier: 5,
    desc: "Unrestricted custom toolset and execution ladder configured directly by the founder.",
  },
];

const PREBUILT_TOOL_CATALOGUE = [
  { id: "r2-workspace", label: "Workspace Files (R2)", desc: "Read & edit project workspace files" },
  { id: "code-exec", label: "Code Execution", desc: "Run TypeScript & isolated scripts" },
  { id: "memory", label: "Agent Memory", desc: "Persistent episodic & semantic memory" },
  { id: "knowledge-base", label: "Knowledge Base (RAG)", desc: "Search space documents & guides" },
  { id: "web-search", label: "Live Web Search", desc: "Real-time Google search via Serper" },
  { id: "browser-use", label: "Browser Automation", desc: "Automate web workflows via browser" },
  { id: "business-email", label: "Business Email", desc: "Send outreach and confirmation emails" },
  { id: "notifications", label: "Live Notifications", desc: "Send Discord, Slack & email alerts" },
  { id: "artifacts", label: "Deliverable Artifacts", desc: "Generate client-facing downloadables" },
  { id: "sub-agent", label: "Sub-Agent Delegation", desc: "Spawn and delegate to sub-threads" },
  { id: "lock", label: "Distributed Locks", desc: "Mutex locking for concurrent task safety" },
];

export default function AgentDetailPage() {
  const product = useProduct();
  const params = useParams<{ agentId: string }>();
  const agentId = decodeURIComponent(String(params?.agentId ?? ""));
  const creds = useSessionCredentials();
  const { activeSpaceId, isBusinessSpace } = useActiveSpace();

  const [agent, setAgent] = React.useState<AgentDefinitionSummary | null>(null);
  const [manifest, setManifest] = React.useState<UniversalAgentManifest | null>(null);
  const [spacePolicy, setSpacePolicy] = React.useState<AssistantPolicy | null>(null);
  const [business, setBusiness] = React.useState<Business | null>(null);
  const [capabilities, setCapabilities] = React.useState<AssistantCapabilities | null>(null);
  const [customPrompt, setCustomPrompt] = React.useState("");
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
      settle(
        getAgentManifest(activeSpaceId, agentId, creds).then((m) => {
          setManifest(m);
          setCustomPrompt(m.prompts.userCustomInstructions ?? "");
          return m;
        }),
        () => {}
      ),
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
  }, [creds, activeSpaceId, agentId, isBusinessSpace, product.space_id]);

  const canEdit = canManageSpaceSettings(isBusinessSpace, business?.role);

  function flash(message: string) {
    setSaved(message);
    window.setTimeout(() => setSaved((cur) => (cur === message ? null : cur)), 2500);
  }

  async function saveManifest(patch: Partial<UniversalAgentManifest>, message: string) {
    if (!activeSpaceId || !creds) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateAgentManifest(activeSpaceId, agentId, creds, patch);
      setManifest(updated);
      flash(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save agent configuration");
    } finally {
      setSaving(false);
    }
  }

  if (!creds) return null;

  const isAutonomous = manifest?.autonomy.approvalMode === "yolo";
  const inheriting = (manifest?.autonomy.autoApprovedActions?.length ?? 0) === 0 && (spacePolicy?.auto_approved_actions?.length ?? 0) > 0;

  return (
    <div className="page-view">
      <div className="page-header">
        <div style={{ fontSize: 12, marginBottom: 6 }}>
          <Link href={`/p/${product.slug}/agents`} style={{ color: "var(--text3)", textDecoration: "none" }}>
            Agents
          </Link>
          <span style={{ color: "var(--text3)" }}> / {manifest?.name ?? agent?.name ?? agentId}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="page-title">{manifest?.name ?? agent?.name ?? agentId}</div>
          {manifest?.role && (
            <Badge color={manifest.role === "DEV_OPERATOR" ? "blue" : manifest.role === "CUSTOMER_SUPPORT" ? "green" : "purple"}>
              {manifest.role.replace("_", " ")}
            </Badge>
          )}
          <Badge color={manifest?.scope === "SPACE_WIDE" ? "amber" : "gray"}>
            {manifest?.scope === "SPACE_WIDE" ? "Space-Wide" : "Project-Bound"}
          </Badge>
        </div>
        <div className="page-subtitle">
          {manifest?.description ?? agent?.description ?? "A specialist agent running on the Universal Agent Engine."}
        </div>
      </div>

      {loading && <p style={{ fontSize: 12.5, color: "var(--text3)" }}>Loading agent profile…</p>}

      {!canEdit && !loading && (
        <div
          style={{
            padding: "10px 14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)",
            background: "var(--surface2)", fontSize: 12.5, color: "var(--text2)", marginBottom: 18,
          }}
        >
          {isBusinessSpace
            ? "You can inspect this agent's configuration, but changing settings requires a business owner or admin."
            : "This space's agents are configured by its owner in the builder dashboard."}
        </div>
      )}

      {/* Layer 4: Founder's Custom Prompt Directives & Overrides */}
      <SettingsSection
        title="Founder Directives & Custom Instructions"
        desc="Layer 4 of the Universal Prompt Hierarchy: Injected dynamically into every run to guide tone, rules, and business specifics."
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="e.g. Always respond in concise bullet points. Prioritize TypeScript and Tailwind dark mode. Ask before sending emails to new clients."
            rows={5}
            disabled={!canEdit || saving}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 13,
              fontFamily: "var(--font-mono, monospace)",
              lineHeight: 1.5,
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canEdit || saving || customPrompt === (manifest?.prompts.userCustomInstructions ?? "")}
              onClick={() =>
                void saveManifest(
                  {
                    prompts: {
                      systemPrompt: manifest?.prompts.systemPrompt ?? "",
                      instructions: manifest?.prompts.instructions ?? "",
                      userCustomInstructions: customPrompt,
                    },
                  },
                  "Saved custom prompt directives"
                )
              }
              style={{ padding: "6px 14px", fontSize: 12.5 }}
            >
              {saving ? "Saving…" : "Save Directives"}
            </button>
          </div>
        </div>
      </SettingsSection>

      {/* Archetype Role & Capability Firewall */}
      <SettingsSection
        title="Archetype Role & Capability Firewall"
        desc="Hardcoded operational boundaries per archetype. Tool schemas and execution capabilities outside this boundary are physically stripped."
      >
        <div style={{ display: "grid", gap: 8 }}>
          {ARCHETYPE_ROLES.map((roleDef) => {
            const active = manifest?.role === roleDef.id;
            return (
              <button
                key={roleDef.id}
                type="button"
                className={`dock-row${active ? " active" : ""}`}
                style={{
                  width: "100%", textAlign: "left", cursor: canEdit ? "pointer" : "default",
                  background: active ? "var(--surface2)" : "transparent", fontFamily: "inherit"
                }}
                disabled={!canEdit || saving || active}
                onClick={() => void saveManifest({ role: roleDef.id }, `Switched archetype to "${roleDef.title}"`)}
              >
                <div className="dock-row-main">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div className="dock-row-title">{roleDef.title}</div>
                    <span style={{ fontSize: 11, color: "var(--text3)" }}>Max Tier: {roleDef.tier}</span>
                  </div>
                  <div className="dock-row-desc" style={{ whiteSpace: "normal", lineHeight: 1.5 }}>
                    {roleDef.desc}
                  </div>
                </div>
                <div className="dock-row-action">
                  {active ? <Badge color="green">Active</Badge> : canEdit ? <span className="dock-pill">Select</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      </SettingsSection>

      {/* Toolset & Enabled Capabilities */}
      <SettingsSection
        title="Enabled Tools & Capabilities"
        desc="Platform scripts available in this agent's action space (filtered by role firewall at runtime)."
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8 }}>
          {PREBUILT_TOOL_CATALOGUE.map((tool) => {
            const isEnabled = manifest?.capabilities.enabledPrebuilts.includes(tool.id) ?? false;
            return (
              <div
                key={tool.id}
                style={{
                  padding: "10px 12px",
                  borderRadius: "var(--radius-sm)",
                  border: isEnabled ? "1px solid var(--border-accent, var(--accent))" : "1px solid var(--border)",
                  background: isEnabled ? "var(--surface2)" : "var(--surface)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  gap: 6,
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text)" }}>{tool.label}</span>
                    {isEnabled && <Badge color="blue">Enabled</Badge>}
                  </div>
                  <p style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>{tool.desc}</p>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    className="dock-pill"
                    style={{ alignSelf: "flex-start", cursor: "pointer", marginTop: 4 }}
                    disabled={saving}
                    onClick={() => {
                      const current = manifest?.capabilities.enabledPrebuilts ?? [];
                      const updated = isEnabled ? current.filter((t) => t !== tool.id) : [...current, tool.id];
                      void saveManifest(
                        {
                          capabilities: {
                            enabledPrebuilts: updated,
                            installedPlugins: manifest?.capabilities.installedPlugins ?? [],
                            maxTier: manifest?.capabilities.maxTier ?? 5,
                          },
                        },
                        isEnabled ? `Disabled ${tool.label}` : `Enabled ${tool.label}`
                      );
                    }}
                  >
                    {isEnabled ? "Disable" : "Enable"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </SettingsSection>

      {/* Autonomy & Approval Posture */}
      <SettingsSection
        title="Autonomy & HITL Approval Posture"
        desc="Whether this agent pauses and requests confirmation before executing irreversible changes."
      >
        <div style={{ display: "grid", gap: 8 }}>
          {[
            {
              id: "always_ask" as const,
              title: "Ask first (HITL Guarded)",
              desc: "Stops and waits for a human before running any action not explicitly on the auto-approved list.",
            },
            {
              id: "yolo" as const,
              title: "Fully autonomous (YOLO)",
              desc: "Never pauses to ask for approval. Executes immediately while logging full telemetry to the activity journal.",
            },
          ].map((mode) => {
            const active = manifest?.autonomy.approvalMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                className={`dock-row${active ? " active" : ""}`}
                style={{
                  width: "100%", textAlign: "left", cursor: canEdit ? "pointer" : "default",
                  background: active ? "var(--surface2)" : "transparent", fontFamily: "inherit"
                }}
                disabled={!canEdit || saving || active}
                onClick={() =>
                  void saveManifest(
                    {
                      autonomy: {
                        approvalMode: mode.id,
                        autoApprovedActions: manifest?.autonomy.autoApprovedActions ?? [],
                        requiresApprovalFor: manifest?.autonomy.requiresApprovalFor ?? [],
                      },
                    },
                    `Switched posture to "${mode.title}"`
                  )
                }
              >
                <div className="dock-row-main">
                  <div className="dock-row-title">{mode.title}</div>
                  <div className="dock-row-desc" style={{ whiteSpace: "normal", lineHeight: 1.5 }}>
                    {mode.desc}
                  </div>
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
            All actions will execute autonomously without interruption. Detailed execution steps remain logged in the run audit trail.
          </p>
        )}
      </SettingsSection>

      {/* Auto-Approved Actions */}
      <SettingsSection
        title="Auto-Approved Actions Allowlist"
        desc="Named operations that this agent is permitted to execute without human approval."
      >
        <ApprovedActionsEditor
          actions={manifest?.autonomy.autoApprovedActions ?? []}
          canEdit={canEdit}
          busy={saving}
          catalogue={capabilities?.prebuilts.map((p) => ({
            script: p.name,
            description: p.description,
            operations: p.operations,
          }))}
          onAdd={(a) =>
            void saveManifest(
              {
                autonomy: {
                  approvalMode: manifest?.autonomy.approvalMode ?? "always_ask",
                  autoApprovedActions: [...(manifest?.autonomy.autoApprovedActions ?? []), a],
                  requiresApprovalFor: manifest?.autonomy.requiresApprovalFor ?? [],
                },
              },
              `Added ${a}`
            )
          }
          onRemove={(a) =>
            void saveManifest(
              {
                autonomy: {
                  approvalMode: manifest?.autonomy.approvalMode ?? "always_ask",
                  autoApprovedActions: (manifest?.autonomy.autoApprovedActions ?? []).filter((x) => x !== a),
                  requiresApprovalFor: manifest?.autonomy.requiresApprovalFor ?? [],
                },
              },
              `Removed ${a}`
            )
          }
        />
        {inheriting && (
          <p style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 10, lineHeight: 1.6 }}>
            This agent has no specific override list, so it inherits the space-wide policy
            ({spacePolicy?.auto_approved_actions.length} action
            {spacePolicy?.auto_approved_actions.length === 1 ? "" : "s"}). Adding an action here creates a dedicated agent allowlist.{" "}
            <Link href={`/p/${product.slug}/dashboard/assistant`} style={{ color: "var(--accent)", textDecoration: "none" }}>
              Space-wide policy →
            </Link>
          </p>
        )}
      </SettingsSection>

      {/* Execution Ceiling & Scoping Details */}
      <SettingsSection title="Engine Specification" desc="Low-level Universal Agent parameters.">
        <SettingsRow label="Agent Identifier" sub="Canonical ID in the space registry and R2 storage bucket.">
          <code style={{ fontSize: 11.5, color: "var(--text3)" }}>{agentId}</code>
        </SettingsRow>
        <SettingsRow label="Execution Ceiling" sub="Highest resource tier this agent is physically permitted to run.">
          <span style={{ fontSize: 12, color: "var(--text)" }}>Tier {manifest?.capabilities.maxTier ?? 5}</span>
        </SettingsRow>
        <SettingsRow label="Filesystem Scope" sub="Workspace boundary for tool operations.">
          <span style={{ fontSize: 12, color: "var(--text)" }}>
            {manifest?.scope === "SPACE_WIDE" ? "Space-wide (spaces/{spaceId}/workspace/)" : `Project-Bound (${manifest?.projectId ?? "p1"})`}
          </span>
        </SettingsRow>
        <SettingsRow label="Trigger Cadence" sub="How this agent is activated.">
          <span style={{ fontSize: 12, color: "var(--text)" }}>
            {manifest?.triggers.proactiveHeartbeat ? "Proactive Heartbeat + Interactive Threads" : "Reactive to Thread Prompts"}
          </span>
        </SettingsRow>
      </SettingsSection>

      {error && <p style={{ fontSize: 12.5, color: "#dc2626", marginTop: 12 }}>{error}</p>}
      {saved && <p style={{ fontSize: 12.5, color: "var(--text3)", marginTop: 12 }}>{saved}</p>}
    </div>
  );
}
