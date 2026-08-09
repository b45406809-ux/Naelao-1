"use client";

export const runtime = "edge";

// The Dashboard — a merged BUSINESS dashboard + ASSISTANT dashboard for whichever space is
// currently active (formerly two separate surfaces: this page used to be assistant-only, and a
// business's key numbers only lived buried in its own /spaces/:id management page). Renamed from
// "Assistant" and moved to the top of the sidebar, above Discover, since it's the first thing
// worth seeing when you open a business.
//
// Built on the real design system (Card/CardLabel/CardValue, .section-label, .settings-block/
// .settings-row) rather than one-off inline styling, so it reads consistently with the rest of
// the shell instead of as a bolted-on panel.
//
// Every panel is a read-only consumer of an already-built endpoint; nothing here fabricates a
// number it cannot actually read. Deep management (invites, payout destinations, connecting
// apps, adding products) stays on the business's own /spaces/:id page — this is an overview with
// a link there, not a re-implementation of it.
//
// Authoring — writing a skill, editing the system prompt — is deliberately NOT here. Those are
// builder operations against the operator's own accumulated work, and the end-user shell is a
// structurally different population; the builder dashboard is where that belongs.

import * as React from "react";
import Link from "next/link";
import { Card, CardLabel, CardValue, CardSub, Badge, type BadgeColor } from "@naelao/ui";
import { ALLOWED_MODELS, effortOptionsForModel, isValidEffortLevel } from "@naelao/billing-core";
import { useProduct } from "@/lib/product-context";
import { useSessionCredentials } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  getAssistantPolicy,
  updateAssistantPolicy,
  updateModelConfig,
  getAssistantMemory,
  getAssistantCapabilities,
  listScheduledJobs,
  listAssistantChannels,
  listAssistantFiles,
  listSessions,
  listAgentDefinitions,
  getMe,
  listMyBusinesses,
  getShellManifest,
  listBusinessMembers,
  getBusinessWalletBalance,
  getBusinessWalletTransactions,
  getBusinessRevenue,
  listBusinessOrders,
  getConnectorStatus,
  listApprovals,
  getBusinessAnalytics,
  type AssistantPolicy,
  type MemoryFact,
  type AssistantCapabilities,
  type ScheduledJob,
  type ChannelLink,
  type WorkspaceFile,
  type SessionSummary,
  type AgentDefinitionSummary,
  type ProductUserMe,
  type Business,
  type WhopWalletBalance,
  type WhopWalletTransaction,
  type RevenueSummary,
  type LaunchpadOrder,
  type ConnectorInfo,
  type PendingApproval,
  type BusinessAnalytics,
} from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";
import { ApprovedActionsEditor } from "@/components/ApprovedActionsEditor";
import { canManageSpaceSettings } from "@/lib/roles";

/** Same curated allowlist + default the dashboard's own Configuration tab picker uses — kept as
 *  a parallel copy rather than a new shared export (this codebase's own precedent for a small
 *  duplicated label map, e.g. mcp-hub/credentials each holding their own token helper — see
 *  item 58). An id with no entry falls back to the id itself. */
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MODEL_LABELS: Record<string, string> = {
  "claude-haiku-4-5-20251001": "Haiku — needs Anthropic on the gateway",
  "claude-sonnet-4-6": "Sonnet — needs Anthropic on the gateway",
  "claude-opus-4-8": "Opus — needs Anthropic on the gateway",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "Llama 3.3 70B — balanced default",
  "@cf/meta/llama-4-scout-17b-16e-instruct": "Llama 4 Scout — fast",
  "@cf/openai/gpt-oss-120b": "GPT-OSS 120B — most capable",
  "@cf/openai/gpt-oss-20b": "GPT-OSS 20B — cheap",
  "@cf/qwen/qwen3-30b-a3b-fp8": "Qwen3 30B",
  "@cf/mistralai/mistral-small-3.1-24b-instruct": "Mistral Small",
  "@cf/ibm-granite/granite-4.0-h-micro": "Granite Micro — cheapest",
  "@cf/google/gemma-4-26b-a4b-it": "Gemma 4 26B",
  "@cf/zai-org/glm-4.7-flash": "GLM 4.7 Flash",
  "@cf/zai-org/glm-5.2": "GLM 5.2",
  "@cf/nvidia/nemotron-3-120b-a12b": "Nemotron 3 120B",
  "@cf/moonshotai/kimi-k2.6": "Kimi K2.6",
  "@cf/moonshotai/kimi-k2.7-code": "Kimi K2.7 Code",
  "google-ai-studio/gemini-flash-lite-latest": "Gemini Flash-Lite — needs a Google AI Studio key",
  "google-ai-studio/gemini-flash-latest": "Gemini Flash — needs a Google AI Studio key",
  "google-ai-studio/gemini-pro-latest": "Gemini Pro — needs a Google AI Studio key",
};

