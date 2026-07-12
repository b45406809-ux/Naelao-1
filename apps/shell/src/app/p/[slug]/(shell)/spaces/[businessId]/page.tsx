"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Button, Badge, Modal, FormInput, FormSelect, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import {
  listBusinessMembers,
  removeBusinessMember,
  inviteToBusiness,
  listMyBusinesses,
  getPricing,
  checkoutBusinessSubscription,
  checkoutCreditPack,
  getShellManifest,
  listBusinessProducts,
  createBusinessProduct,
  updateBusinessProduct,
  listBusinessOrders,
  getBusinessRevenue,
  getBusinessWallet,
  listLocalGrants,
  createLocalGrant,
  deleteLocalGrant,
  mintLocalTunnelConnectToken,
  getBusinessWalletBalance,
  getBusinessWalletTransactions,
  getPayoutDestinations,
  addPayoutDestination,
  type BusinessMember,
  type Business,
  type PricingPlan,
  type CreditPack,
  type LaunchpadProduct,
  type LaunchpadOrder,
  type RevenueSummary,
  type BusinessWallet,
  type LocalGrant,
  type WhopWalletBalance,
  type WhopWalletTransaction,
  type PayoutDestination,
} from "@/lib/api";

const GRANT_TYPES = ["read", "write", "readwrite", "exec"] as const;

function centsToDisplay(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(cents / 100);
}

