"use client";

import type { StepProps } from "../wizardTypes";
import { SLUG_PATTERN } from "../wizardTypes";

export default function IdentityStep({ state, update }: StepProps) {
  const slugValid = state.productSlug === "" || SLUG_PATTERN.test(state.productSlug);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Name your product</h2>
        <p className="text-sm text-gray-500 mt-1">
          What your customers and team will call it. You can change this later.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Product name</label>
        <input
          type="text"
          value={state.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="e.g. Acme Creator Store"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
          autoFocus
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Platform subdomain <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <div className="flex items-center">
          <input
            type="text"
            value={state.productSlug}
            onChange={(e) => update({ productSlug: e.target.value.toLowerCase() })}
            placeholder="acme-store"
            className={`flex-1 px-3 py-2 border rounded-l-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm ${
              slugValid ? "border-gray-300" : "border-red-300"
            }`}
          />
          <span className="px-3 py-2 bg-gray-50 border border-l-0 border-gray-300 rounded-r-lg text-sm text-gray-500">
            .naelao.app
          </span>
        </div>
        {!slugValid && (
          <p className="text-xs text-red-600 mt-1">
            2-40 characters: lowercase letters, numbers, and hyphens only.
          </p>
        )}
        <p className="text-xs text-gray-400 mt-1">
          Leave blank to pick this later, or use only a custom domain.
        </p>
      </div>
    </div>
  );
}
