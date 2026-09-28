"use client";

import { Button } from "@naelao/ui";
import * as React from "react";

export interface PartnerClient {
  subscription_id: string;
  space_name: string;
  plan_price_cents: number;
  attribution_channel: string;
  remaining_commission_cycles: { entry: number; growth: number; pro: null };
}
export interface PartnerPortfolio {
  clients: PartnerClient[];
  earnings: { pending_cents: number; lifetime_cents: number; currency: string };
}

/** Dashboard surface embedded by the tpl_dev_foundry_v1 self-hosting template. */
export function PartnerFoundry({
  portfolio,
  platformUrl,
  developerHandle,
  onWithdraw,
}: {
  portfolio: PartnerPortfolio;
  platformUrl: string;
  developerHandle: string;
  onWithdraw: () => Promise<void>;
}) {
  const [withdrawing, setWithdrawing] = React.useState(false);
  const currency = (cents: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: portfolio.earnings.currency,
    }).format(cents / 100);
  const referral = (slug: string) =>
    `${platformUrl.replace(/\/$/, "")}/p/${slug}?ref=${encodeURIComponent(developerHandle)}`;
  return (
    <section aria-labelledby="partner-foundry-title">
      <h1 id="partner-foundry-title">Developer Foundry</h1>
      <div className="grid-3">
        <div className="card">
          <div className="card-label">Pending earnings</div>
          <div className="card-value">
            {currency(portfolio.earnings.pending_cents)}
          </div>
          <Button
            disabled={withdrawing || portfolio.earnings.pending_cents === 0}
            onClick={async () => {
              setWithdrawing(true);
              try {
                await onWithdraw();
              } finally {
                setWithdrawing(false);
              }
            }}
          >
            {withdrawing ? "Queuing…" : "Withdraw earnings"}
          </Button>
        </div>
        <div className="card">
          <div className="card-label">Lifetime earnings</div>
          <div className="card-value">
            {currency(portfolio.earnings.lifetime_cents)}
          </div>
        </div>
        <div className="card">
          <div className="card-label">Active client spaces</div>
          <div className="card-value">{portfolio.clients.length}</div>
        </div>
      </div>
      <h2 style={{ marginTop: 24 }}>Client portfolio</h2>
      <div className="card">
        {portfolio.clients.map((client) => (
          <div
            key={client.subscription_id}
            style={{
              padding: "12px 0",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <strong>{client.space_name}</strong>
            <div style={{ fontSize: 12, color: "var(--text3)" }}>
              {client.attribution_channel.replaceAll("_", " ")} ·{" "}
              {client.remaining_commission_cycles.entry}/6 entry and{" "}
              {client.remaining_commission_cycles.growth}/12 growth cycles
              remaining
            </div>
            <code style={{ fontSize: 11 }}>
              {referral(
                client.space_name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
              )}
            </code>
          </div>
        ))}
      </div>
    </section>
  );
}