export default function BusinessDetailPage() {
  const params = useParams<{ businessId: string }>();
  const product = useProduct();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const [business, setBusiness] = React.useState<Business | null>(null);
  const [members, setMembers] = React.useState<BusinessMember[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<"member" | "admin">("member");
  const [inviting, setInviting] = React.useState(false);
  const [lastInviteToken, setLastInviteToken] = React.useState<string | null>(null);
  const [plans, setPlans] = React.useState<PricingPlan[]>([]);
  const [creditPacks, setCreditPacks] = React.useState<CreditPack[]>([]);
  const [checkingOut, setCheckingOut] = React.useState<string | null>(null);
  // Phase N: the manifest-driven operator shell (Revenue/Orders/Products) — only offered when
  // this business's own SpaceType manifest actually advertises commerce sidebar items, so a
  // non-Launchpad (future) SpaceType's business doesn't show an irrelevant, empty section.
  const [hasCommerce, setHasCommerce] = React.useState(false);
  const [revenue, setRevenue] = React.useState<RevenueSummary | null>(null);
  const [wallet, setWallet] = React.useState<BusinessWallet | null>(null);
  const [orders, setOrders] = React.useState<LaunchpadOrder[]>([]);
  const [products, setProducts] = React.useState<LaunchpadProduct[]>([]);
  const [newProductName, setNewProductName] = React.useState("");
  const [newProductPrice, setNewProductPrice] = React.useState("");
  const [creatingProduct, setCreatingProduct] = React.useState(false);
  const [localGrants, setLocalGrants] = React.useState<LocalGrant[]>([]);
  const [grantType, setGrantType] = React.useState<(typeof GRANT_TYPES)[number]>("read");
  const [grantDirectory, setGrantDirectory] = React.useState("");
  const [grantCommands, setGrantCommands] = React.useState("");
  const [creatingGrant, setCreatingGrant] = React.useState(false);
  const [connectInfo, setConnectInfo] = React.useState<{ token: string; connect_path: string; expires_in_seconds: number } | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  // Business Wallet (Whop sub-merchant model): the business's OWN auto-provisioned bank account.
  const [whopWallet, setWhopWallet] = React.useState<WhopWalletBalance | null>(null);
  const [whopTransactions, setWhopTransactions] = React.useState<WhopWalletTransaction[]>([]);
  const [payoutDestinations, setPayoutDestinations] = React.useState<PayoutDestination[]>([]);
  const [payBusy, setPayBusy] = React.useState(false);
  const [destOpen, setDestOpen] = React.useState(false);
  const [destType, setDestType] = React.useState<PayoutDestination["type"]>("bank");
  const [destLabel, setDestLabel] = React.useState("");
  const [destDetails, setDestDetails] = React.useState("");

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    try {
      const [mine, mem, pricing, manifest, grants, wal, whopBal, whopTx, destinations] = await Promise.all([
        listMyBusinesses(product.space_id, creds),
        listBusinessMembers(params.businessId, creds),
        getPricing(params.businessId, creds).catch(() => ({ plans: [], credit_packs: [] })),
        getShellManifest(params.businessId, creds).catch(() => null),
        listLocalGrants(params.businessId, creds).catch(() => []),
        getBusinessWallet(params.businessId, creds).catch(() => null),
        getBusinessWalletBalance(params.businessId, creds).catch(() => null),
        getBusinessWalletTransactions(params.businessId, creds).catch(() => []),
        // Admin-only route — a plain member's 403 is expected, not an error.
        getPayoutDestinations(params.businessId, creds).catch(() => []),
      ]);
      setBusiness(mine.find((b) => b.id === params.businessId) ?? null);
      setMembers(mem);
      setPlans(pricing.plans);
      setCreditPacks(pricing.credit_packs);
      setLocalGrants(grants);
      setWallet(wal);
      setWhopWallet(whopBal);
      setWhopTransactions(whopTx);
      setPayoutDestinations(destinations);
      const commerce = manifest?.ui.sidebar_items.some((item) => item.id === "revenue") ?? false;
      setHasCommerce(commerce);
      if (commerce) {
        const [rev, ord, prod] = await Promise.all([
          getBusinessRevenue(params.businessId, creds).catch(() => null),
          listBusinessOrders(params.businessId, creds).catch(() => []),
          listBusinessProducts(params.businessId, creds).catch(() => []),
        ]);
        setRevenue(rev);
        setOrders(ord);
        setProducts(prod);
      }
    } catch {
      show("Couldn't load this business — you may not be a member");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.space_id, params.businessId, session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!creds || !inviteEmail.trim()) return;
    setInviting(true);
    try {
      const result = await inviteToBusiness(params.businessId, creds, { email: inviteEmail.trim(), role: inviteRole });
      setLastInviteToken(result.token);
      setInviteEmail("");
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setInviting(false);
    }
  }

  async function handleRemove(endUserId: string) {
    if (!creds) return;
    try {
      await removeBusinessMember(params.businessId, endUserId, creds);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to remove member");
    }
  }

  async function handleCreateGrant() {
    if (!creds) return;
    setCreatingGrant(true);
    try {
      if (grantType === "exec") {
        const list = grantCommands.split("\n").map((c) => c.trim()).filter(Boolean);
        if (list.length === 0) throw new Error("Enter at least one exact command");
        const created = await createLocalGrant(params.businessId, creds, { grant_type: "exec", commands: list });
        setLocalGrants((prev) => [...prev, created]);
      } else {
        if (!grantDirectory.trim()) throw new Error("Enter a directory");
        const created = await createLocalGrant(params.businessId, creds, { grant_type: grantType, directory: grantDirectory.trim() });
        setLocalGrants((prev) => [...prev, created]);
      }
      setGrantDirectory("");
      setGrantCommands("");
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to add grant");
    } finally {
      setCreatingGrant(false);
    }
  }

  async function handleDeleteGrant(grantId: string) {
    if (!creds) return;
    try {
      await deleteLocalGrant(params.businessId, grantId, creds);
      setLocalGrants((prev) => prev.filter((g) => g.id !== grantId));
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to revoke grant");
    }
  }

  async function handleConnectLocalMachine() {
    if (!creds) return;
    setConnecting(true);
    try {
      setConnectInfo(await mintLocalTunnelConnectToken(params.businessId, creds));
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to mint a connect token");
    } finally {
      setConnecting(false);
    }
  }

  async function handleAddPayoutDestination() {
    if (!creds || !destLabel.trim()) return;
    setPayBusy(true);
    try {
      let details: Record<string, unknown>;
      try {
        details = destDetails ? (JSON.parse(destDetails) as Record<string, unknown>) : {};
      } catch {
        details = { raw: destDetails };
      }
      await addPayoutDestination(params.businessId, creds, { type: destType, label: destLabel.trim(), details });
      setDestOpen(false);
      setDestLabel("");
      setDestDetails("");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to add payout destination");
    } finally {
      setPayBusy(false);
    }
  }

  async function handleCreateProduct(e: React.FormEvent) {
    e.preventDefault();
    if (!creds || !newProductName.trim()) return;
    setCreatingProduct(true);
    try {
      const priceCents = Math.round(parseFloat(newProductPrice || "0") * 100) || 0;
      await createBusinessProduct(params.businessId, creds, { name: newProductName.trim(), price_cents: priceCents });
      setNewProductName("");
      setNewProductPrice("");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to create product");
    } finally {
      setCreatingProduct(false);
    }
  }

  async function handleTogglePublish(prod: LaunchpadProduct) {
    if (!creds) return;
    try {
      await updateBusinessProduct(params.businessId, prod.id, creds, {
        status: prod.status === "published" ? "archived" : "published",
      });
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to update product");
    }
  }

  async function handleSubscribe(planId: string) {
    if (!creds) return;
    setCheckingOut(`plan:${planId}`);
    try {
      const { checkout_url, dev } = await checkoutBusinessSubscription(params.businessId, creds, planId);
      if (dev) show(`Dev mode — no Lemon Squeezy credentials configured (${checkout_url})`);
      else window.location.href = checkout_url;
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to start checkout");
    } finally {
      setCheckingOut(null);
    }
  }

  async function handleBuyCredits(packId: string) {
    if (!creds) return;
    setCheckingOut(`pack:${packId}`);
    try {
      const { checkout_url, dev } = await checkoutCreditPack(params.businessId, creds, packId);
      if (dev) show(`Dev mode — no Lemon Squeezy credentials configured (${checkout_url})`);
      else window.location.href = checkout_url;
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to start checkout");
    } finally {
      setCheckingOut(null);
    }
  }

  const myRole = business?.role;
  const canManage = myRole === "owner" || myRole === "admin";

  if (loading) return <div className="page-view">Loading…</div>;
  if (!business) return <div className="page-view">You don&rsquo;t have access to this business.</div>;

  return (
    <div className="page-view">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="page-title">{business.name}</div>
          <div className="page-subtitle">
            <Badge color={business.space_status === "active" ? "green" : "amber"}>{business.space_status}</Badge>{" "}
            Your role: {business.role}
          </div>
        </div>
        {canManage && <Button onClick={() => setInviteOpen(true)}>Invite</Button>}
      </div>

      <div className="section-label">Members</div>
      <div className="settings-block">
        {members.map((m) => (
          <div className="settings-row" key={m.end_user_id}>
            <div>
              <div className="settings-row-label">{m.end_user_id}</div>
              <div className="settings-row-sub">
                {m.role} · joined {new Date(m.joined_at).toLocaleDateString()}
              </div>
            </div>
            {canManage && m.role !== "owner" && (
              <button className="btn btn-secondary" type="button" onClick={() => handleRemove(m.end_user_id)}>
                Remove
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="section-label">My Local Machine</div>
      <p style={{ fontSize: 12, color: "var(--text3)", marginBottom: 8 }}>
        Let this business&rsquo;s agents read/write files or run exact commands on YOUR OWN
        machine. No access is granted by default — you see only your own grants here.
      </p>
      <div className="settings-block">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Connection</div>
            <div className="settings-row-sub">Mint a connect token, then run the Naelao Local Agent with it.</div>
          </div>
          <Button onClick={handleConnectLocalMachine} disabled={connecting}>
            {connecting ? "Minting…" : "Connect"}
          </Button>
        </div>
        {connectInfo && (
          <div style={{ padding: "0 12px 12px" }}>
            <code style={{ fontSize: 11, wordBreak: "break-all", display: "block", padding: 10, background: "var(--bg2)", borderRadius: 8 }}>
              node naelao-local-agent.mjs --token {connectInfo.token} --path {connectInfo.connect_path}
            </code>
            <div className="settings-row-sub" style={{ marginTop: 4 }}>Expires in {connectInfo.expires_in_seconds}s.</div>
          </div>
        )}
        {localGrants.length === 0 && <div className="settings-row-sub" style={{ padding: 12 }}>No grants yet.</div>}
        {localGrants.map((g) => (
          <div className="settings-row" key={g.id}>
            <div>
              <Badge color="blue">{g.grant_type}</Badge>{" "}
              <span className="settings-row-label">{g.grant_type === "exec" ? g.commands.join(", ") : g.directory}</span>
              <div className="settings-row-sub">Added {new Date(g.created_at).toLocaleDateString()}</div>
            </div>
            <button className="btn btn-secondary" type="button" onClick={() => handleDeleteGrant(g.id)}>
              Revoke
            </button>
          </div>
        ))}
      </div>
      {canManage && (
        <form
          onSubmit={(e) => { e.preventDefault(); void handleCreateGrant(); }}
          style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap", alignItems: "flex-end" }}
        >
          <FormSelect value={grantType} onChange={(e) => setGrantType(e.target.value as (typeof GRANT_TYPES)[number])} style={{ maxWidth: 140 }}>
            {GRANT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </FormSelect>
          {grantType === "exec" ? (
            <FormInput placeholder="npm test" value={grantCommands} onChange={(e) => setGrantCommands(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          ) : (
            <FormInput placeholder="/Users/you/projects/my-repo" value={grantDirectory} onChange={(e) => setGrantDirectory(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          )}
          <Button type="submit" disabled={creatingGrant}>
            {creatingGrant ? "Adding…" : "Add grant"}
          </Button>
        </form>
      )}

      {/* Business Wallet (Whop sub-merchant model): every business auto-provisions its own bank
          account — no owner action required. Balance is member-visible; adding a payout
          destination is admin-only. */}
      <div className="section-label">Business Wallet</div>
      <p style={{ fontSize: 12, color: "var(--text3)", marginBottom: 8 }}>
        This business&rsquo;s own Whop sub-merchant wallet — a real bank account, auto-provisioned
        at creation. Revenue from Whop&rsquo;s own storefront/checkout and any connected 3rd-party
        platform settles here automatically; Naelao never holds this money.
      </p>
      <div className="settings-block">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Balance</div>
            <div className="settings-row-sub">
              <Badge color={whopWallet?.status === "active" ? "green" : whopWallet?.status === "pending" ? "amber" : "red"}>
                {whopWallet?.status === "not_provisioned" ? "not provisioned yet" : whopWallet?.status ?? "loading"}
              </Badge>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="settings-row-label">{centsToDisplay(whopWallet?.balance_cents ?? 0)}</div>
            <div className="settings-row-sub">{whopWallet?.currency ?? "USD"}</div>
          </div>
        </div>
        {whopTransactions.slice(0, 8).map((t, i) => (
          <div className="settings-row" key={i}>
            <div>
              <div className="settings-row-label">{t.description ?? t.type}</div>
              <div className="settings-row-sub">{new Date(t.created_at).toLocaleString()}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="settings-row-label" style={{ color: t.amount_cents >= 0 ? "var(--green, #16a34a)" : "inherit" }}>
                {t.amount_cents >= 0 ? "+" : ""}{centsToDisplay(t.amount_cents)}
              </div>
            </div>
          </div>
        ))}
        {canManage && (
          <>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Payout destinations</div>
                <div className="settings-row-sub">
                  {payoutDestinations.length === 0 ? "None on file yet" : `${payoutDestinations.length} on file`}
                </div>
              </div>
              {!destOpen && (
                <button className="btn btn-secondary" type="button" onClick={() => setDestOpen(true)} disabled={payBusy}>
                  Add destination
                </button>
              )}
            </div>
            {payoutDestinations.map((d) => (
              <div className="settings-row" key={d.id}>
                <div className="settings-row-label">{d.label} ({d.type})</div>
                <Badge color={d.status === "verified" ? "green" : "amber"}>{d.status}</Badge>
              </div>
            ))}
            {destOpen && (
              <div style={{ padding: "0 12px 12px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                <FormSelect value={destType} onChange={(e) => setDestType(e.target.value as PayoutDestination["type"])} style={{ minWidth: 140 }}>
                  <option value="bank">Bank</option>
                  <option value="crypto">Crypto</option>
                  <option value="venmo">Venmo</option>
                  <option value="cashapp">CashApp</option>
                </FormSelect>
                <FormInput
                  placeholder="Label (e.g. Chase checking ...1234)"
                  value={destLabel}
                  onChange={(e) => setDestLabel(e.target.value)}
                  style={{ flex: 1, minWidth: 200 }}
                />
                <FormInput
                  placeholder="Account/routing details"
                  value={destDetails}
                  onChange={(e) => setDestDetails(e.target.value)}
                  style={{ flex: 1, minWidth: 200 }}
                />
                <Button onClick={handleAddPayoutDestination} disabled={payBusy || !destLabel.trim()}>
                  {payBusy ? "Saving…" : "Save"}
                </Button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => { setDestOpen(false); setDestLabel(""); setDestDetails(""); }}
                  disabled={payBusy}
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* F-WALLET-7: the transparency section — "your AI only spends money this business earned". */}
      {wallet && (wallet.project_id || wallet.lifetime.order_count > 0) && (
        <>
          <div className="section-label">Wallet</div>
          <div className="settings-block">
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Available to grow the business</div>
                <div className="settings-row-sub">Your AI only spends money this business has earned.</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="settings-row-label">{centsToDisplay(wallet.available_balance_cents)}</div>
                <div className="settings-row-sub">{wallet.currency}</div>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Total earned</div>
                <div className="settings-row-sub">{wallet.lifetime.order_count} settled order(s)</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="settings-row-label">{centsToDisplay(wallet.lifetime.gross_cents)} gross</div>
                <div className="settings-row-sub">
                  {centsToDisplay(wallet.lifetime.naelao_cut_cents)} Naelao cut
                  {wallet.lifetime.builder_cut_cents > 0 ? ` · ${centsToDisplay(wallet.lifetime.builder_cut_cents)} builder cut` : ""}
                </div>
              </div>
            </div>
            {wallet.transactions.slice(0, 8).map((t) => (
              <div className="settings-row" key={t.id}>
                <div>
                  <div className="settings-row-label">{t.reason.replace(/_/g, " ")}</div>
                  <div className="settings-row-sub">{new Date(t.created_at).toLocaleString()}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="settings-row-label" style={{ color: t.delta_cents >= 0 ? "var(--green, #16a34a)" : "inherit" }}>
                    {t.delta_cents >= 0 ? "+" : ""}{centsToDisplay(t.delta_cents)}
                  </div>
                  <div className="settings-row-sub">bal {centsToDisplay(t.balance_after_cents)}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {hasCommerce && (
        <>
          <div className="section-label">Revenue</div>
          <div className="settings-block">
            <div className="settings-row">
              <div>
                <div className="settings-row-label">This month ({revenue?.period ?? "—"})</div>
                <div className="settings-row-sub">{revenue?.orders ?? 0} orders</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="settings-row-label">{revenue ? centsToDisplay(revenue.net_cents) : "—"} net</div>
                <div className="settings-row-sub">
                  {revenue ? `${centsToDisplay(revenue.gross_cents)} gross · ${centsToDisplay(revenue.fee_cents)} platform fee` : ""}
                </div>
              </div>
            </div>
          </div>

          <div className="section-label">Products</div>
          <div className="settings-block">
            {products.length === 0 && <div className="settings-row-sub" style={{ padding: 12 }}>No products yet.</div>}
            {products.map((p) => (
              <div className="settings-row" key={p.id}>
                <div>
                  <div className="settings-row-label">{p.name}</div>
                  <div className="settings-row-sub">
                    {centsToDisplay(p.price_cents)} · {p.kind} · <Badge color={p.status === "published" ? "green" : p.status === "archived" ? "blue" : "amber"}>{p.status}</Badge>
                  </div>
                </div>
                {canManage && p.status !== "archived" && (
                  <button className="btn btn-secondary" type="button" onClick={() => handleTogglePublish(p)}>
                    {p.status === "published" ? "Unpublish" : "Publish"}
                  </button>
                )}
              </div>
            ))}
          </div>
          {canManage && (
            <form onSubmit={handleCreateProduct} style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <FormInput placeholder="Product name" value={newProductName} onChange={(e) => setNewProductName(e.target.value)} required />
              <FormInput
                placeholder="Price (USD)"
                type="number"
                min="0"
                step="0.01"
                value={newProductPrice}
                onChange={(e) => setNewProductPrice(e.target.value)}
                style={{ maxWidth: 140 }}
              />
              <Button type="submit" disabled={creatingProduct || !newProductName.trim()}>
                {creatingProduct ? "Adding…" : "Add product"}
              </Button>
            </form>
          )}

          <div className="section-label">Orders</div>
          <div className="settings-block">
            {orders.length === 0 && <div className="settings-row-sub" style={{ padding: 12 }}>No orders yet.</div>}
            {orders.map((o) => (
              <div className="settings-row" key={o.id}>
                <div>
                  <div className="settings-row-label">{o.product_name ?? "Unknown product"}</div>
                  <div className="settings-row-sub">
                    {o.customer_email ?? "unknown customer"} · {new Date(o.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="settings-row-label">{centsToDisplay(o.net_cents)}</div>
                  <Badge color={o.status === "fulfilled" || o.status === "paid" ? "green" : o.status === "refunded" || o.status === "failed" ? "red" : "amber"}>
                    {o.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {plans.length > 0 && (
        <>
          <div className="section-label">Subscription Plans</div>
          <p style={{ fontSize: 12, color: "var(--text3)", marginBottom: 8 }}>
            {business.name} subscribes to one of these plans as a whole.
          </p>
          <div className="settings-block">
            {plans.map((plan) => (
              <div className="settings-row" key={plan.id}>
                <div>
                  <div className="settings-row-label">{plan.name}</div>
                  <div className="settings-row-sub">
                    {centsToDisplay(plan.price_cents)}/{plan.interval}
                    {plan.credit_allowance ? ` · ${plan.credit_allowance} credits/mo` : ""}
                  </div>
                </div>
                {canManage && (
                  <Button onClick={() => handleSubscribe(plan.id)} disabled={checkingOut === `plan:${plan.id}`}>
                    {checkingOut === `plan:${plan.id}` ? "Starting…" : "Subscribe"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {creditPacks.length > 0 && (
        <>
          <div className="section-label">Credit Packs</div>
          <p style={{ fontSize: 12, color: "var(--text3)", marginBottom: 8 }}>
            One-time purchases added to YOUR OWN credit balance, not the business&rsquo;s.
          </p>
          <div className="settings-block">
            {creditPacks.map((pack) => (
              <div className="settings-row" key={pack.id}>
                <div>
                  <div className="settings-row-label">{pack.name}</div>
                  <div className="settings-row-sub">
                    {pack.credits} credits — {centsToDisplay(pack.price_cents)}
                  </div>
                </div>
                <Button onClick={() => handleBuyCredits(pack.id)} disabled={checkingOut === `pack:${pack.id}`}>
                  {checkingOut === `pack:${pack.id}` ? "Starting…" : "Buy"}
                </Button>
              </div>
            ))}
          </div>
        </>
      )}

      <Modal
        open={inviteOpen}
        onClose={() => {
          setInviteOpen(false);
          setLastInviteToken(null);
        }}
        title="Invite a collaborator"
        footer={
          <>
            <Button variant="secondary" type="button" onClick={() => setInviteOpen(false)}>
              Close
            </Button>
            {!lastInviteToken && (
              <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
                {inviting ? "Sending…" : "Send Invite"}
              </Button>
            )}
          </>
        }
      >
        {lastInviteToken ? (
          <div>
            <p style={{ fontSize: 13, color: "var(--text2)", marginBottom: 8 }}>
              Invite created. Share this link with the invitee (shown once — it isn&rsquo;t stored anywhere retrievable):
            </p>
            <code style={{ fontSize: 12, wordBreak: "break-all", display: "block", padding: 10, background: "var(--bg2)", borderRadius: 8 }}>
              /p/{product.slug}/spaces/{params.businessId}/accept-invite/{lastInviteToken}
            </code>
          </div>
        ) : (
          <form onSubmit={handleInvite} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FormInput type="email" placeholder="email@example.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required autoFocus />
            <FormSelect value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </FormSelect>
          </form>
        )}
      </Modal>
      <Toast toast={toast} />
    </div>
  );
}
