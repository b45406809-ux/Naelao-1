"use client";

import type { StepProps } from "../wizardTypes";

const MODELS = [
  { id: "free", label: "Free", description: "No charge to end users" },
  { id: "credits", label: "Credits", description: "Monthly credit allowance + overage" },
  { id: "subscription", label: "Subscription", description: "Recurring plan with a trial" },
  { id: "seats", label: "Seats", description: "Charge per member" },
] as const;

export default function PricingStep({ state, update }: StepProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">How do you price it?</h2>
        <p className="text-sm text-gray-500 mt-1">
          What YOUR customers pay you — separate from your own wholesale billing with Naelao.
        </p>
      </div>

      <div role="group" aria-label="Pricing model" className="grid grid-cols-2 gap-3">
        {MODELS.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => update({ pricingModel: m.id })}
            aria-pressed={state.pricingModel === m.id}
            className={`text-left p-3 rounded-lg border-2 transition-colors ${
              state.pricingModel === m.id ? "border-brand-500 bg-brand-50" : "border-gray-200 hover:border-brand-200"
            }`}
          >
            <p className="text-sm font-semibold text-gray-900">{m.label}</p>
            <p className="text-xs text-gray-500 mt-0.5">{m.description}</p>
          </button>
        ))}
      </div>

      {state.pricingModel === "credits" && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="wizard-credits-included" className="block text-sm font-medium text-gray-700 mb-1">Credits included / month</label>
            <input
              id="wizard-credits-included" type="number" min="0" step="1" inputMode="numeric" value={state.creditsIncludedPerMonth}
              onChange={(e) => update({ creditsIncludedPerMonth: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none"
            />
          </div>
          <div>
            <label htmlFor="wizard-overage-price" className="block text-sm font-medium text-gray-700 mb-1">Overage price (cents/credit)</label>
            <input
              id="wizard-overage-price" type="number" min="0" step="1" inputMode="numeric" value={state.overageCreditsPriceCents}
              onChange={(e) => update({ overageCreditsPriceCents: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none"
            />
          </div>
        </div>
      )}

      {state.pricingModel === "subscription" && (
        <div>
          <label htmlFor="wizard-trial-days" className="block text-sm font-medium text-gray-700 mb-1">Trial days</label>
          <input
            id="wizard-trial-days" type="number" min="0" step="1" inputMode="numeric" value={state.trialDays}
            onChange={(e) => update({ trialDays: e.target.value })}
            className="w-40 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none"
          />
        </div>
      )}

      {state.pricingModel === "seats" && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="wizard-price-per-seat" className="block text-sm font-medium text-gray-700 mb-1">Price per seat (cents)</label>
            <input
              id="wizard-price-per-seat" type="number" min="0" step="1" inputMode="numeric" value={state.pricePerSeatCents}
              onChange={(e) => update({ pricePerSeatCents: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none"
            />
          </div>
          <div>
            <label htmlFor="wizard-seats-included" className="block text-sm font-medium text-gray-700 mb-1">Seats included</label>
            <input
              id="wizard-seats-included" type="number" min="0" step="1" inputMode="numeric" value={state.includedSeats}
              onChange={(e) => update({ includedSeats: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
