"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { updateBuilderProduct } from "@/lib/api";
import type { BuilderProductConfig } from "@/lib/api";
import { useProduct } from "../productContext";

// Hardcoded to match workers/agents/src/launchpad/spacetype.ts's LAUNCHPAD_TEMPLATES — same
// simplification as apps/shell's create-business dialog (Phase C): no product-scoped, builder-
// reachable /templates read route exists yet, so this is a static catalogue, not a fetched one.
const LAUNCHPAD_TEMPLATES = [
  { id: "creator-store", name: "Creator Store" },
  { id: "newsletter-business", name: "Newsletter Business" },
  { id: "micro-saas", name: "Micro-SaaS" },
  { id: "service-agency", name: "Service Agency" },
  { id: "coaching-community", name: "Coaching / Community" },
  { id: "whop-seller", name: "Whop Seller" },
  { id: "customer-service", name: "Customer Service Desk" },
];

export default function ProductConfigurationPage() {
  const params = useParams<{ productId: string }>();
  const { product, loading, refetch } = useProduct();
  const [form, setForm] = useState<BuilderProductConfig>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (product) setForm(product.product_config);
  }, [product]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateBuilderProduct(params.productId, { product_config: form });
      await refetch();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading || !product) return <div className="text-center py-12 text-gray-400">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Branding</h2>
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <input
              type="color"
              value={form.branding?.brandColor ?? "#4f46e5"}
              onChange={(e) => setForm((f) => ({ ...f, branding: { ...f.branding, brandColor: e.target.value } }))}
              className="h-10 w-16 border border-gray-300 rounded-lg cursor-pointer"
            />
            <div
              className="flex-1 h-10 rounded-lg flex items-center px-4 text-white text-sm font-semibold"
              style={{ backgroundColor: form.branding?.brandColor ?? "#4f46e5" }}
            >
              Preview
            </div>
          </div>
          <input
            type="text"
            value={form.branding?.logoUrl ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, branding: { ...f.branding, logoUrl: e.target.value } }))}
            placeholder="Logo URL"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none"
          />
          <textarea
            value={form.branding?.productDescription ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, branding: { ...f.branding, productDescription: e.target.value } }))}
            placeholder="Description"
            rows={2}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none resize-none"
          />
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Sign-in</h2>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={form.authProvider?.requireAdminApproval ?? false}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                authProvider: { provider: f.authProvider?.provider ?? "naelao-native", ...f.authProvider, requireAdminApproval: e.target.checked },
              }))
            }
            className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          />
          Require my approval before a new sign-up can use the product
        </label>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Product Mode</h2>
        <div className="space-y-3">
          <div className="flex gap-3">
            {(["team", "tenant", "hybrid"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setForm((f) => ({ ...f, membershipModel: mode }))}
                className={`flex-1 text-left px-4 py-3 rounded-lg border text-sm transition-colors ${
                  (form.membershipModel ?? "team") === mode
                    ? "border-brand-500 bg-brand-50 text-brand-800"
                    : "border-gray-200 text-gray-600 hover:border-gray-300"
                }`}
              >
                <div className="font-semibold capitalize">{mode}</div>
                <div className="text-xs mt-0.5 text-gray-500">
                  {mode === "team" && "One shared business — end users join by invite."}
                  {mode === "tenant" && "End users create and own their own business."}
                  {mode === "hybrid" && "End users can join the shared business AND create their own."}
                </div>
              </button>
            ))}
          </div>

          {form.membershipModel !== "team" && (
            <>
              <label className="flex items-center gap-2 text-sm text-gray-700 pt-2">
                <input
                  type="checkbox"
                  checked={form.allowPublicSignup ?? false}
                  onChange={(e) => setForm((f) => ({ ...f, allowPublicSignup: e.target.checked }))}
                  className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                />
                Allow end users to sign up and create their own business
              </label>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  SpaceTypes end users may instantiate
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input
                    type="checkbox"
                    checked={(form.allowedChildSpaceTypes ?? []).includes("launchpad")}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        allowedChildSpaceTypes: e.target.checked ? ["launchpad"] : [],
                      }))
                    }
                    className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  Launchpad
                </label>
              </div>
            </>
          )}
        </div>
      </div>

      {form.membershipModel !== "team" && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Templates Catalog</h2>
          <p className="text-xs text-gray-400 mb-3">
            Which business templates end users can pick from when creating their own business.
            Leave everything unchecked to offer all of them.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {LAUNCHPAD_TEMPLATES.map((t) => {
              const selected = form.catalog?.businessTemplates ?? [];
              const checked = selected.includes(t.id);
              return (
                <label key={t.id} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      setForm((f) => {
                        const current = f.catalog?.businessTemplates ?? [];
                        const next = e.target.checked ? [...current, t.id] : current.filter((id) => id !== t.id);
                        return { ...f, catalog: { ...f.catalog, businessTemplates: next } };
                      })
                    }
                    className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  {t.name}
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Limits</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Max threads per user</label>
            <input
              type="number"
              min={0}
              value={form.userPermissions?.maxThreadsPerUser ?? ""}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  userPermissions: { ...f.userPermissions, maxThreadsPerUser: e.target.value === "" ? null : Number(e.target.value) },
                }))
              }
              placeholder="Unlimited"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Max credits per month</label>
            <input
              type="number"
              min={0}
              value={form.userPermissions?.maxCreditsPerMonth ?? ""}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  userPermissions: { ...f.userPermissions, maxCreditsPerMonth: e.target.value === "" ? null : Number(e.target.value) },
                }))
              }
              placeholder="Unlimited"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none"
            />
          </div>
        </div>
        <div className="flex flex-col gap-2 mt-4">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.userPermissions?.canCreateSubSpaces ?? false}
              onChange={(e) => setForm((f) => ({ ...f, userPermissions: { ...f.userPermissions, canCreateSubSpaces: e.target.checked } }))}
              className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
            />
            End users may create sub-spaces (departments)
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.userPermissions?.canCreateProjects ?? true}
              onChange={(e) => setForm((f) => ({ ...f, userPermissions: { ...f.userPermissions, canCreateProjects: e.target.checked } }))}
              className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
            />
            End users may create projects
          </label>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Pricing</h2>
        <p className="text-sm text-gray-700 capitalize">
          Model: <span className="font-medium">{form.pricingConfig?.model ?? "free"}</span>
        </p>
        <p className="text-xs text-gray-400 mt-1">
          Changing the pricing model requires care since it affects existing customers — contact
          support to migrate.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3">{error}</div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {saved && <span className="text-sm text-green-600">Saved.</span>}
      </div>
    </div>
  );
}
