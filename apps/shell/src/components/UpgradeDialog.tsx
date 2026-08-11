"use client";

// The "insufficient credits — top up or subscribe to keep chatting" (and its billing-gate
// siblings: subscription_inactive, quota_exceeded, infra_quota_exceeded) used to surface as a
// bare red error banner — accurate, but a dead end: nothing on it let the person actually DO
// anything about it. This renders the SAME real purchase flow the Settings/business-detail pages
// already have (getPricing → checkoutCreditPack/checkoutBusinessSubscription, both real Lemon
// Squeezy checkouts) as a focused dialog, at the exact moment the wall was hit.
//
// Deliberately honest about what does and doesn't have a self-serve fix here:
//   - insufficient_credits on the SIGNED-IN PERSON'S OWN balance ("insufficient credits — top up
//     or subscribe...") → real credit-pack / subscription purchase buttons, when the business has
//     configured any (a business that hasn't is told so, not shown empty buttons).
//   - subscription_inactive → real "Resubscribe" buttons from the same catalog.
//   - insufficient_credits on the BUSINESS'S OWN WALLET ("this business's wallet is empty...") →
//     there is no end-user-reachable wallet top-up route yet (only an internal billing-worker
//     one an owner can't self-serve from here) — say so plainly and point at support, rather than
//     fabricating a button that would fail.
//   - quota_exceeded / infra_quota_exceeded → an ORG-level plan quota, not fixable by a purchase
//     here at all — message + support link only.

import * as React from "react";
import { getPricing, checkoutCreditPack, checkoutBusinessSubscription, type PricingPlan, type CreditPack } from "@/lib/api";
import type { SessionCredentials } from "@/lib/api";

const PURCHASABLE_CODES = new Set(["insufficient_credits", "subscription_inactive"]);

function isWalletMessage(message: string): boolean {
  return message.toLowerCase().includes("wallet");
}

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function UpgradeDialog({
  spaceId,
  session,
  errorCode,
  message,
  supportContact,
  onClose,
}: {
  spaceId: string;
  session: SessionCredentials;
  errorCode: string;
  message: string;
  supportContact?: string | null | undefined;
  onClose: () => void;
}) {
  const isWallet = errorCode === "insufficient_credits" && isWalletMessage(message);
  const purchasable = PURCHASABLE_CODES.has(errorCode) && !isWallet;

  const [loading, setLoading] = React.useState(purchasable);
  const [plans, setPlans] = React.useState<PricingPlan[]>([]);
  const [packs, setPacks] = React.useState<CreditPack[]>([]);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [checkoutBusyId, setCheckoutBusyId] = React.useState<string | null>(null);
  const [checkoutError, setCheckoutError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!purchasable) return;
    let cancelled = false;
    setLoading(true);
    getPricing(spaceId, session)
      .then((r) => {
        if (cancelled) return;
        setPlans(r.plans);
        setPacks(r.credit_packs);
      })
      .catch(() => { if (!cancelled) setLoadFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [purchasable, spaceId, session]);

  async function buyPack(packId: string) {
    setCheckoutBusyId(packId);
    setCheckoutError(null);
    try {
      const { checkout_url } = await checkoutCreditPack(spaceId, session, packId);
      window.location.href = checkout_url;
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : "Couldn't start checkout");
      setCheckoutBusyId(null);
    }
  }

  async function subscribe(planId: string) {
    setCheckoutBusyId(planId);
    setCheckoutError(null);
    try {
      const { checkout_url } = await checkoutBusinessSubscription(spaceId, session, planId);
      window.location.href = checkout_url;
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : "Couldn't start checkout");
      setCheckoutBusyId(null);
    }
  }

  const nothingToBuy = purchasable && !loading && !loadFailed && plans.length === 0 && packs.length === 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)",
          maxWidth: 440, width: "100%", padding: 20, maxHeight: "85vh", overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span aria-hidden style={{ fontSize: 16 }}>💳</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
            {errorCode === "subscription_inactive" ? "Subscription needed" : "Out of credits"}
          </span>
        </div>
        <p style={{ fontSize: 13, color: "var(--text2)", marginBottom: 16, lineHeight: 1.5 }}>{message}</p>

        {isWallet && (
          <p style={{ fontSize: 12.5, color: "var(--text3)", marginBottom: 4 }}>
            This is the business&apos;s own wallet, not your personal balance — ask the business owner to top
            it up from the Dashboard&apos;s Business Wallet section.
          </p>
        )}

        {errorCode === "quota_exceeded" || errorCode === "infra_quota_exceeded" ? (
          <p style={{ fontSize: 12.5, color: "var(--text3)", marginBottom: 4 }}>
            This business has reached its plan&apos;s monthly usage limit — the owner can upgrade the
            platform plan from the Dashboard, or wait for it to reset next month.
          </p>
        ) : null}

        {purchasable && loading && <p style={{ fontSize: 12.5, color: "var(--text3)" }}>Loading options…</p>}
        {purchasable && loadFailed && (
          <p style={{ fontSize: 12.5, color: "var(--text3)" }}>Couldn&apos;t load purchase options right now.</p>
        )}
        {nothingToBuy && (
          <p style={{ fontSize: 12.5, color: "var(--text3)" }}>
            This business hasn&apos;t set up a way to buy more credits yet.
          </p>
        )}

        {packs.length > 0 && (
          <div style={{ marginBottom: plans.length ? 14 : 4 }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 6 }}>
              Buy credits
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {packs.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="btn btn-primary btn-sm"
                  style={{ justifyContent: "space-between", display: "flex" }}
                  disabled={checkoutBusyId !== null}
                  onClick={() => void buyPack(p.id)}
                >
                  <span>{p.name} — {p.credits} credits</span>
                  <span>{checkoutBusyId === p.id ? "…" : formatPrice(p.price_cents)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {plans.length > 0 && (
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 6 }}>
              Subscribe
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {plans.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="btn btn-primary btn-sm"
                  style={{ justifyContent: "space-between", display: "flex" }}
                  disabled={checkoutBusyId !== null}
                  onClick={() => void subscribe(p.id)}
                >
                  <span>{p.name}{p.credit_allowance ? ` — ${p.credit_allowance} credits/${p.interval}` : ""}</span>
                  <span>{checkoutBusyId === p.id ? "…" : `${formatPrice(p.price_cents)}/${p.interval}`}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {checkoutError && (
          <p style={{ fontSize: 12, color: "#dc2626", marginTop: 10 }}>{checkoutError}</p>
        )}

        {supportContact && (
          <p style={{ fontSize: 12, color: "var(--text3)", marginTop: 14 }}>
            Need help? <a href={supportContact} style={{ color: "var(--accent)" }}>Contact support</a>
          </p>
        )}

        <div style={{ marginTop: 16, textAlign: "right" }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}