function centsToDisplay(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100);
}

function walletBadge(status: WhopWalletBalance["status"] | undefined): BadgeColor {
  if (status === "active") return "green";
  if (status === "awaiting_kyc" || status === "pending") return "amber";
  if (status === "error") return "red";
  return "blue";
}

function pctChange(n: number | null): string {
  if (n === null) return "";
  const sign = n > 0 ? "↑" : n < 0 ? "↓" : "→";
  return `${sign} ${Math.abs(n)}% vs prior period`;
}

type AnalyticsWindow = "7d" | "30d" | "90d";

// A KPI tile — the real @naelao/ui Card, non-interactive (no hover/click affordance; these are
// numbers to read, not buttons).
function Stat({
  label,
  value,
  sub,
  badge,
  href,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  badge?: { color: BadgeColor; text: string } | undefined;
  /** When set, the whole tile becomes a real link (e.g. "Waiting on you" -> /approvals) — only
   *  worth doing for a number that has somewhere useful to go, never every tile. */
  href?: string | undefined;
}) {
  const body = (
    <Card interactive={Boolean(href)}>
      <CardLabel>{label}</CardLabel>
      <CardValue>{value}</CardValue>
      {badge ? (
        <div style={{ marginTop: 4 }}>
          <Badge color={badge.color}>{badge.text}</Badge>
        </div>
      ) : sub ? (
        <CardSub>{sub}</CardSub>
      ) : null}
    </Card>
  );
  return href ? <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>{body}</Link> : body;
}

function SectionHeading({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "26px 0 12px" }}>
      <div className="section-label" style={{ margin: 0 }}>{children}</div>
      {action}
    </div>
  );
}

// A boxed list panel — the .settings-block/.settings-row pattern used everywhere else in the
// shell (business detail, settings), with a small header row added so it can carry a title +
// count the way the rest of this dashboard's tiles do.
function Panel({
  title,
  count,
  children,
}: {
  title: string;
  count?: number | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-block" style={{ marginBottom: 0 }}>
      <div className="settings-row" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="settings-row-label" style={{ marginBottom: 0 }}>
          {title}
          {count !== undefined && <span style={{ color: "var(--text3)", fontWeight: 400, marginLeft: 6 }}>{count}</span>}
        </div>
      </div>
      <div style={{ padding: "8px 16px 12px", fontSize: 12.5, color: "var(--text2)" }}>{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ color: "var(--text3)", fontSize: 12, padding: "4px 0" }}>{children}</div>;
}

function Row({ left, right }: { left: React.ReactNode; right?: React.ReactNode | undefined }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
      <div style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{left}</div>
      {right !== undefined && <div style={{ color: "var(--text3)", fontSize: 11, flexShrink: 0 }}>{right}</div>}
    </div>
  );
}

const panelGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
  gap: 14,
};

