"use client";

import type { StepProps } from "../wizardTypes";
import { SLUG_PATTERN } from "../wizardTypes";

export default function DomainStep({ state, update }: StepProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Where does it live?</h2>
        <p className="text-sm text-gray-500 mt-1">
          Optional now — attach a custom domain here or later from Product Settings.
        </p>
      </div>

      <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
        <p className="text-sm text-gray-700">
          <span className="font-medium">Naelao subdomain:</span>{" "}
          {state.productSlug && SLUG_PATTERN.test(state.productSlug)
            ? `${state.productSlug}.naelao.app`
            : "Not set — pick one on the Identity step, or use only a custom domain."}
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Custom domain <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <input
          type="text"
          value={state.customDomain}
          onChange={(e) => update({ customDomain: e.target.value })}
          placeholder="shop.yourcompany.com"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
        />
        <p className="text-xs text-gray-400 mt-1">
          After launch, you&apos;ll get a DNS record to add — Naelao issues the certificate once
          it verifies.
        </p>
      </div>
    </div>
  );
}
