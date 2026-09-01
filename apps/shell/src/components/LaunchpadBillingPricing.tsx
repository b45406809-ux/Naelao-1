"use client";

import * as React from "react";
import {
  SAAS_TIER_CONFIGS,
  EXTENDED_RESOURCE_PRICING,
  type PlatformSaaSTier,
  type ExtendedMeteredResource,
} from "@naelao/billing-core";
import { type SessionCredentials, checkoutBusinessSubscription, checkoutCreditPack } from "@/lib/api";

interface LaunchpadBillingPricingProps {
  spaceId: string;
  session: SessionCredentials;
  currentTier?: PlatformSaaSTier;
  businessWalletBalanceCents?: number;
  onRefreshWallet?: () => void;
}

export function LaunchpadBillingPricing({
  spaceId,
  session,
  currentTier = "starter",
  businessWalletBalanceCents = 14250,
  onRefreshWallet,
}: LaunchpadBillingPricingProps) {
  const [activeTab, setActiveTab] = React.useState<"plans" | "metering" | "wallet_loop">("plans");
  const [billingCycle, setBillingCycle] = React.useState<"monthly" | "yearly">("monthly");
  const [checkoutBusyId, setCheckoutBusyId] = React.useState<string | null>(null);
  const [checkoutError, setCheckoutError] = React.useState<string | null>(null);

  // Self-funding withdrawal state
  const [withdrawAmount, setWithdrawAmount] = React.useState("100.00");
  const [withdrawMethod, setWithdrawMethod] = React.useState<"ach" | "crypto" | "stripe">("ach");
  const [withdrawing, setWithdrawing] = React.useState(false);
  const [withdrawSuccess, setWithdrawSuccess] = React.useState<string | null>(null);

  async function handlePlanSelect(tierId: PlatformSaaSTier) {
    if (tierId === "free") return;
    setCheckoutBusyId(tierId);
    setCheckoutError(null);
    try {
      const res = await checkoutBusinessSubscription(spaceId, session, tierId);
      if (res.dev) {
        setCheckoutError("Billing provider is in development mode — real checkouts activate with your live Lemon Squeezy API keys.");
        setCheckoutBusyId(null);
      } else if (res.checkout_url) {
        window.location.href = res.checkout_url;
      }
    } catch (err: any) {
      setCheckoutError(err?.message || "Failed to start subscription checkout.");
      setCheckoutBusyId(null);
    }
  }

  async function handleTopUpWallet(packId: string) {
    setCheckoutBusyId(packId);
    setCheckoutError(null);
    try {
      const res = await checkoutCreditPack(spaceId, session, packId);
      if (res.dev) {
        setCheckoutError("Payment rails in development sandbox mode.");
        setCheckoutBusyId(null);
      } else if (res.checkout_url) {
        window.location.href = res.checkout_url;
      }
    } catch (err: any) {
      setCheckoutError(err?.message || "Failed to initiate top-up.");
      setCheckoutBusyId(null);
    }
  }

  async function handleSimulateWithdrawal() {
    setWithdrawing(true);
    setWithdrawSuccess(null);
    setCheckoutError(null);
    try {
      await new Promise((r) => setTimeout(r, 1000));
      setWithdrawSuccess(`Successfully initiated payout of $${withdrawAmount} via ${withdrawMethod.toUpperCase()}. Retained compute buffer stays in SpaceDO ledger.`);
      if (onRefreshWallet) onRefreshWallet();
    } catch (err: any) {
      setCheckoutError(err?.message || "Withdrawal failed.");
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <div className="w-full max-w-6xl mx-auto p-6 space-y-8">
      {/* Header & Tabs */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-6">
        <div>
          <h1 className="text-2xl font-bold text-text tracking-tight">Venture Billing & Monetization</h1>
          <p className="text-sm text-text-muted mt-1">
            Hybrid Multi-Stream Model: SaaS Subscriptions, Unified Metering (1 Credit = $0.01), and Self-Funding Revenue Loops.
          </p>
        </div>

        {/* Tab Selection */}
        <div className="flex bg-surface-2 p-1 rounded-lg border border-border">
          <button
            type="button"
            className={`px-4 py-2 text-xs font-semibold rounded-md transition-all ${
              activeTab === "plans" ? "bg-primary text-white shadow" : "text-text-muted hover:text-text"
            }`}
            onClick={() => setActiveTab("plans")}
          >
            SaaS Plans
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-xs font-semibold rounded-md transition-all ${
              activeTab === "metering" ? "bg-primary text-white shadow" : "text-text-muted hover:text-text"
            }`}
            onClick={() => setActiveTab("metering")}
          >
            Usage Metering
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-xs font-semibold rounded-md transition-all ${
              activeTab === "wallet_loop" ? "bg-primary text-white shadow" : "text-text-muted hover:text-text"
            }`}
            onClick={() => setActiveTab("wallet_loop")}
          >
            Self-Funding Loop
          </button>
        </div>
      </div>

      {checkoutError && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg text-sm flex items-center justify-between">
          <span>{checkoutError}</span>
          <button type="button" onClick={() => setCheckoutError(null)} className="text-xs hover:underline">
            Dismiss
          </button>
        </div>
      )}

      {/* TAB 1: SAAS SUBSCRIPTION TIERS */}
      {activeTab === "plans" && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
              Select Business Tier (Launchpad Exclusive)
            </span>
            <div className="flex items-center gap-2 text-xs">
              <span className={billingCycle === "monthly" ? "text-text font-medium" : "text-text-muted"}>Monthly</span>
              <button
                type="button"
                className="w-10 h-5 bg-surface-3 rounded-full relative transition-colors"
                onClick={() => setBillingCycle(billingCycle === "monthly" ? "yearly" : "monthly")}
              >
                <div
                  className={`w-3.5 h-3.5 bg-primary rounded-full absolute top-0.5 transition-transform ${
                    billingCycle === "yearly" ? "translate-x-5" : "translate-x-1"
                  }`}
                />
              </button>
              <span className={billingCycle === "yearly" ? "text-text font-medium" : "text-text-muted"}>
                Yearly (20% off)
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {Object.values(SAAS_TIER_CONFIGS).map((plan) => {
              const isCurrent = currentTier === plan.id;
              const price = billingCycle === "yearly" ? Math.round((plan.priceMonthlyCents * 0.8) / 100) : plan.priceMonthlyCents / 100;

              return (
                <div
                  key={plan.id}
                  className={`relative flex flex-col justify-between p-6 rounded-xl border transition-all ${
                    isCurrent
                      ? "border-primary bg-primary/5 shadow-md"
                      : "border-border bg-surface hover:border-border-hover"
                  }`}
                >
                  {isCurrent && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                      Current Plan
                    </span>
                  )}

                  <div>
                    <h3 className="text-lg font-bold text-text">{plan.name}</h3>
                    <div className="mt-3 flex items-baseline gap-1">
                      <span className="text-3xl font-extrabold text-text">${price}</span>
                      <span className="text-xs text-text-muted">/ month</span>
                    </div>

                    <p className="text-xs text-text-muted mt-3">
                      {plan.includedComputeCreditsMonthly > 0
                        ? `Includes $${(plan.includedComputeCreditsMonthly / 100).toFixed(0)}/mo compute allowance`
                        : "BYOK (Zero token cost to platform)"}
                    </p>

                    <div className="mt-6 space-y-3 border-t border-border/50 pt-5 text-xs">
                      <div className="flex items-center justify-between text-text">
                        <span className="text-text-muted">Workspaces</span>
                        <span className="font-medium">{plan.maxWorkspaces}</span>
                      </div>
                      <div className="flex items-center justify-between text-text">
                        <span className="text-text-muted">Custom Domains</span>
                        <span className="font-medium">{plan.maxCustomDomains > 0 ? plan.maxCustomDomains : "None"}</span>
                      </div>
                      <div className="flex items-center justify-between text-text">
                        <span className="text-text-muted">Execution Tiers</span>
                        <span className="font-medium">Tiers 1–{Math.max(...plan.unlockedExecutionTiers)}</span>
                      </div>
                      <div className="flex items-center justify-between text-text">
                        <span className="text-text-muted">Voice Receptionist</span>
                        <span className="font-medium">{plan.features.voiceTelephonyDesk ? "Included" : "—"}</span>
                      </div>
                      <div className="flex items-center justify-between text-text">
                        <span className="text-text-muted">Linux Containers</span>
                        <span className="font-medium">{plan.features.linuxContainerSandbox ? "Enabled" : "—"}</span>
                      </div>
                      <div className="flex items-center justify-between text-text">
                        <span className="text-text-muted">Audit Retention</span>
                        <span className="font-medium">{plan.features.auditRetentionDays} Days</span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isCurrent || checkoutBusyId !== null}
                    onClick={() => handlePlanSelect(plan.id)}
                    className={`mt-6 w-full py-2.5 px-4 rounded-lg font-medium text-xs transition-all ${
                      isCurrent
                        ? "bg-surface-3 text-text-muted cursor-default"
                        : "bg-primary text-white hover:bg-primary-hover shadow"
                    }`}
                  >
                    {isCurrent ? "Active Plan" : checkoutBusyId === plan.id ? "Processing…" : `Upgrade to ${plan.name.split(" ")[0]}`}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 2: USAGE-BASED COMPUTE METERING */}
      {activeTab === "metering" && (
        <div className="space-y-6">
          <div className="bg-surface p-6 rounded-xl border border-border space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-text">Unified Platform Metering: 1 Credit = $0.01 USD</h2>
                <p className="text-xs text-text-muted mt-1">
                  Compute, container sandboxes, LLM tokens, and telephony minutes automatically consume from the business wallet or personal credit balance.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => handleTopUpWallet("pack_1000")}
                  className="px-3 py-1.5 bg-primary text-white rounded-md text-xs font-semibold hover:bg-primary-hover"
                >
                  + Top Up $10 (1,000 Credits)
                </button>
                <button
                  type="button"
                  onClick={() => handleTopUpWallet("pack_5000")}
                  className="px-3 py-1.5 bg-surface-3 text-text rounded-md text-xs font-semibold hover:bg-surface-2 border border-border"
                >
                  + Top Up $50 (5,000 Credits)
                </button>
              </div>
            </div>

            <div className="overflow-x-auto mt-4">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border text-text-muted font-medium">
                    <th className="py-2.5 px-3">Resource Category</th>
                    <th className="py-2.5 px-3">Metered Rate</th>
                    <th className="py-2.5 px-3">Platform Unit Cost</th>
                    <th className="py-2.5 px-3">Billing Mechanism</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50 text-text">
                  <tr>
                    <td className="py-3 px-3 font-medium">LLM Tokens (Non-BYOK)</td>
                    <td className="py-3 px-3">Model Cost + 15% margin</td>
                    <td className="py-3 px-3">Variable per 1M tokens</td>
                    <td className="py-3 px-3 text-text-muted"><code>tokensToCredits(in, out, model)</code></td>
                  </tr>
                  <tr>
                    <td className="py-3 px-3 font-medium text-green-400">BYOK (Bring Your Own Key)</td>
                    <td className="py-3 px-3 font-bold text-green-400">$0.00 / Token</td>
                    <td className="py-3 px-3 text-green-400">Direct Vendor Billing</td>
                    <td className="py-3 px-3 text-text-muted">Zero platform token markup</td>
                  </tr>
                  <tr>
                    <td className="py-3 px-3 font-medium">Tier 1: SQLite Virtual FS</td>
                    <td className="py-3 px-3">Free / Included</td>
                    <td className="py-3 px-3">$0.00</td>
                    <td className="py-3 px-3 text-text-muted">Sub-ms in SpaceDO storage</td>
                  </tr>
                  <tr>
                    <td className="py-3 px-3 font-medium">Tier 2: V8 Isolate CodeMode</td>
                    <td className="py-3 px-3">1 Credit / 100 runs</td>
                    <td className="py-3 px-3">$0.0001 / run</td>
                    <td className="py-3 px-3 text-text-muted">CF Worker dynamic isolate</td>
                  </tr>
                  <tr>
                    <td className="py-3 px-3 font-medium">Tier 3: Dynamic Workflows</td>
                    <td className="py-3 px-3">1 Credit / 20 steps</td>
                    <td className="py-3 px-3">$0.0005 / step</td>
                    <td className="py-3 px-3 text-text-muted">Durable CF Workflow orchestration</td>
                  </tr>
                  <tr>
                    <td className="py-3 px-3 font-medium">Tier 4: Kitesurf Agent Browser</td>
                    <td className="py-3 px-3">1 Credit / 10 scrapes</td>
                    <td className="py-3 px-3">$0.001 / scrape</td>
                    <td className="py-3 px-3 text-text-muted">Edge DOM extraction</td>
                  </tr>
                  <tr>
                    <td className="py-3 px-3 font-medium">Tier 5: Headless Chromium</td>
                    <td className="py-3 px-3">1 Credit / snapshot</td>
                    <td className="py-3 px-3">$0.01 / render</td>
                    <td className="py-3 px-3 text-text-muted">Visual QA browser snapshot</td>
                  </tr>
                  <tr>
                    <td className="py-3 px-3 font-medium">Tier 6: Linux Container Sandbox</td>
                    <td className="py-3 px-3">5 Credits / active hr</td>
                    <td className="py-3 px-3">$0.05 / hour</td>
                    <td className="py-3 px-3 text-text-muted">Full VM container compute</td>
                  </tr>
                  <tr>
                    <td className="py-3 px-3 font-medium">Voice Calling (@cloudflare/voice)</td>
                    <td className="py-3 px-3">4 Credits / minute</td>
                    <td className="py-3 px-3">$0.04 / min</td>
                    <td className="py-3 px-3 text-text-muted">Live STT + Cartesia/ElevenLabs TTS</td>
                  </tr>
                  <tr>
                    <td className="py-3 px-3 font-medium">Dedicated Telephony Line</td>
                    <td className="py-3 px-3">200 Credits / month</td>
                    <td className="py-3 px-3">$2.00 / month</td>
                    <td className="py-3 px-3 text-text-muted">Carrier provisioned DID line</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: SELF-FUNDING AUTONOMOUS BUSINESS LOOP */}
      {activeTab === "wallet_loop" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-surface p-6 rounded-xl border border-border space-y-2">
              <span className="text-xs text-text-muted uppercase font-semibold">SpaceDO Operating Wallet</span>
              <div className="text-3xl font-black text-text">${(businessWalletBalanceCents / 100).toFixed(2)}</div>
              <p className="text-[11px] text-text-muted">
                Funded by customer storefront checkouts, client invoices, or manual card top-ups.
              </p>
            </div>

            <div className="bg-surface p-6 rounded-xl border border-border space-y-2">
              <span className="text-xs text-text-muted uppercase font-semibold">Platform Take-Rates</span>
              <div className="text-3xl font-black text-primary">1.5% – 5.0%</div>
              <p className="text-[11px] text-text-muted">
                5% on digital storefront sales; 1.5% on client invoices & retainers.
              </p>
            </div>

            <div className="bg-surface p-6 rounded-xl border border-border space-y-2">
              <span className="text-xs text-text-muted uppercase font-semibold">Dev Marketplace Split</span>
              <div className="text-3xl font-black text-green-400">40% / 20%</div>
              <p className="text-[11px] text-text-muted">
                40% referral split to developer; 20% organic directory royalty.
              </p>
            </div>
          </div>

          {/* Self Funding Mechanics Visual Card */}
          <div className="bg-surface p-6 rounded-xl border border-border space-y-6">
            <h3 className="text-base font-bold text-text">The Self-Funding Autonomous Business Cycle</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              <div className="p-4 rounded-lg bg-surface-2 border border-border/80 space-y-2">
                <div className="font-bold text-text flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px]">1</span>
                  Payment Settlement
                </div>
                <p className="text-text-muted leading-relaxed">
                  Customer books a $150 appointment or service. Net $142.50 (after 5% platform cut) settles instantly to <code>SpaceDO.wallet_ledger</code>.
                </p>
              </div>

              <div className="p-4 rounded-lg bg-surface-2 border border-border/80 space-y-2">
                <div className="font-bold text-text flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center text-[10px]">2</span>
                  Autonomous AI Debits
                </div>
                <p className="text-text-muted leading-relaxed">
                  Autonomous voice receptionist confirms appointments (-$0.08) and container builds code (-$0.02) without needing manual card charges.
                </p>
              </div>

              <div className="p-4 rounded-lg bg-surface-2 border border-border/80 space-y-2">
                <div className="font-bold text-text flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center text-[10px]">3</span>
                  Founder Profit Withdrawal
                </div>
                <p className="text-text-muted leading-relaxed">
                  Founder requests payout on Telegram or UI. Funds route to external bank while retained buffer continues powering AI workflows.
                </p>
              </div>
            </div>

            {/* Payout / Withdrawal Section */}
            <div className="pt-4 border-t border-border flex flex-col md:flex-row items-end gap-4">
              <div className="flex-1 space-y-1">
                <label className="text-xs font-semibold text-text">Withdraw Operating Profits</label>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-text-muted">$</span>
                  <input
                    type="number"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    className="w-32 px-3 py-1.5 bg-surface-2 border border-border rounded-md text-xs text-text focus:outline-none focus:border-primary"
                    placeholder="100.00"
                  />
                  <select
                    value={withdrawMethod}
                    onChange={(e: any) => setWithdrawMethod(e.target.value)}
                    className="px-3 py-1.5 bg-surface-2 border border-border rounded-md text-xs text-text focus:outline-none focus:border-primary"
                  >
                    <option value="ach">ACH Bank Transfer</option>
                    <option value="stripe">Stripe Connect Payout</option>
                    <option value="crypto">USDC Crypto Wallet</option>
                  </select>
                </div>
              </div>

              <button
                type="button"
                disabled={withdrawing}
                onClick={handleSimulateWithdrawal}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-xs font-semibold rounded-md transition-all shadow"
              >
                {withdrawing ? "Processing…" : `Withdraw $${withdrawAmount} to Bank`}
              </button>
            </div>

            {withdrawSuccess && (
              <div className="p-3 bg-green-500/10 border border-green-500/20 text-green-400 rounded-md text-xs">
                {withdrawSuccess}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
