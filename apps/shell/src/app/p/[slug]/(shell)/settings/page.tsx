"use client";


// Settings — reorganized around the mockup's `.settings-nav` sidebar (apps/launchpad/src/index.html
// #settings-view): General / Members / Billing / Connected Apps / AI & Models, plus a Personal tab
// that's always there regardless of role. Scoped to whichever space is currently active
// (useActiveSpace) — a business's own settings when one is selected, the product root's own
// (much smaller) settings otherwise.
//
// Deliberately NOT a rebuild of /spaces/:businessId (the deeper business-operations page — revenue,
// orders, products, local machine grants). This is the identity/access/config surface the mockup's
// Settings view covers; that page stays the place for running the business day to day.
//
// Role gating follows canManageSpaceSettings exactly (the same helper the Dashboard tab uses,
// itself written after a real bug where an exact "admin" string match locked out a business's own
// owner) — a plain member always gets a real, honest read-only view rather than a hidden tab, since
// seeing what's configured without being able to change it is not the same bug class as not being
// told a control exists at all.

import * as React from "react";
import Link from "next/link";
import { Badge, Button, FormInput, FormSelect, Toggle, type BadgeColor } from "@naelao/ui";
import { ALLOWED_MODELS, effortOptionsForModel } from "@naelao/billing-core";
import { useProduct } from "@/lib/product-context";
import { useSessionCredentials } from "@/lib/auth-provider";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { useRouter } from "next/navigation";
import { canManageSpaceSettings } from "@/lib/roles";
import {
  getMe,
  deleteMe,
  listMyBusinesses,
  getShellManifest,
  listBusinessMembers,
  inviteToBusiness,
  removeBusinessMember,
  getBusinessWalletBalance,
  getPricing,
  checkoutBusinessSubscription,
  checkoutCreditPack,
  getAssistantPolicy,
  updateAssistantPolicy,
  updateModelConfig,
  getByokStatus,
  setByokKey,
  selectByokKey,
  deleteByokKey,
  getConnectorStatus,
  type ProductUserMe,
  type Business,
  type ShellManifest,
  type BusinessMember,
  type WhopWalletBalance,
  type PricingPlan,
  type CreditPack,
  type AssistantPolicy,
  type ConnectorInfo,
  type ByokProviderStatus,
} from "@/lib/api";

const MODEL_LABELS: Record<string, string> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "Llama 3.3 70B — balanced default",
  "@cf/meta/llama-4-scout-17b-16e-instruct": "Llama 4 Scout — fast",
  "@cf/openai/gpt-oss-120b": "GPT-OSS 120B — most capable",
  "@cf/openai/gpt-oss-20b": "GPT-OSS 20B — cheap",
  "@cf/qwen/qwen3-30b-a3b-fp8": "Qwen3 30B",
  "@cf/mistralai/mistral-small-3.1-24b-instruct": "Mistral Small",
  "@cf/ibm-granite/granite-4.0-h-micro": "Granite Micro — cheapest",
  "google-ai-studio/gemini-flash-lite-latest": "Gemini Flash-Lite — needs a Google AI Studio key",
  "google-ai-studio/gemini-flash-latest": "Gemini Flash — needs a Google AI Studio key",
  "google-ai-studio/gemini-pro-latest": "Gemini Pro — needs a Google AI Studio key",
  "groq/llama-3.3-70b-versatile": "Groq Llama 3.3 70B — needs a Groq key",
  "groq/llama-3.1-8b-instant": "Groq Llama 3.1 8B — needs a Groq key",
};

type TabId = "general" | "members" | "billing" | "apps" | "ai" | "personal";

function centsToDisplay(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100);
}

function walletBadge(status: WhopWalletBalance["status"] | undefined): BadgeColor {
  if (status === "active") return "green";
  if (status === "awaiting_kyc" || status === "pending") return "amber";
  if (status === "error") return "red";
  return "blue";
}

