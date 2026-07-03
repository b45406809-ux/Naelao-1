"use client";

import type { StepProps } from "../wizardTypes";

// Logo/favicon are URL inputs, not a file-upload widget: the Builder Dashboard API (Phase 3)
// stores these as plain URL strings in productConfig.branding, and no R2 upload endpoint for
// product branding assets exists yet — building one is a real, separate piece of infra (an
// authenticated upload route + bucket policy), not something this wizard step should invent.
// A builder hosts their own logo (or uses the KB/R2 upload flow elsewhere) and pastes the URL.

export default function BrandingStep({ state, update }: StepProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Brand it</h2>
        <p className="text-sm text-gray-500 mt-1">All optional — you can change this anytime.</p>
      </div>

      <div className="flex items-center gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Brand color</label>
          <input
            type="color"
            value={state.brandColor}
            onChange={(e) => update({ brandColor: e.target.value })}
            className="h-10 w-16 border border-gray-300 rounded-lg cursor-pointer"
          />
        </div>
        <div
          className="flex-1 h-10 rounded-lg flex items-center px-4 text-white text-sm font-semibold mt-6"
          style={{ backgroundColor: state.brandColor }}
        >
          Preview
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Logo URL</label>
        <input
          type="text"
          value={state.logoUrl}
          onChange={(e) => update({ logoUrl: e.target.value })}
          placeholder="https://..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Favicon URL</label>
        <input
          type="text"
          value={state.faviconUrl}
          onChange={(e) => update({ faviconUrl: e.target.value })}
          placeholder="https://..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Short description</label>
        <textarea
          value={state.productDescription}
          onChange={(e) => update({ productDescription: e.target.value })}
          rows={3}
          placeholder="What is this product, in one or two sentences?"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm resize-none"
        />
      </div>
    </div>
  );
}
