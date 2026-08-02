"use client";

export const runtime = "edge";

// Assistant settings — every configuration for the space's own assistant, on one page with room
// to explain itself.
//
// Why this exists as its own page: these controls used to live in a ~320px dashboard tile
// alongside eight other tiles, where "Autonomy" was two unlabelled buttons and the four real
// approval modes were collapsed into a binary. Someone looking for "where do I change what my
// assistant is allowed to do" had no page to land on. The dashboard tile stays, but as a summary
// that links here.
//
// Everything writes through the same already-built, membership-gated routes the dashboard tile
// used (assistant-policy, model-config) — no new backend surface.

import * as React from "react";
import Link from "next/link";
import { Badge } from "@naelao/ui";
import { ALLOWED_MODELS, DEFAULT_WORKING_MODEL, capabilityForModel } from "@naelao/billing-core";
import { useProduct } from "@/lib/product-context";
import { useSessionCredentials } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  getAssistantPolicy,
  updateAssistantPolicy,
  updateModelConfig,
  getShellManifest,
  getAssistantCapabilities,
  listMyBusinesses,
  listScheduledJobs,
  listAssistantChannels,
  type AssistantPolicy,
  type AssistantCapabilities,
  type ScheduledJob,
  type ChannelLink,
  type Business,
} from "@/lib/api";
import { modelLabel } from "@/components/ModelSelector";
import { ApprovedActionsEditor } from "@/components/ApprovedActionsEditor";
import { SettingsSection, SettingsRow } from "@/components/SettingsSection";
import { canManageSpaceSettings } from "@/lib/roles";

type ApprovalMode = AssistantPolicy["approval_mode"];

/** The four real modes SpaceDO stores, described in terms of what actually happens — not the
 *  internal names. The dashboard tile only ever offered two of these. */
const MODES: { id: ApprovalMode; title: string; desc: string }[] = [
  {
    id: "always_ask",
    title: "Ask me first",
    desc: "Checks with you before anything that spends money, sends a message, or changes how the business is set up. Reading and looking things up never needs asking.",
  },
  {
    id: "gate_unless_listed",
    title: "Ask unless pre-approved",
    desc: "Like the above, but anything on your pre-approved list below goes through without asking.",
  },
  {
    id: "gate_listed",
    title: "Only ask for listed actions",
    desc: "The reverse: it acts freely except for the specific actions you list below, which always come to you.",
  },
  {
    id: "yolo",
    title: "Fully autonomous",
    desc: "Never asks. It will spend, send and change things on its own. Best once you've watched it work for a while.",
  },
];