const TAB_ICONS: Record<TabId, React.ReactNode> = {
  general: (
    <svg viewBox="0 0 16 16" fill="none" strokeWidth="1.5" stroke="currentColor"><circle cx="8" cy="8" r="2.5" /><path d="M8 1V2.5M8 13.5V15M1 8H2.5M13.5 8H15M3.2 3.2L4.3 4.3M11.7 11.7L12.8 12.8" /></svg>
  ),
  members: (
    <svg viewBox="0 0 16 16" fill="none" strokeWidth="1.5" stroke="currentColor"><circle cx="8" cy="5" r="3" /><path d="M2 14C2 11.2 4.7 9 8 9S14 11.2 14 14" /></svg>
  ),
  billing: (
    <svg viewBox="0 0 16 16" fill="none" strokeWidth="1.5" stroke="currentColor"><rect x="2" y="4" width="12" height="9" rx="1" /><line x1="2" y1="8" x2="14" y2="8" /><line x1="5" y1="11" x2="7" y2="11" /></svg>
  ),
  apps: (
    <svg viewBox="0 0 16 16" fill="none" strokeWidth="1.5" stroke="currentColor"><rect x="3" y="7" width="10" height="7" rx="1" /><path d="M5 7V5C5 3.3 6.3 2 8 2S11 3.3 11 5V7" /></svg>
  ),
  ai: (
    <svg viewBox="0 0 16 16" fill="none" strokeWidth="1.5" stroke="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /><circle cx="6" cy="7" r="1" /><circle cx="10" cy="7" r="1" /><path d="M6 10C6 10 7 11 10 10" /></svg>
  ),
  personal: (
    <svg viewBox="0 0 16 16" fill="none" strokeWidth="1.5" stroke="currentColor"><circle cx="8" cy="5.5" r="3" /><path d="M2.5 14C2.5 10.7 5 8.5 8 8.5S13.5 10.7 13.5 14" /></svg>
  ),
};

export default function SettingsPage() {
  const product = useProduct();
  const router = useRouter();
  const creds = useSessionCredentials();
  const { session, signOut } = useProductAuth();
  const { activeSpaceId, activeSpaceName, isBusinessSpace } = useActiveSpace();

  const [tab, setTab] = React.useState<TabId>("general");
  const [me, setMe] = React.useState<ProductUserMe | null>(null);
  const [business, setBusiness] = React.useState<Business | null>(null);
  const [manifest, setManifest] = React.useState<ShellManifest | null>(null);
  const [members, setMembers] = React.useState<BusinessMember[]>([]);
  const [wallet, setWallet] = React.useState<WhopWalletBalance | null>(null);
  const [plans, setPlans] = React.useState<PricingPlan[]>([]);
  const [packs, setPacks] = React.useState<CreditPack[]>([]);
  const [policy, setPolicy] = React.useState<AssistantPolicy | null>(null);
  const [connectors, setConnectors] = React.useState<ConnectorInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);

  const load = React.useCallback(() => {
    if (!creds) return;
    setLoading(true);
    setLoadError(false);
    const settle = <T,>(p: Promise<T>, set: (v: T) => void) => p.then(set).catch(() => {});
    Promise.allSettled([
      settle(getMe(product.space_id, creds), setMe),
      settle(getShellManifest(activeSpaceId, creds), setManifest),
      settle(getAssistantPolicy(activeSpaceId, creds), setPolicy),
      isBusinessSpace
        ? settle(
            listMyBusinesses(product.space_id, creds).then((list) => list.find((b) => b.id === activeSpaceId) ?? null),
            setBusiness
          )
        : Promise.resolve(),
      isBusinessSpace ? settle(listBusinessMembers(activeSpaceId, creds), setMembers) : Promise.resolve(),
      isBusinessSpace ? settle(getBusinessWalletBalance(activeSpaceId, creds), setWallet) : Promise.resolve(),
      isBusinessSpace
        ? settle(getPricing(activeSpaceId, creds), (r) => { setPlans(r.plans); setPacks(r.credit_packs); })
        : Promise.resolve(),
      isBusinessSpace ? settle(getConnectorStatus(activeSpaceId, creds), setConnectors) : Promise.resolve(),
    ]).finally(() => setLoading(false));
  }, [creds, product.space_id, activeSpaceId, isBusinessSpace]);

  React.useEffect(() => { load(); }, [load]);

  const canManage = canManageSpaceSettings(isBusinessSpace, business?.role);

  const tabs: TabId[] = isBusinessSpace
    ? ["general", "members", "billing", "apps", "ai", "personal"]
    : ["general", "ai", "personal"];

  return (
    <div className="settings-layout" style={{ minHeight: "calc(100vh - 52px)" }}>
      <div className="settings-nav">
        {tabs.map((t) => (
          <div
            key={t}
            className={`settings-nav-item${tab === t ? " active" : ""}`}
            onClick={() => setTab(t)}
          >
            {TAB_ICONS[t]}
            {t === "general" && "General"}
            {t === "members" && "Members"}
            {t === "billing" && "Billing"}
            {t === "apps" && "Connected Apps"}
            {t === "ai" && "AI & Models"}
            {t === "personal" && "Personal"}
          </div>
        ))}
      </div>

      <div className="settings-content">
        {tab === "general" && (
          <GeneralTab
            isBusinessSpace={isBusinessSpace}
            business={business}
            activeSpaceName={activeSpaceName}
            activeSpaceId={activeSpaceId}
            productName={product.product_name}
            manifest={manifest}
          />
        )}

        {tab === "members" && isBusinessSpace && (
          <MembersTab
            spaceId={activeSpaceId}
            creds={creds}
            members={members}
            canManage={canManage}
            onChanged={load}
          />
        )}

        {tab === "billing" && isBusinessSpace && (
          <BillingTab
            spaceId={activeSpaceId}
            creds={creds}
            wallet={wallet}
            plans={plans}
            packs={packs}
            canManage={canManage}
            me={me}
          />
        )}

        {tab === "apps" && isBusinessSpace && (
          <AppsTab spaceId={activeSpaceId} connectors={connectors} slug={product.slug} />
        )}

        {tab === "ai" && (
          <AiTab
            spaceId={activeSpaceId}
            creds={creds}
            policy={policy}
            canManage={canManage}
            onChanged={(p) => setPolicy(p)}
          />
        )}

        {tab === "personal" && (
          <PersonalTab
            me={me}
            session={session}
            productSlug={product.slug}
            productSpaceId={product.space_id}
            signOut={signOut}
            router={router}
          />
        )}

        {loading && <div style={{ color: "var(--text3)", fontSize: 12.5, marginTop: 8 }}>Loading…</div>}
        {loadError && <div style={{ color: "#dc2626", fontSize: 12.5, marginTop: 8 }}>Some settings couldn't be loaded. <button className="btn btn-ghost btn-sm" onClick={load}>Retry</button></div>}
      </div>
    </div>
  );
}

