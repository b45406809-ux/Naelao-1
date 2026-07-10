"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { updateBuilderProduct } from "@/lib/api";
import type { BuilderProductConfig } from "@/lib/api";
import { useProduct } from "../productContext";

type LegalConfig = NonNullable<BuilderProductConfig["legal"]>;
const COOKIE_POLICY_LABELS: Record<NonNullable<LegalConfig["cookiePolicy"]>, string> = {
  none: "None — only mandatory session cookies (no consent banner needed)",
  analytics: "First-party analytics — session + one own-analytics cookie",
  third_party: "Third-party tracking — show a consent banner before setting non-essential cookies",
};

export default function ProductLegalPage() {
  const params = useParams<{ productId: string }>();
  const { product, loading, refetch } = useProduct();
  const [form, setForm] = useState<LegalConfig>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // exactOptionalPropertyTypes forbids assigning an explicit `undefined` to an optional prop, so
  // an empty input clears the field by DELETING the key rather than setting it to undefined.
  const setField = (key: keyof LegalConfig, value: string) =>
    setForm((f) => {
      const next: LegalConfig = { ...f };
      if (value) next[key] = value as never;
      else delete next[key];
      return next;
    });

  useEffect(() => {
    if (product) setForm(product.product_config.legal ?? {});
  }, [product]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateBuilderProduct(params.productId, { legal: form });
      setSaved(true);
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-gray-500 text-sm">Loading…</p>;

  return (
    <form onSubmit={handleSave} className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Legal & Support</h2>
        <p className="text-sm text-gray-500 mb-6">
          These links are shown to end users in the signup flow, app footer, error screens, and
          the 402 credit-exhaustion page. Builders operating under GDPR / UK GDPR / CCPA
          must configure ToS + Privacy Policy before going public — if unset, the shell falls
          back to Naelao&apos;s own platform legal links.
        </p>

        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Terms of Service URL <span className="text-gray-400 font-normal">(https://)</span>
            </label>
            <input
              type="url"
              value={form.tosUrl ?? ""}
              onChange={(e) => setField("tosUrl", e.target.value)}
              placeholder="https://your-product.com/terms"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Privacy Policy URL <span className="text-gray-400 font-normal">(https://)</span>
            </label>
            <input
              type="url"
              value={form.privacyPolicyUrl ?? ""}
              onChange={(e) => setField("privacyPolicyUrl", e.target.value)}
              placeholder="https://your-product.com/privacy"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Data Processing Agreement URL{" "}
              <span className="text-gray-400 font-normal">(optional — for enterprise customers)</span>
            </label>
            <input
              type="url"
              value={form.dpaUrl ?? ""}
              onChange={(e) => setField("dpaUrl", e.target.value)}
              placeholder="https://your-product.com/dpa"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Cookie Policy</label>
            <div className="space-y-2">
              {(["none", "analytics", "third_party"] as const).map((policy) => (
                <label key={policy} className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="cookiePolicy"
                    value={policy}
                    checked={(form.cookiePolicy ?? "none") === policy}
                    onChange={() => setForm((f) => ({ ...f, cookiePolicy: policy }))}
                    className="mt-0.5"
                  />
                  <span className="text-sm text-gray-700">{COOKIE_POLICY_LABELS[policy]}</span>
                </label>
              ))}
            </div>
            {(form.cookiePolicy === "third_party") && (
              <p className="mt-2 text-xs text-amber-700 bg-amber-50 rounded px-3 py-2">
                A cookie consent banner will be shown to end users on first visit. Without one,
                setting third-party cookies in the EU/UK constitutes a legal violation (ePrivacy Directive).
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Support Contact{" "}
              <span className="text-gray-400 font-normal">(https:// or mailto: — shown to end users on error pages)</span>
            </label>
            <input
              type="text"
              value={form.supportContact ?? ""}
              onChange={(e) => setField("supportContact", e.target.value)}
              placeholder="mailto:support@your-product.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              This is shown on the 402 credit-exhaustion screen and verification-failure pages so a
              stuck user always has a path to a human. If unset, the shell links to the generic
              Naelao support page.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}
      {saved && (
        <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg px-4 py-3 text-sm">
          Legal settings saved.
        </div>
      )}

      <div className="pt-2">
        <button
          type="submit"
          disabled={saving}
          className="bg-brand-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save Legal Settings"}
        </button>
      </div>

      <div className="border-t border-gray-200 pt-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Platform-level legal (always applies)</h3>
        <p className="text-sm text-gray-500 mb-2">
          Your product runs on the Naelao platform. Regardless of your own policies above, the
          following platform agreements govern the infrastructure layer:
        </p>
        <ul className="text-sm text-gray-500 space-y-1 list-disc list-inside">
          <li><a href="https://naelao.com/legal/terms" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">Naelao Platform Terms of Service</a></li>
          <li><a href="https://naelao.com/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">Naelao Privacy Policy</a></li>
          <li><a href="https://naelao.com/legal/dpa" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">Naelao Data Processing Agreement</a> (for GDPR/CCPA compliance)</li>
          <li><a href="https://naelao.com/legal/subprocessors" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">Sub-processor list</a> (Anthropic, Cloudflare, Lemon Squeezy)</li>
        </ul>
      </div>
    </form>
  );
}
