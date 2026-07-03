"use client";

import type { WizardState } from "../wizardTypes";
import { SLUG_PATTERN } from "../wizardTypes";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="text-sm font-medium text-gray-900 text-right">{value}</span>
    </div>
  );
}

export default function ReviewStep({ state }: { state: WizardState }) {
  const pricingLabel: Record<WizardState["pricingModel"], string> = {
    free: "Free",
    credits: `Credits (${state.creditsIncludedPerMonth || "0"} included/mo)`,
    subscription: `Subscription (${state.trialDays || "0"}-day trial)`,
    seats: `Seats ($${((Number(state.pricePerSeatCents) || 0) / 100).toFixed(2)}/seat)`,
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Review &amp; launch</h2>
        <p className="text-sm text-gray-500 mt-1">
          This creates a real, live product — agents install and it starts running immediately.
        </p>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <Row label="Name" value={state.name || "—"} />
        <Row
          label="Domain"
          value={
            state.productSlug && SLUG_PATTERN.test(state.productSlug)
              ? `${state.productSlug}.naelao.app`
              : "Not set yet"
          }
        />
        <Row label="Starting point" value={state.templateName ?? state.spacetypeId ?? "—"} />
        <Row label="Sign-in" value={state.authProvider} />
        <Row label="Pricing" value={pricingLabel[state.pricingModel]} />
        {state.customDomain && <Row label="Custom domain" value={state.customDomain} />}
      </div>
    </div>
  );
}