// ── General ─────────────────────────────────────────────────────────────────

function GeneralTab({
  isBusinessSpace,
  business,
  activeSpaceName,
  activeSpaceId,
  productName,
  manifest,
}: {
  isBusinessSpace: boolean;
  business: Business | null;
  activeSpaceName: string | null;
  activeSpaceId: string;
  productName: string;
  manifest: ShellManifest | null;
}) {
  return (
    <div>
      <div className="settings-section-title">General</div>
      <div className="settings-section-sub">
        {isBusinessSpace ? "Basic information about this business." : "Basic information about this product."}
      </div>
      <div className="settings-block">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">{isBusinessSpace ? "Business name" : "Product name"}</div>
            <div className="settings-row-sub">Renaming happens from the builder dashboard.</div>
          </div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{activeSpaceName ?? productName}</div>
        </div>
        {isBusinessSpace && business && (
          <>
            <div className="settings-row">
              <div><div className="settings-row-label">Your role</div></div>
              <Badge color={business.role === "owner" ? "purple" : business.role === "admin" ? "blue" : "amber"}>{business.role}</Badge>
            </div>
            <div className="settings-row">
              <div><div className="settings-row-label">Status</div></div>
              <Badge color={business.space_status === "active" ? "green" : "amber"}>{business.space_status}</Badge>
            </div>
            {business.template_id && (
              <div className="settings-row">
                <div><div className="settings-row-label">Template</div></div>
                <code style={{ fontSize: 12, color: "var(--text2)" }}>{business.template_id}</code>
              </div>
            )}
            <div className="settings-row">
              <div><div className="settings-row-label">Member since</div></div>
              <div style={{ fontSize: 12.5, color: "var(--text2)" }}>{new Date(business.joined_at).toLocaleDateString()}</div>
            </div>
          </>
        )}
        <div className="settings-row">
          <div><div className="settings-row-label">Space ID</div></div>
          <code style={{ fontSize: 11.5, color: "var(--text3)" }}>{activeSpaceId}</code>
        </div>
        {manifest?.space_type_id && (
          <div className="settings-row">
            <div><div className="settings-row-label">Space type</div></div>
            <code style={{ fontSize: 12, color: "var(--text2)" }}>{manifest.space_type_id}</code>
          </div>
        )}
      </div>
      {isBusinessSpace && (
        <div className="settings-block" style={{ padding: "12px 16px", fontSize: 12.5, color: "var(--text3)" }}>
          Deleting a business is a builder-only action today — ask whoever manages the product if
          this business needs to be removed.
        </div>
      )}
    </div>
  );
}