export default function DashboardPage() {
  const product = useProduct();
  const creds = useSessionCredentials();
  const { activeSpaceId, activeSpaceName, isBusinessSpace } = useActiveSpace();

  // Assistant dashboard state (unchanged from the prior standalone page).
  const [policy, setPolicy] = React.useState<AssistantPolicy | null>(null);
  const [capabilities, setCapabilities] = React.useState<AssistantCapabilities | null>(null);
  const [memory, setMemory] = React.useState<MemoryFact[]>([]);
  const [crons, setCrons] = React.useState<ScheduledJob[]>([]);
  const [channels, setChannels] = React.useState<ChannelLink[]>([]);
  const [files, setFiles] = React.useState<WorkspaceFile[]>([]);
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [agents, setAgents] = React.useState<AgentDefinitionSummary[]>([]);

  // Business dashboard state — only fetched/rendered when the active space is a real business.
  const [me, setMe] = React.useState<ProductUserMe | null>(null);
  const [business, setBusiness] = React.useState<Business | null>(null);
  const [wallet, setWallet] = React.useState<WhopWalletBalance | null>(null);
  const [walletTx, setWalletTx] = React.useState<WhopWalletTransaction[]>([]);
  const [hasCommerce, setHasCommerce] = React.useState(false);
  const [revenue, setRevenue] = React.useState<RevenueSummary | null>(null);
  const [orders, setOrders] = React.useState<LaunchpadOrder[]>([]);
  const [members, setMembers] = React.useState<{ end_user_id: string; role: string }[]>([]);
  const [connectors, setConnectors] = React.useState<ConnectorInfo[]>([]);
  const [approvals, setApprovals] = React.useState<PendingApproval[]>([]);
  const [currentModel, setCurrentModel] = React.useState<string | null>(null);
  const [currentEffort, setCurrentEffort] = React.useState<string | null>(null);

  // Analytics — the same real GET /business-analytics rollup the dedicated /analytics page reads,
  // embedded here so the headline numbers don't need a navigation away from the overview. Fetched
  // on its own effect (keyed on the window toggle too) so switching 7d/30d/90d doesn't re-trigger
  // the whole page's "Loading…" flag or re-fetch every other panel.
  const [analytics, setAnalytics] = React.useState<BusinessAnalytics | null>(null);
  const [analyticsWindow, setAnalyticsWindow] = React.useState<AnalyticsWindow>("7d");
  const [analyticsLoading, setAnalyticsLoading] = React.useState(true);
  const [analyticsError, setAnalyticsError] = React.useState(false);

  const [loading, setLoading] = React.useState(true);
  const [savingPolicy, setSavingPolicy] = React.useState(false);
  const [savingModel, setSavingModel] = React.useState(false);
  const [controlError, setControlError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!creds || !activeSpaceId) return;
    let cancelled = false;
    setLoading(true);
    // Each panel settles independently: one unavailable endpoint must not blank the whole page.
    const settle = <T,>(p: Promise<T>, set: (v: T) => void) =>
      p.then((v) => { if (!cancelled) set(v); }).catch(() => {});

    const calls: Promise<unknown>[] = [
      settle(getAssistantPolicy(activeSpaceId, creds), setPolicy),
      settle(getAssistantCapabilities(activeSpaceId, creds), setCapabilities),
      settle(getAssistantMemory(activeSpaceId, creds), setMemory),
      settle(listScheduledJobs(activeSpaceId, creds), setCrons),
      settle(listAssistantChannels(activeSpaceId, creds), setChannels),
      settle(listAssistantFiles(activeSpaceId, creds), setFiles),
      settle(listSessions(activeSpaceId, creds), setSessions),
      settle(listAgentDefinitions(activeSpaceId, creds), setAgents),
      // The PRODUCT root, never the active business. A ProductUserDO instance is one per
      // (productId × endUserId), so asking for "me" scoped to a business 404s — which is exactly
      // why "Your credits" sat at "…" forever inside a business. Credits belong to the person at
      // product level; they are not per-business.
      settle(getMe(product.space_id, creds), setMe),
      settle(listApprovals(activeSpaceId, creds), setApprovals),
      // Always fetched (not just for a business): this is where the configured model lives for
      // any space, and it's what previously silently defaulted to an unreachable Claude id with
      // no visible control anywhere (item 79).
      getShellManifest(activeSpaceId, creds)
        .then((m) => {
          if (cancelled) return;
          setCurrentModel(m.model ?? null);
          setCurrentEffort(m.effort ?? null);
          const commerce = m.ui.sidebar_items.some((item) => item.id === "revenue");
          setHasCommerce(commerce);
          if (!commerce || !isBusinessSpace) return;
          return Promise.all([
            settle(getBusinessRevenue(activeSpaceId, creds), setRevenue),
            settle(listBusinessOrders(activeSpaceId, creds), setOrders),
          ]).then(() => undefined);
        })
        .catch(() => {}),
    ];

    if (isBusinessSpace) {
      calls.push(
        settle(
          listMyBusinesses(product.space_id, creds).then((list) => list.find((b) => b.id === activeSpaceId) ?? null),
          setBusiness
        ),
        settle(getBusinessWalletBalance(activeSpaceId, creds), setWallet),
        settle(getBusinessWalletTransactions(activeSpaceId, creds, 6), setWalletTx),
        settle(listBusinessMembers(activeSpaceId, creds), setMembers),
        settle(getConnectorStatus(activeSpaceId, creds), setConnectors)
      );
    } else {
      setBusiness(null);
      setWallet(null);
      setWalletTx([]);
      setHasCommerce(false);
      setRevenue(null);
      setOrders([]);
      setMembers([]);
      setConnectors([]);
    }

    Promise.allSettled(calls).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds, activeSpaceId, isBusinessSpace, product.space_id]);

  const [analyticsRetryTick, setAnalyticsRetryTick] = React.useState(0);
  React.useEffect(() => {
    if (!creds || !activeSpaceId) return;
    let cancelled = false;
    setAnalyticsLoading(true);
    setAnalyticsError(false);
    getBusinessAnalytics(activeSpaceId, creds, analyticsWindow)
      .then((v) => { if (!cancelled) setAnalytics(v); })
      .catch(() => { if (!cancelled) setAnalyticsError(true); })
      .finally(() => { if (!cancelled) setAnalyticsLoading(false); });
    return () => { cancelled = true; };
  }, [creds, activeSpaceId, analyticsWindow, analyticsRetryTick]);

  // item 79: the guided/autonomous toggle and model picker are real writes, not display-only —
  // gated to the same floor requireBusinessMembership enforces server-side. A plain member (or a
  // non-business/team-mode space, where an end user is never more than "member") sees the same
  // panel read-only. Ranked, not exact-match — see lib/roles.ts for why that distinction is what
  // this pass was reported for.
  const canManageAssistant = canManageSpaceSettings(isBusinessSpace, business?.role);

  async function setAutonomy(autonomous: boolean) {
    if (!activeSpaceId || !creds) return;
    setSavingPolicy(true);
    setControlError(null);
    try {
      const next = await updateAssistantPolicy(activeSpaceId, creds, { approval_mode: autonomous ? "yolo" : "always_ask" });
      setPolicy(next);
    } catch (err) {
      setControlError(err instanceof Error ? err.message : "Couldn't update autonomy");
    } finally {
      setSavingPolicy(false);
    }
  }

  async function addApprovedAction(action: string) {
    if (!activeSpaceId || !creds || !policy) return;
    setSavingPolicy(true);
    setControlError(null);
    try {
      const next = await updateAssistantPolicy(activeSpaceId, creds, {
        auto_approved_actions: [...policy.auto_approved_actions, action],
      });
      setPolicy(next);
    } catch (err) {
      setControlError(err instanceof Error ? err.message : "Couldn't update the allowlist");
    } finally {
      setSavingPolicy(false);
    }
  }

  async function removeApprovedAction(action: string) {
    if (!activeSpaceId || !creds || !policy) return;
    setSavingPolicy(true);
    setControlError(null);
    try {
      const next = await updateAssistantPolicy(activeSpaceId, creds, {
        auto_approved_actions: policy.auto_approved_actions.filter((a) => a !== action),
      });
      setPolicy(next);
    } catch (err) {
      setControlError(err instanceof Error ? err.message : "Couldn't update the allowlist");
    } finally {
      setSavingPolicy(false);
    }
  }

  async function setModel(model: string) {
    if (!activeSpaceId || !creds) return;
    setSavingModel(true);
    setControlError(null);
    try {
      const keepEffort = currentEffort && isValidEffortLevel(model, currentEffort) ? currentEffort : undefined;
      const next = await updateModelConfig(activeSpaceId, creds, model, keepEffort);
      setCurrentModel(next.model);
      setCurrentEffort(next.effort ?? keepEffort ?? null);
    } catch (err) {
      setControlError(err instanceof Error ? err.message : "Couldn't update the model");
    } finally {
      setSavingModel(false);
    }
  }

  async function setEffort(effort: string) {
    if (!activeSpaceId || !creds) return;
    setSavingModel(true);
    setControlError(null);
    try {
      const next = await updateModelConfig(activeSpaceId, creds, currentModel ?? DEFAULT_MODEL, effort);
      setCurrentEffort(next.effort ?? effort);
    } catch (err) {
      setControlError(err instanceof Error ? err.message : "Couldn't update the effort setting");
    } finally {
      setSavingModel(false);
    }
  }

  if (!creds) return null;

  const modeLabel =
    policy?.approval_mode === "yolo"
      ? "Autonomous"
      : policy?.approval_mode === "gate_unless_listed"
        ? "Guided"
        : policy?.approval_mode === "gate_listed"
          ? "Mostly autonomous"
          : policy?.approval_mode === "always_ask"
            ? "Asks before acting"
            : "—";
  const isAutonomous = policy?.approval_mode === "yolo";

  const heading = isBusinessSpace ? (business?.name ?? activeSpaceName ?? "Business") : (activeSpaceName ?? product.product_name);
  const connectedApps = connectors.filter((c) => c.connected).length;
  const availableApps = connectors.filter((c) => c.status === "available").length;

  return (
    <div className="page-view">
      <div className="page-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="page-title" style={{ marginBottom: 0 }}>{heading}</div>
            {isBusinessSpace && business && (
              <Badge color={business.space_status === "active" ? "green" : "amber"}>{business.space_status}</Badge>
            )}
          </div>
          <div className="page-subtitle">
            {isBusinessSpace
              ? `Your role: ${business?.role ?? "…"} — the assistant is always on and works across every project here.`
              : "Always on. Works across every project in this space, and can be reached over your connected channels."}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {isBusinessSpace && (
            <Link href={`/p/${product.slug}/spaces/${activeSpaceId}`} className="btn btn-secondary" style={{ textDecoration: "none" }}>
              Manage business
            </Link>
          )}
          <Link href={`/p/${product.slug}/new`} className="btn btn-primary" style={{ textDecoration: "none" }}>
            Talk to the assistant
          </Link>
        </div>
      </div>

      {loading && <div style={{ fontSize: 12.5, color: "var(--text3)", marginBottom: 14 }}>Loading…</div>}

      {/* KPI row — the numbers worth seeing at a glance. */}
      <div style={{ ...panelGrid, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 8 }}>
        <Stat label="Your credits" value={me ? String(me.credits_balance) : "…"} />
        {isBusinessSpace && (
          <Stat
            label="Wallet balance"
            value={wallet ? centsToDisplay(wallet.balance_cents ?? 0, wallet.currency) : "…"}
            badge={
              wallet && wallet.status !== "active"
                ? { color: walletBadge(wallet.status), text: wallet.status.replace("_", " ") }
                : undefined
            }
          />
        )}
        {isBusinessSpace && hasCommerce && (
          <Stat
            label={`Revenue (${revenue?.period ?? "this month"})`}
            value={revenue ? centsToDisplay(revenue.net_cents, revenue.currency) : "…"}
            sub={revenue ? `${revenue.order_count} order${revenue.order_count === 1 ? "" : "s"}` : undefined}
          />
        )}
        {isBusinessSpace && (
          <Stat label="Members" value={String(members.length)} href={`/p/${product.slug}/spaces/${activeSpaceId}`} />
        )}
        {isBusinessSpace && (
          <Stat
            label="Connected apps"
            value={String(connectedApps)}
            sub={availableApps > 0 ? `of ${availableApps} available` : undefined}
            href={`/p/${product.slug}/connectors`}
          />
        )}
        <Stat
          label="Waiting on you"
          value={String(approvals.length)}
          badge={approvals.length > 0 ? { color: "amber", text: "Needs a decision" } : undefined}
          href={approvals.length > 0 ? `/p/${product.slug}/approvals` : undefined}
        />
      </div>

      {/* Analytics — the same real GET /business-analytics rollup the dedicated /analytics page
          renders, embedded here so credit usage, run success, and background activity are visible
          without leaving the overview. */}
      <SectionHeading
        action={
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", gap: 4 }}>
              {(["7d", "30d", "90d"] as AnalyticsWindow[]).map((w) => (
                <button
                  key={w}
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={analyticsWindow === w ? { background: "var(--accent-dim)", color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
                  onClick={() => setAnalyticsWindow(w)}
                >
                  {w}
                </button>
              ))}
            </div>
            <Link href={`/p/${product.slug}/analytics`} style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>
              Full page →
            </Link>
          </div>
        }
      >
        Analytics
      </SectionHeading>

      {analyticsLoading && !analytics && <div style={{ fontSize: 12.5, color: "var(--text3)", marginBottom: 10 }}>Loading…</div>}
      {analyticsError && (
        <div style={{ fontSize: 12.5, color: "#dc2626", marginBottom: 10 }}>
          Couldn&apos;t load analytics.{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAnalyticsRetryTick((t) => t + 1)}>
            Retry
          </button>
        </div>
      )}

      {analytics && (
        <>
          <div className="grid-4" style={{ marginBottom: 20 }}>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Credits used</div>
              <div className="card-value">{analytics.credits.used.toLocaleString()}</div>
              {analytics.credits.vs_prior_period !== null && (
                <div className="card-sub" style={{ color: analytics.credits.vs_prior_period > 0 ? "#16a34a" : "#dc2626" }}>
                  {pctChange(analytics.credits.vs_prior_period)}
                </div>
              )}
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Agent runs</div>
              <div className="card-value">{analytics.runs.total.toLocaleString()}</div>
              <div className="card-sub">Across {analytics.by_agent.length} agent{analytics.by_agent.length === 1 ? "" : "s"}</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Success rate</div>
              <div className="card-value">{analytics.runs.success_rate !== null ? `${Math.round(analytics.runs.success_rate * 100)}%` : "—"}</div>
              <div className="card-sub">{analytics.runs.failed} failed of {analytics.runs.total}</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Tokens used</div>
              <div className="card-value">{analytics.tokens_used >= 1000 ? `${(analytics.tokens_used / 1000).toFixed(1)}k` : analytics.tokens_used}</div>
              <div className="card-sub">This period</div>
            </div>
          </div>

          <div className="card" style={{ cursor: "default", padding: "16px 18px 12px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text2)", marginBottom: 10 }}>
              Credit usage — last {analytics.window_days} days
            </div>
            {analytics.daily.every((d) => d.credits === 0) ? (
              <div style={{ color: "var(--text3)", fontSize: 12, padding: "16px 0", textAlign: "center" }}>No activity yet in this window.</div>
            ) : (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 76 }}>
                {analytics.daily.map((d) => {
                  const maxCredits = Math.max(1, ...analytics.daily.map((x) => x.credits));
                  return (
                    <div key={d.day} title={`${d.day}: ${d.credits} credits, ${d.runs} runs`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <div
                        style={{
                          width: "100%",
                          borderRadius: 3,
                          background: "var(--accent)",
                          opacity: d.credits > 0 ? 1 : 0.15,
                          height: Math.max(2, (d.credits / maxCredits) * 68),
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Structure + heartbeats — pulled out of a buried settings-block into real stat tiles.
              The assistant wakes on its own via heartbeats/crons whether or not anyone is watching;
              this is what makes that background work (and when it's failing) actually visible,
              alongside how much workspace (projects/threads) it's operating across. */}
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text3)", letterSpacing: "0.04em", textTransform: "uppercase", margin: "0 0 8px" }}>
            Background activity — heartbeats &amp; workspace
          </div>
          <div className="grid-4" style={{ marginBottom: 10 }}>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Projects</div>
              <div className="card-value">{analytics.structure.projects}</div>
              <div className="card-sub">Workspaces in this business</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Threads</div>
              <div className="card-value">{analytics.structure.threads}</div>
              <div className="card-sub">Across all projects</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Heartbeats — did work</div>
              <div className="card-value" style={{ color: analytics.heartbeats.completed_with_work > 0 ? "#16a34a" : undefined }}>
                {analytics.heartbeats.completed_with_work}
              </div>
              <div className="card-sub">Wake-ups that took real action</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Heartbeats — failed</div>
              <div className="card-value" style={{ color: analytics.heartbeats.failed > 0 ? "#dc2626" : undefined }}>
                {analytics.heartbeats.failed}
              </div>
              <div className="card-sub">
                {analytics.heartbeats.failed + analytics.heartbeats.completed_with_work > 0
                  ? `${Math.round((analytics.heartbeats.failed / Math.max(1, analytics.heartbeats.failed + analytics.heartbeats.completed_with_work)) * 100)}% of wake-ups`
                  : "No wake-ups yet"}
              </div>
            </div>
          </div>

          {/* Per-trigger failure breakdown — which KIND of wake-up (channel heartbeat, scheduled
              job, connector poll, digest) is actually failing, not just an aggregate count. Only
              rendered when something has actually failed — an all-green row for every trigger
              would just be noise on top of the tile above. */}
          {analytics.heartbeats.by_trigger.some((t) => t.failed > 0) && (
            <div className="settings-block" style={{ marginBottom: 20 }}>
              <div className="settings-row" style={{ borderBottom: "1px solid var(--border)" }}>
                <div className="settings-row-label" style={{ marginBottom: 0 }}>Failures by trigger</div>
              </div>
              {analytics.heartbeats.by_trigger
                .filter((t) => t.failed > 0)
                .sort((a, b) => b.failed - a.failed)
                .map((t) => (
                  <div className="settings-row" key={t.trigger}>
                    <div className="settings-row-label" style={{ fontSize: 12.5, marginBottom: 0, textTransform: "capitalize" }}>
                      {t.trigger.replace(/_/g, " ")}
                    </div>
                    <span className="badge badge-amber">{t.failed} failed</span>
                  </div>
                ))}
            </div>
          )}

          {analytics.by_agent.length > 0 && (
            <div style={{ marginBottom: 8, overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr><th>Agent</th><th>Runs</th><th>Credits</th><th>Success rate</th></tr>
                </thead>
                <tbody>
                  {analytics.by_agent.slice(0, 5).map((a) => (
                    <tr key={a.agent_id}>
                      <td className="cell-primary">{a.agent_id}</td>
                      <td>{a.runs}</td>
                      <td>{a.credits}</td>
                      <td>
                        {a.success_rate !== null ? (
                          <span className={`badge ${a.success_rate >= 0.95 ? "badge-green" : a.success_rate >= 0.8 ? "badge-amber" : "badge-red"}`}>
                            {Math.round(a.success_rate * 100)}%
                          </span>
                        ) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {isBusinessSpace && (
        <>
          <SectionHeading action={<Link href={`/p/${product.slug}/spaces/${activeSpaceId}`} style={{ fontSize: 12, color: "var(--accent)" }}>Manage →</Link>}>
            Business
          </SectionHeading>
          <div style={panelGrid}>
            <Panel title="Wallet">
              {wallet?.status === "awaiting_kyc" && (
                <div style={{ marginBottom: 8, color: "var(--amber, #b45309)" }}>
                  Verification needed before payouts work.
                  {wallet.onboarding_url && (
                    <>
                      {" "}
                      <a href={wallet.onboarding_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                        Complete verification
                      </a>
                    </>
                  )}
                </div>
              )}
              {walletTx.length === 0 ? (
                <Empty>No transactions yet.</Empty>
              ) : (
                walletTx.map((t, i) => (
                  <Row
                    key={i}
                    left={t.description ?? t.type}
                    right={
                      <span style={{ color: t.amount_cents >= 0 ? "var(--green, #16a34a)" : "inherit" }}>
                        {t.amount_cents >= 0 ? "+" : ""}{centsToDisplay(t.amount_cents, t.currency)}
                      </span>
                    }
                  />
                ))
              )}
            </Panel>

            {hasCommerce && (
              <Panel title="Recent orders" count={orders.length}>
                {orders.length === 0 ? (
                  <Empty>No orders yet.</Empty>
                ) : (
                  orders.slice(0, 6).map((o) => (
                    <Row
                      key={o.id}
                      left={o.product_name ?? "Unknown product"}
                      right={
                        <>
                          {centsToDisplay(o.net_cents, o.currency)}{" "}
                          <Badge color={o.status === "fulfilled" || o.status === "paid" ? "green" : o.status === "refunded" || o.status === "failed" ? "red" : "amber"}>
                            {o.status}
                          </Badge>
                        </>
                      }
                    />
                  ))
                )}
              </Panel>
            )}

            <Panel title="Connected apps" count={connectors.length}>
              {connectors.length === 0 ? (
                <Empty>Couldn&apos;t read the connector list.</Empty>
              ) : (
                connectors
                  .filter((c) => c.status === "available")
                  .map((c) => <Row key={c.id} left={c.name} right={c.connected ? <Badge color="green">Connected</Badge> : "Not connected"} />)
              )}
            </Panel>

            <Panel title="Members" count={members.length}>
              {members.length === 0 ? (
                <Empty>No other members.</Empty>
              ) : (
                members.map((m) => <Row key={m.end_user_id} left={m.end_user_id} right={m.role} />)
              )}
            </Panel>
          </div>
        </>
      )}

      <SectionHeading
        action={
          <Link href={`/p/${product.slug}/dashboard/assistant`} style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>
            Assistant settings →
          </Link>
        }
      >
        Assistant
      </SectionHeading>
      <div style={panelGrid}>
        <Panel title="Configuration">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div>
              <Row left="Autonomy" right={canManageAssistant ? undefined : modeLabel} />
              {!canManageAssistant && (
                <div style={{ fontSize: 11, color: "var(--text3)" }}>
                  {isAutonomous ? "Acts without asking first." : "Asks before scaffolding a project or spending anything."}
                </div>
              )}
            </div>
            {canManageAssistant && (
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  className={isAutonomous ? "btn btn-secondary" : "btn btn-primary"}
                  disabled={savingPolicy || !isAutonomous}
                  onClick={() => void setAutonomy(false)}
                  style={{ padding: "4px 10px", fontSize: 11.5 }}
                >
                  Guided
                </button>
                <button
                  type="button"
                  className={isAutonomous ? "btn btn-primary" : "btn btn-secondary"}
                  disabled={savingPolicy || isAutonomous}
                  onClick={() => void setAutonomy(true)}
                  style={{ padding: "4px 10px", fontSize: 11.5 }}
                >
                  Autonomous
                </button>
              </div>
            )}
          </div>
          <Row left="Pre-approved actions" right={String(policy?.auto_approved_actions?.length ?? 0)} />
          <ApprovedActionsEditor
            actions={policy?.auto_approved_actions ?? []}
            canEdit={canManageAssistant}
            busy={savingPolicy}
            onAdd={(a) => void addApprovedAction(a)}
            onRemove={(a) => void removeApprovedAction(a)}
          />

          <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 12.5 }}>Model</span>
              {canManageAssistant ? (
                <select
                  value={currentModel ?? DEFAULT_MODEL}
                  disabled={savingModel}
                  onChange={(e) => void setModel(e.target.value)}
                  style={{
                    fontSize: 11.5, padding: "3px 6px", borderRadius: 6, border: "1px solid var(--border)",
                    background: "var(--bg)", color: "var(--text1)", maxWidth: 220,
                  }}
                >
                  {ALLOWED_MODELS.map((m) => (
                    <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>
                  ))}
                </select>
              ) : (
                <span style={{ fontSize: 11.5, color: "var(--text3)" }}>
                  {MODEL_LABELS[currentModel ?? DEFAULT_MODEL] ?? currentModel ?? DEFAULT_MODEL}
                </span>
              )}
            </div>
          </div>

          <div style={{ marginTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 12.5 }}>Effort</span>
              {canManageAssistant ? (
                <select
                  value={currentEffort ?? "low"}
                  disabled={savingModel}
                  onChange={(e) => void setEffort(e.target.value)}
                  style={{
                    fontSize: 11.5, padding: "3px 6px", borderRadius: 6, border: "1px solid var(--border)",
                    background: "var(--bg)", color: "var(--text1)", maxWidth: 220,
                  }}
                >
                  {effortOptionsForModel(currentModel ?? DEFAULT_MODEL).map((opt) => (
                    <option key={opt.level} value={opt.level}>{opt.label}</option>
                  ))}
                </select>
              ) : (
                <span style={{ fontSize: 11.5, color: "var(--text3)" }}>
                  {effortOptionsForModel(currentModel ?? DEFAULT_MODEL).find((o) => o.level === (currentEffort ?? "low"))?.label ?? "Low"}
                </span>
              )}
            </div>
            <p style={{ fontSize: 10.5, color: "var(--text3)", margin: "4px 0 0", lineHeight: 1.5 }}>
              How far it can reach for a pricier model when it delegates work.
            </p>
          </div>

          {controlError && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: "#dc2626" }}>{controlError}</div>
          )}
          {!canManageAssistant && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text3)" }}>
              {isBusinessSpace
                ? "Only the owner or an admin of this business can change autonomy or model."
                : "Changed by the space owner in the builder dashboard."}
            </div>
          )}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
            <Link href={`/p/${product.slug}/dashboard/assistant`} style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>
              All assistant settings →
            </Link>
          </div>
        </Panel>

        <Panel title="Built-in scripts" count={capabilities?.prebuilt_count}>
          {capabilities?.prebuilts?.length ? (
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {capabilities.prebuilts.map((p) => (
                <Row key={p.name} left={<span title={p.description}>{p.name}</span>} right={`${p.operations.length} ops`} />
              ))}
            </div>
          ) : (
            <Empty>Couldn&apos;t read the capability list.</Empty>
          )}
        </Panel>

        <Panel title="Learned skills" count={capabilities?.skill_count}>
          {capabilities?.skills?.length ? (
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {capabilities.skills.map((s) => <Row key={s.name} left={s.name} />)}
            </div>
          ) : (
            <Empty>
              None yet. The assistant writes these itself as it solves things — they build up with use rather than
              being added by hand.
            </Empty>
          )}
        </Panel>

        <Panel title="Recent conversations" count={sessions.length}>
          {sessions.length === 0 ? (
            <Empty>No conversations yet.</Empty>
          ) : (
            sessions.slice(0, 8).map((s) => (
              <Row
                key={s.id}
                left={
                  <Link href={`/p/${product.slug}/sessions/${s.id}`} style={{ color: "var(--text2)", textDecoration: "none" }}>
                    {s.title || "Untitled conversation"}
                  </Link>
                }
                right={relativeTime(s.updated_at || s.created_at)}
              />
            ))
          )}
        </Panel>

        <Panel title="What it remembers" count={memory.length}>
          {memory.length === 0 ? (
            <Empty>Nothing learned yet.</Empty>
          ) : (
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {memory.slice(0, 20).map((m, i) => (
                <Row
                  key={`${m.key}-${i}`}
                  left={`${m.key}: ${typeof m.value === "string" ? m.value : JSON.stringify(m.value)}`}
                  right={m.category}
                />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Scheduled work" count={crons.length}>
          {crons.length === 0 ? (
            <Empty>Nothing scheduled. Ask the assistant to do something on a recurring basis and it will appear here.</Empty>
          ) : (
            crons.map((j) => <Row key={j.id} left={j.name || j.id} right={j.enabled ? j.cron_expression : "paused"} />)
          )}
        </Panel>

        <Panel title="Channels" count={channels.length}>
          {channels.length === 0 ? (
            <Empty>No channels connected. Connect Slack, Discord, email or WhatsApp to reach the assistant there.</Empty>
          ) : (
            channels.map((c) => (
              <Row key={c.channel} left={<span style={{ textTransform: "capitalize" }}>{c.channel}</span>} right={c.enabled ? "Connected" : "Off"} />
            ))
          )}
        </Panel>

        <Panel title="Agents in this space" count={agents.length}>
          {agents.length === 0 ? (
            <Empty>No specialist agents configured.</Empty>
          ) : (
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {agents.slice(0, 10).map((a) => (
                <Row
                  key={a.id}
                  left={
                    <Link href={`/p/${product.slug}/agents/${encodeURIComponent(a.id)}`} style={{ color: "var(--text2)", textDecoration: "none" }}>
                      {a.name || a.id}
                    </Link>
                  }
                  right={
                    <Link href={`/p/${product.slug}/agents/${encodeURIComponent(a.id)}`} style={{ color: "var(--accent)", textDecoration: "none" }}>
                      Configure
                    </Link>
                  }
                />
              ))}
            </div>
          )}
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
            <Link href={`/p/${product.slug}/agents`} style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>
              All agents →
            </Link>
          </div>
        </Panel>

        <Panel title="Workspace files" count={files.length}>
          {files.length === 0 ? (
            <Empty>No files yet.</Empty>
          ) : (
            <div style={{ maxHeight: 200, overflowY: "auto" }}>
              {files.slice(0, 25).map((f) => (
                <Row key={f.path} left={f.path} right={`${Math.max(1, Math.round(f.size / 1024))} KB`} />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