export default function AssistantSettingsPage() {
  const product = useProduct();
  const creds = useSessionCredentials();
  const { activeSpaceId, activeSpaceName, isBusinessSpace } = useActiveSpace();

  const [policy, setPolicy] = React.useState<AssistantPolicy | null>(null);
  const [model, setModel] = React.useState<string | null>(null);
  const [business, setBusiness] = React.useState<Business | null>(null);
  const [capabilities, setCapabilities] = React.useState<AssistantCapabilities | null>(null);
  const [crons, setCrons] = React.useState<ScheduledJob[]>([]);
  const [channels, setChannels] = React.useState<ChannelLink[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!creds || !activeSpaceId) return;
    let cancelled = false;
    setLoading(true);
    const settle = <T,>(p: Promise<T>, set: (v: T) => void) =>
      p.then((v) => { if (!cancelled) set(v); }).catch(() => {});

    const calls = [
      settle(getAssistantPolicy(activeSpaceId, creds), setPolicy),
      settle(getShellManifest(activeSpaceId, creds).then((m) => m.model ?? null), setModel),
      settle(getAssistantCapabilities(activeSpaceId, creds), setCapabilities),
      settle(listScheduledJobs(activeSpaceId, creds), setCrons),
      settle(listAssistantChannels(activeSpaceId, creds), setChannels),
    ];
    if (isBusinessSpace) {
      calls.push(
        settle(listMyBusinesses(product.space_id, creds).then((l) => l.find((b) => b.id === activeSpaceId) ?? null), setBusiness)
      );
    }
    Promise.allSettled(calls).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds, activeSpaceId, isBusinessSpace, product.space_id]);

  const canEdit = canManageSpaceSettings(isBusinessSpace, business?.role);

  function flash(message: string) {
    setSaved(message);
    window.setTimeout(() => setSaved((cur) => (cur === message ? null : cur)), 2500);
  }

  async function savePolicy(patch: Partial<AssistantPolicy>, message: string) {
    if (!activeSpaceId || !creds) return;
    setSaving(true);
    setError(null);
    try {
      setPolicy(await updateAssistantPolicy(activeSpaceId, creds, patch));
      flash(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setSaving(false);
    }
  }

  async function saveModel(next: string) {
    if (!activeSpaceId || !creds) return;
    setSaving(true);
    setError(null);
    try {
      const res = await updateModelConfig(activeSpaceId, creds, next);
      setModel(res.model);
      flash("Model updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the model");
    } finally {
      setSaving(false);
    }
  }

  if (!creds) return null;

  const activeModel = model ?? DEFAULT_WORKING_MODEL;
  const listLabel =
    policy?.approval_mode === "gate_listed"
      ? "Actions that always need your approval"
      : "Actions it never needs to ask about";

  return (
    <div className="page-view">
      <div className="page-header">
        <div style={{ fontSize: 12, marginBottom: 6 }}>
          <Link href={`/p/${product.slug}/dashboard`} style={{ color: "var(--text3)", textDecoration: "none" }}>
            Dashboard
          </Link>
          <span style={{ color: "var(--text3)" }}> / Assistant</span>
        </div>
        <div className="page-title">Assistant settings</div>
        <div className="page-subtitle">
          How the assistant for {activeSpaceName ?? product.product_name} behaves — what it may do on its own, and which
          model it thinks with.
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
            ? "You can see these settings but not change them — that needs the owner or an admin of this business."
            : "This space's assistant is configured by its owner in the builder dashboard."}
        </div>
      )}

      <SettingsSection
        title="What it can do without asking"
        desc="The assistant always asks before something irreversible unless you tell it otherwise. Pick how much rope it gets."
      >
        <div style={{ display: "grid", gap: 8 }}>
          {MODES.map((mode) => {
            const active = policy?.approval_mode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                className={`dock-row${active ? " active" : ""}`}
                style={{ width: "100%", textAlign: "left", cursor: canEdit ? "pointer" : "default", background: active ? "var(--surface2)" : "transparent", fontFamily: "inherit" }}
                disabled={!canEdit || saving || active}
                onClick={() => void savePolicy({ approval_mode: mode.id }, `Switched to "${mode.title}"`)}
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
      </SettingsSection>

      <SettingsSection
        title={listLabel}
        desc={
          policy?.approval_mode === "gate_listed"
            ? "Everything else runs without interrupting you. Add an action name exactly as it appears on an approval request."
            : "Add an action here and the assistant stops asking about it. The name is shown on every approval request — copy it from there."
        }
      >
        <ApprovedActionsEditor
          actions={policy?.auto_approved_actions ?? []}
          canEdit={canEdit}
          busy={saving}
          onAdd={(a) => void savePolicy({ auto_approved_actions: [...(policy?.auto_approved_actions ?? []), a] }, `Added ${a}`)}
          onRemove={(a) => void savePolicy({ auto_approved_actions: (policy?.auto_approved_actions ?? []).filter((x) => x !== a) }, `Removed ${a}`)}
        />
      </SettingsSection>

      <SettingsSection title="Model" desc="What the assistant thinks with. A bigger model reasons better and costs more per message.">
        <div style={{ display: "grid", gap: 6 }}>
          {ALLOWED_MODELS.map((m) => {
            const cap = capabilityForModel(m);
            const active = m === activeModel;
            return (
              <div key={m} className={`dock-row${active ? " active" : ""}`}>
                <div className="dock-row-main">
                  <div className="dock-row-title">{modelLabel(m)}</div>
                  <div className="dock-row-desc">
                    {cap.reasoningLevels.length > 0
                      ? `Adjustable reasoning effort — ${cap.reasoningLevels.join(", ")}`
                      : "No configurable reasoning mode"}
                  </div>
                </div>
                <div className="dock-row-action">
                  {active ? (
                    <Badge color="green">In use</Badge>
                  ) : canEdit ? (
                    <button type="button" className="dock-pill" disabled={saving} onClick={() => void saveModel(m)}>
                      Use this
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <p style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 10, lineHeight: 1.6 }}>
          This is the business-wide default. You can also pick a different model for one conversation from the bar
          under the message box — that choice only affects that chat.
        </p>
      </SettingsSection>

      <SettingsSection title="Where it can be reached" desc="Connected channels the assistant answers on, besides this app.">
        {channels.length === 0 ? (
          <p style={{ fontSize: 12.5, color: "var(--text3)" }}>
            No channels connected yet. Connecting Slack, Discord, email or WhatsApp lets customers reach the assistant
            directly.
          </p>
        ) : (
          channels.map((c) => (
            <SettingsRow key={c.channel} label={<span style={{ textTransform: "capitalize" }}>{c.channel}</span>}>
              <Badge color={c.enabled ? "green" : "amber"}>{c.enabled ? "Connected" : "Off"}</Badge>
            </SettingsRow>
          ))
        )}
      </SettingsSection>

      <SettingsSection title="Recurring work" desc="Things it does on a schedule without being asked.">
        {crons.length === 0 ? (
          <p style={{ fontSize: 12.5, color: "var(--text3)" }}>
            Nothing scheduled. Ask the assistant to do something regularly — &ldquo;review revenue every Monday&rdquo; — and it
            will appear here.
          </p>
        ) : (
          crons.map((j) => (
            <SettingsRow key={j.id} label={j.name || j.id} sub={j.last_run_at ? `Last ran ${new Date(j.last_run_at).toLocaleString()}` : "Hasn't run yet"}>
              <Badge color={j.enabled ? "green" : "amber"}>{j.enabled ? j.cron_expression : "Paused"}</Badge>
            </SettingsRow>
          ))
        )}
      </SettingsSection>

      <SettingsSection title="What it can do" desc="Built-in abilities, plus skills it has written for itself while working.">
        <SettingsRow label="Built-in scripts" sub="Shipped with the platform — email, commerce, web search, the wallet, and more.">
          <span style={{ fontSize: 13, color: "var(--text2)" }}>{capabilities?.prebuilt_count ?? "…"}</span>
        </SettingsRow>
        <SettingsRow label="Learned skills" sub="Written by the assistant itself as it solves things. These build up with use.">
          <span style={{ fontSize: 13, color: "var(--text2)" }}>{capabilities?.skill_count ?? "…"}</span>
        </SettingsRow>
        <div style={{ marginTop: 10 }}>
          <Link href={`/p/${product.slug}/agents`} style={{ fontSize: 12.5, color: "var(--accent)", textDecoration: "none" }}>
            Configure individual agents →
          </Link>
        </div>
      </SettingsSection>

      {error && <p style={{ fontSize: 12.5, color: "#dc2626", marginTop: 12 }}>{error}</p>}
      {saved && <p style={{ fontSize: 12.5, color: "var(--text3)", marginTop: 12 }}>{saved}</p>}
    </div>
  );
}