// ── Members ─────────────────────────────────────────────────────────────────

function MembersTab({
  spaceId,
  creds,
  members,
  canManage,
  onChanged,
}: {
  spaceId: string;
  creds: { sessionToken: string; endUserId: string } | null;
  members: BusinessMember[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<"member" | "admin">("member");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [inviteLink, setInviteLink] = React.useState<string | null>(null);

  async function handleInvite() {
    if (!creds || !email.trim()) return;
    setBusy(true);
    setError(null);
    setInviteLink(null);
    try {
      const res = await inviteToBusiness(spaceId, creds, { email: email.trim(), role });
      setInviteLink((res as { invite_url?: string }).invite_url ?? null);
      setEmail("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(endUserId: string) {
    if (!creds) return;
    try {
      await removeBusinessMember(spaceId, endUserId, creds);
      onChanged();
    } catch { /* surfaced implicitly by the list not changing */ }
  }

  return (
    <div>
      <div className="settings-section-title">Members</div>
      <div className="settings-section-sub">Who has access to this business.</div>

      <div className="settings-block">
        {members.length === 0 ? (
          <div style={{ padding: "14px 16px", fontSize: 12.5, color: "var(--text3)" }}>No members yet.</div>
        ) : (
          members.map((m) => (
            <div key={m.end_user_id} className="settings-row">
              <div>
                <div className="settings-row-label" style={{ fontFamily: "monospace", fontSize: 12 }}>{m.end_user_id.slice(0, 8)}…</div>
                <div className="settings-row-sub">Joined {new Date(m.joined_at).toLocaleDateString()}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Badge color={m.role === "owner" ? "purple" : m.role === "admin" ? "blue" : "amber"}>{m.role}</Badge>
                {canManage && m.role !== "owner" && (
                  <button className="btn btn-ghost btn-sm" onClick={() => handleRemove(m.end_user_id)}>Remove</button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {canManage && (
        <div className="settings-block">
          <div className="settings-row" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
            <div className="settings-row-label">Invite a member</div>
            <div style={{ display: "flex", gap: 8, width: "100%", flexWrap: "wrap" }}>
              <FormInput
                type="email"
                placeholder="email@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ flex: 1, minWidth: 200 }}
              />
              <FormSelect value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")} style={{ minWidth: 120 }}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </FormSelect>
              <Button onClick={handleInvite} disabled={busy || !email.trim()}>{busy ? "Sending…" : "Invite"}</Button>
            </div>
            {error && <div style={{ color: "#dc2626", fontSize: 12.5 }}>{error}</div>}
            {inviteLink && (
              <div style={{ fontSize: 12, color: "var(--text2)" }}>
                Invite created. Share this link: <code style={{ fontSize: 11 }}>{inviteLink}</code>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Billing ─────────────────────────────────────────────────────────────────

function BillingTab({
  spaceId,
  creds,
  wallet,
  plans,
  packs,
  canManage,
  me,
}: {
  spaceId: string;
  creds: { sessionToken: string; endUserId: string } | null;
  wallet: WhopWalletBalance | null;
  plans: PricingPlan[];
  packs: CreditPack[];
  canManage: boolean;
  me: ProductUserMe | null;
}) {
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [checkoutNotice, setCheckoutNotice] = React.useState<string | null>(null);

  async function subscribe(planId: string) {
    if (!creds) return;
    setBusyId(planId);
    setCheckoutNotice(null);
    try {
      const { checkout_url, dev } = await checkoutBusinessSubscription(spaceId, creds, planId);
      // dev:true means no real Lemon Squeezy/Whop credentials are configured — checkout_url is a
      // deterministic placeholder (checkout.naelao.com) that doesn't resolve to anything.
      // Navigating there was the literal dead link; say so instead.
      if (dev) setCheckoutNotice("Payments aren't configured for this business yet.");
      else if (checkout_url) window.location.href = checkout_url;
    } catch { setCheckoutNotice("Couldn't start checkout — try again in a moment."); } finally { setBusyId(null); }
  }

  async function buyPack(packId: string) {
    if (!creds) return;
    setBusyId(packId);
    setCheckoutNotice(null);
    try {
      const { checkout_url, dev } = await checkoutCreditPack(spaceId, creds, packId);
      if (dev) setCheckoutNotice("Payments aren't configured for this business yet.");
      else if (checkout_url) window.location.href = checkout_url;
    } catch { setCheckoutNotice("Couldn't start checkout — try again in a moment."); } finally { setBusyId(null); }
  }

  return (
    <div>
      <div className="settings-section-title">Billing</div>
      <div className="settings-section-sub">This business's wallet, plan, and credits.</div>

      <div className="settings-block">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Business wallet</div>
            <div className="settings-row-sub">Revenue and payouts for this business.</div>
          </div>
          <Badge color={walletBadge(wallet?.status)}>{wallet?.status ?? "loading…"}</Badge>
        </div>
        {wallet?.status === "active" && wallet.balance_cents !== undefined && (
          <div className="settings-row">
            <div><div className="settings-row-label">Available balance</div></div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{centsToDisplay(wallet.balance_cents, wallet.currency)}</div>
          </div>
        )}
        {me && (
          <div className="settings-row">
            <div><div className="settings-row-label">Your credits</div><div className="settings-row-sub">Personal balance, this product.</div></div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{me.credits_balance}</div>
          </div>
        )}
      </div>

      {checkoutNotice && (
        <p style={{ fontSize: 12, color: "var(--warning, #f5a623)", padding: "0 2px 8px" }}>{checkoutNotice}</p>
      )}

      {plans.length > 0 && (
        <div className="settings-block">
          <div className="settings-row" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="settings-row-label">Plans</div>
          </div>
          {plans.map((p) => (
            <div key={p.id} className="settings-row">
              <div>
                <div className="settings-row-label">{p.name}</div>
                <div className="settings-row-sub">{centsToDisplay(p.price_cents)}/{p.interval}{p.credit_allowance ? ` — ${p.credit_allowance} credits` : ""}</div>
              </div>
              {canManage ? (
                <Button onClick={() => subscribe(p.id)} disabled={busyId === p.id}>{busyId === p.id ? "…" : "Subscribe"}</Button>
              ) : (
                <span style={{ fontSize: 11.5, color: "var(--text3)" }}>Admin only</span>
              )}
            </div>
          ))}
        </div>
      )}

      {packs.length > 0 && (
        <div className="settings-block">
          <div className="settings-row" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="settings-row-label">Credit packs</div>
          </div>
          {packs.map((p) => (
            <div key={p.id} className="settings-row">
              <div>
                <div className="settings-row-label">{p.name}</div>
                <div className="settings-row-sub">{p.credits} credits for {centsToDisplay(p.price_cents)}</div>
              </div>
              {canManage ? (
                <Button onClick={() => buyPack(p.id)} disabled={busyId === p.id}>{busyId === p.id ? "…" : "Buy"}</Button>
              ) : (
                <span style={{ fontSize: 11.5, color: "var(--text3)" }}>Admin only</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="settings-block" style={{ padding: "12px 16px" }}>
        <span style={{ fontSize: 12.5, color: "var(--text3)" }}>
          Payout destinations, order history, and revenue live on the business's own management page.
        </span>
      </div>
    </div>
  );
}

// ── Connected apps ──────────────────────────────────────────────────────────

function AppsTab({ spaceId, connectors, slug }: { spaceId: string; connectors: ConnectorInfo[]; slug: string }) {
  const connected = connectors.filter((c) => c.connected);
  const available = connectors.filter((c) => !c.connected && c.status === "available");

  return (
    <div>
      <div className="settings-section-title">Connected Apps</div>
      <div className="settings-section-sub">Third-party accounts this business's assistant can use.</div>

      <div className="settings-block">
        <div className="settings-row" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="settings-row-label">Connected ({connected.length})</div>
        </div>
        {connected.length === 0 ? (
          <div style={{ padding: "12px 16px", fontSize: 12.5, color: "var(--text3)" }}>Nothing connected yet.</div>
        ) : (
          connected.map((c) => (
            <div key={c.id} className="settings-row">
              <div className="settings-row-label">{c.name}</div>
              <Badge color="green">Connected</Badge>
            </div>
          ))
        )}
      </div>

      {available.length > 0 && (
        <div className="settings-block" style={{ padding: "12px 16px" }}>
          <span style={{ fontSize: 12.5, color: "var(--text2)" }}>{available.length} more app{available.length === 1 ? "" : "s"} available to connect.</span>
        </div>
      )}

      <Link href={`/p/${slug}/connectors`} className="btn btn-primary btn-sm" style={{ display: "inline-block", marginTop: 4, textDecoration: "none" }}>
        Manage connections
      </Link>
    </div>
  );
}

// ── AI & Models ──────────────────────────────────────────────────────────────

function AiTab({
  spaceId,
  creds,
  policy,
  canManage,
  onChanged,
}: {
  spaceId: string;
  creds: { sessionToken: string; endUserId: string } | null;
  policy: AssistantPolicy | null;
  canManage: boolean;
  onChanged: (p: AssistantPolicy) => void;
}) {
  const [model, setModel] = React.useState<string>("");
  const [effort, setEffort] = React.useState<string>("low");
  const [savingModel, setSavingModel] = React.useState(false);
  const [savingEffort, setSavingEffort] = React.useState(false);
  const [savingPolicy, setSavingPolicy] = React.useState(false);
  const [byok, setByok] = React.useState<ByokProviderStatus[]>([]);
  const [byokProvider, setByokProvider] = React.useState("google-ai-studio");
  const [byokLabel, setByokLabel] = React.useState("");
  const [byokKey, setByokKeyInput] = React.useState("");
  const [byokBusy, setByokBusy] = React.useState(false);
  const [byokError, setByokError] = React.useState<string | null>(null);
  const [byokNotice, setByokNotice] = React.useState<string | null>(null);

  const refreshByok = React.useCallback(async () => {
    if (!creds) return;
    try {
      setByok(await getByokStatus(spaceId, creds));
    } catch (err) {
      setByokError(err instanceof Error ? err.message : "Unable to load provider keys");
    }
  }, [creds, spaceId]);

  React.useEffect(() => { void refreshByok(); }, [refreshByok]);

  const providerLabel = (provider: string) => provider === "google-ai-studio" ? "Google AI Studio / Gemini" : "Groq";

  async function addByokKey() {
    if (!creds || !byokKey.trim()) return;
    setByokBusy(true);
    setByokError(null);
    setByokNotice(null);
    try {
      await setByokKey(spaceId, creds, byokProvider, byokKey, byokLabel);
      setByokKeyInput("");
      setByokLabel("");
      await refreshByok();
      setByokNotice(`${providerLabel(byokProvider)} key added and selected for new runs.`);
    } catch (err) {
      setByokError(err instanceof Error ? err.message : "Unable to save provider key");
    } finally {
      setByokBusy(false);
    }
  }

  async function chooseByokKey(provider: string, keyId: string) {
    if (!creds) return;
    setByokBusy(true);
    setByokError(null);
    setByokNotice(null);
    try {
      await selectByokKey(spaceId, creds, provider, keyId);
      await refreshByok();
      setByokNotice(`${providerLabel(provider)} key selected.`);
    } catch (err) {
      setByokError(err instanceof Error ? err.message : "Unable to select provider key");
    } finally {
      setByokBusy(false);
    }
  }

  async function removeByokKey(provider: string, keyId: string) {
    if (!creds) return;
    setByokBusy(true);
    setByokError(null);
    setByokNotice(null);
    try {
      await deleteByokKey(spaceId, creds, provider, keyId);
      await refreshByok();
      setByokNotice("Provider key removed.");
    } catch (err) {
      setByokError(err instanceof Error ? err.message : "Unable to remove provider key");
    } finally {
      setByokBusy(false);
    }
  }

  async function toggleAutonomy(autonomous: boolean) {
    if (!creds) return;
    setSavingPolicy(true);
    try {
      const next = await updateAssistantPolicy(spaceId, creds, { approval_mode: autonomous ? "yolo" : "always_ask" });
      onChanged(next);
    } catch { /* the toggle just reverts visually since policy state didn't change */ } finally { setSavingPolicy(false); }
  }

  async function saveModel() {
    if (!creds || !model) return;
    setSavingModel(true);
    try {
      await updateModelConfig(spaceId, creds, model);
    } catch { /* no-op */ } finally { setSavingModel(false); }
  }

  async function saveEffort() {
    if (!creds || !model) return;
    setSavingEffort(true);
    try {
      await updateModelConfig(spaceId, creds, model, effort);
    } catch { /* no-op */ } finally { setSavingEffort(false); }
  }

  return (
    <div>
      <div className="settings-section-title">AI & Models</div>
      <div className="settings-section-sub">Default model behavior for this space.</div>

      <div className="settings-block">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Autonomy</div>
            <div className="settings-row-sub">
              {policy?.approval_mode === "yolo" ? "Autonomous — acts without asking." : "Guided — asks before anything sensitive."}
            </div>
          </div>
          {canManage ? (
            <Toggle on={policy?.approval_mode === "yolo"} onChange={toggleAutonomy} disabled={savingPolicy || !policy} />
          ) : (
            <Badge color={policy?.approval_mode === "yolo" ? "green" : "blue"}>{policy?.approval_mode ?? "…"}</Badge>
          )}
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Default model</div>
            <div className="settings-row-sub">Used for chat and agent runs unless a session overrides it.</div>
          </div>
          {canManage ? (
            <div style={{ display: "flex", gap: 8 }}>
              <FormSelect value={model} onChange={(e) => setModel(e.target.value)} style={{ maxWidth: 260 }}>
                <option value="">Choose a model…</option>
                {ALLOWED_MODELS.map((m) => (
                  <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>
                ))}
              </FormSelect>
              <Button onClick={saveModel} disabled={savingModel || !model}>{savingModel ? "…" : "Save"}</Button>
            </div>
          ) : (
            <span style={{ fontSize: 12, color: "var(--text2)" }}>Set by an admin</span>
          )}
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Effort</div>
            <div className="settings-row-sub">
              How far the model above is allowed to reach for help — {effortOptionsForModel(model).find((o) => o.level === effort)?.description ?? "pick a model first"}
            </div>
          </div>
          {canManage ? (
            <div style={{ display: "flex", gap: 8 }}>
              <FormSelect value={effort} onChange={(e) => setEffort(e.target.value)} style={{ maxWidth: 160 }} disabled={!model}>
                {effortOptionsForModel(model).map((opt) => (
                  <option key={opt.level} value={opt.level}>{opt.label}</option>
                ))}
              </FormSelect>
              <Button onClick={saveEffort} disabled={savingEffort || !model}>{savingEffort ? "…" : "Save"}</Button>
            </div>
          ) : (
            <span style={{ fontSize: 12, color: "var(--text2)" }}>Set by an admin</span>
          )}
        </div>
      </div>

      <div className="settings-section-title" style={{ marginTop: 28 }}>Space-wide provider keys</div>
      <div className="settings-section-sub">
        Add multiple keys for Gemini or Groq. The selected key is tried first; an authentication, rate-limit, or provider outage automatically tries the next key for that run. Keys are encrypted in the vault and never shown again.
      </div>

      <div className="settings-block">
        {canManage && (
          <div className="settings-row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 10 }}>
            <div style={{ minWidth: 190 }}>
              <label className="settings-row-sub" htmlFor="byok-provider">Provider</label>
              <FormSelect id="byok-provider" value={byokProvider} onChange={(e) => setByokProvider(e.target.value)}>
                <option value="google-ai-studio">Google AI Studio / Gemini</option>
                <option value="groq">Groq</option>
              </FormSelect>
            </div>
            <div style={{ minWidth: 150, flex: "1 1 150px" }}>
              <label className="settings-row-sub" htmlFor="byok-label">Label (optional)</label>
              <FormInput id="byok-label" value={byokLabel} onChange={(e) => setByokLabel(e.target.value)} placeholder="e.g. Production" autoComplete="off" />
            </div>
            <div style={{ minWidth: 220, flex: "2 1 220px" }}>
              <label className="settings-row-sub" htmlFor="byok-key">Provider API key</label>
              <FormInput id="byok-key" type="password" value={byokKey} onChange={(e) => setByokKeyInput(e.target.value)} placeholder="Paste a new key" autoComplete="off" />
            </div>
            <Button onClick={() => void addByokKey()} disabled={byokBusy || !byokKey.trim()}>{byokBusy ? "Saving…" : "Add key"}</Button>
          </div>
        )}

        {byok.map((entry) => (
          <div key={entry.provider} className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div>
                <div className="settings-row-label">{providerLabel(entry.provider)}</div>
                <div className="settings-row-sub">
                  {entry.keys.length === 0 ? "No key configured" : `${entry.keys.length} key${entry.keys.length === 1 ? "" : "s"} configured · automatic failover enabled`}
                </div>
              </div>
              {entry.active_key_id && <Badge color="green">Active key selected</Badge>}
            </div>
            {entry.keys.map((key) => (
              <div key={key.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 6, background: "var(--surface2, rgba(127,127,127,.08))" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: "var(--text1)" }}>{key.label || "Unnamed key"}</div>
                  <div style={{ fontSize: 11, color: "var(--text3)" }}>Secret stored in vault{key.created_at ? ` · added ${new Date(key.created_at).toLocaleDateString()}` : ""}</div>
                </div>
                {key.active ? <Badge color="green">Using</Badge> : canManage ? <Button onClick={() => void chooseByokKey(entry.provider, key.id)} disabled={byokBusy}>Use</Button> : null}
                {canManage && <Button onClick={() => void removeByokKey(entry.provider, key.id)} disabled={byokBusy}>Remove</Button>}
              </div>
            ))}
          </div>
        ))}
      </div>
      {byokError && <div style={{ color: "#dc2626", fontSize: 12.5, marginTop: 8 }}>{byokError}</div>}
      {byokNotice && <div style={{ color: "var(--text2)", fontSize: 12.5, marginTop: 8 }}>{byokNotice}</div>}
      {!canManage && (
        <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 12 }}>Only business admins and owners can change these.</div>
      )}
    </div>
  );
}

// ── Personal ─────────────────────────────────────────────────────────────────

function PersonalTab({
  me,
  session,
  productSlug,
  productSpaceId,
  signOut,
  router,
}: {
  me: ProductUserMe | null;
  session: { end_user_id: string } | null;
  productSlug: string;
  productSpaceId: string;
  signOut: () => void;
  router: ReturnType<typeof useRouter>;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const creds = useSessionCredentials();

  async function handleDelete() {
    if (!creds) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteMe(productSpaceId, creds);
      signOut();
      router.replace(`/p/${productSlug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete account");
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="settings-section-title">Personal</div>
      <div className="settings-section-sub">Your own account on this product.</div>

      <div className="settings-block">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Signed in as</div>
            <div className="settings-row-sub">{me?.email ?? session?.end_user_id}</div>
          </div>
          <Badge color={me?.email_verified ? "green" : "amber"}>{me?.email_verified ? "Verified" : "Unverified"}</Badge>
        </div>
        {me && (
          <div className="settings-row">
            <div><div className="settings-row-label">Credits</div></div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{me.credits_balance}</div>
          </div>
        )}
        <div className="settings-row">
          <div><div className="settings-row-label">Session</div></div>
          <button className="btn btn-secondary btn-sm" type="button" onClick={signOut}>Sign out</button>
        </div>
      </div>

      <div className="settings-block danger-zone">
        <div className="settings-row" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
          <div>
            <div className="settings-row-label">Delete account</div>
            <div className="settings-row-sub">
              Permanently erases your sessions, saved conversations, and preferences. This cannot be undone.
            </div>
          </div>
          {!confirming ? (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              style={{ color: "#dc2626", borderColor: "#dc2626" }}
              onClick={() => setConfirming(true)}
            >
              Delete my account
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", maxWidth: 320 }}>
              <label style={{ fontSize: 12.5, color: "var(--text2)" }}>Type DELETE to confirm</label>
              <FormInput type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
              {error && <div style={{ color: "#dc2626", fontSize: 12.5 }}>{error}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  disabled={confirmText !== "DELETE" || deleting}
                  style={{ color: "#dc2626", borderColor: "#dc2626" }}
                  onClick={() => void handleDelete()}
                >
                  {deleting ? "Deleting…" : "Confirm delete"}
                </button>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => { setConfirming(false); setConfirmText(""); setError(null); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
