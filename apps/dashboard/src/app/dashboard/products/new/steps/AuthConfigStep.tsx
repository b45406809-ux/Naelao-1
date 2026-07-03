"use client";

import type { StepProps } from "../wizardTypes";

const PROVIDERS = [
  { id: "naelao-native", label: "Naelao (email + password)" },
  { id: "clerk", label: "Clerk" },
  { id: "custom-oidc", label: "Custom OIDC" },
  { id: "saml-sso", label: "SAML SSO" },
] as const;

export default function AuthConfigStep({ state, update }: StepProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">How do end users sign in?</h2>
        <p className="text-sm text-gray-500 mt-1">
          This is separate from your own builder login — it controls how the people who use
          your product authenticate.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => update({ authProvider: p.id })}
            className={`text-left p-3 rounded-lg border-2 text-sm transition-colors ${
              state.authProvider === p.id
                ? "border-brand-500 bg-brand-50 text-brand-900"
                : "border-gray-200 hover:border-brand-200 text-gray-700"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {state.authProvider !== "naelao-native" && (
        <p className="text-xs text-gray-400 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
          Provider credentials (client ID/secret, issuer URL) are configured from Product Settings
          after launch — they live in the credentials vault, never in this wizard.
        </p>
      )}

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={state.requireAdminApproval}
          onChange={(e) => update({ requireAdminApproval: e.target.checked })}
          className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
        />
        Require my approval before a new sign-up can use the product
      </label>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Restrict sign-ups to email domains <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <input
          type="text"
          value={state.allowedEmailDomains}
          onChange={(e) => update({ allowedEmailDomains: e.target.value })}
          placeholder="acme.com, acme.io"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
        />
        <p className="text-xs text-gray-400 mt-1">Comma-separated. Leave blank to allow any email.</p>
      </div>
    </div>
  );
}
