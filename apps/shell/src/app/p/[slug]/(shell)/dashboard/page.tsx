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
import { ALLOWED_MODELS } from "@naelao/billing-core";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
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
} from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";

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

// A KPI tile — the real @naelao/ui Card, non-interactive (no hover/click affordance; these are
// numbers to read, not buttons).
function Stat({
  label,
  value,
  sub,
  badge,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  badge?: { color: BadgeColor; text: string } | undefined;
}) {
  return (
    <Card interactive={false}>
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
  const { session } = useProductAuth();
  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;
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
      settle(getMe(activeSpaceId, creds), setMe),
      settle(listApprovals(activeSpaceId, creds), setApprovals),
      // Always fetched (not just for a business): this is where the configured model lives for
      // any space, and it's what previously silently defaulted to an unreachable Claude id with
      // no visible control anywhere (item 79).
      getShellManifest(activeSpaceId, creds)
        .then((m) => {
          if (cancelled) return;
          setCurrentModel(m.model ?? null);
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

  // item 79: the guided/autonomous toggle and model picker are real writes, not display-only —
  // gated to a business admin, the same floor requireBusinessMembership enforces server-side.
  // A plain member (or a non-business/team-mode space, where an end user is never more than
  // "member") sees the same panel read-only, same as before this pass.
  const canManageAssistant = isBusinessSpace && business?.role === "admin";

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

  async function setModel(model: string) {
    if (!activeSpaceId || !creds) return;
    setSavingModel(true);
    setControlError(null);
    try {
      const next = await updateModelConfig(activeSpaceId, creds, model);
      setCurrentModel(next.model);
    } catch (err) {
      setControlError(err instanceof Error ? err.message : "Couldn't update the model");
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
          <Link href={`/p/${product.slug}/dashboard/chat`} className="btn btn-primary" style={{ textDecoration: "none" }}>
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
            sub={revenue ? `${revenue.orders} order${revenue.orders === 1 ? "" : "s"}` : undefined}
          />
        )}
        {isBusinessSpace && <Stat label="Members" value={String(members.length)} />}
        {isBusinessSpace && (
          <Stat label="Connected apps" value={String(connectedApps)} sub={availableApps > 0 ? `of ${availableApps} available` : undefined} />
        )}
        <Stat
          label="Waiting on you"
          value={String(approvals.length)}
          badge={approvals.length > 0 ? { color: "amber", text: "Needs a decision" } : undefined}
        />
      </div>

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

      <SectionHeading>Assistant</SectionHeading>
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
          {policy?.auto_approved_actions?.length ? (
            <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text3)", lineHeight: 1.6 }}>
              {policy.auto_approved_actions.join(", ")}
            </div>
          ) : (
            <Empty>Every action is confirmed with you before it happens.</Empty>
          )}

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

          {controlError && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: "#dc2626" }}>{controlError}</div>
          )}
          {!canManageAssistant && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text3)" }}>
              {isBusinessSpace ? "Only a business admin can change autonomy or model." : "Changed by the space owner in the builder dashboard."}
            </div>
          )}
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
            agents.slice(0, 10).map((a) => <Row key={a.id} left={a.name || a.id} />)
          )}
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
