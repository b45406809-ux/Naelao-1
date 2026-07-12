"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { updateBuilderProduct, getTemplates } from "@/lib/api";
import type { BuilderProductConfig, TemplateInfo } from "@/lib/api";
import { useProduct } from "../productContext";

export default function ProductConfigurationPage() {
  const params = useParams<{ productId: string }>();
  const { product, loading, refetch } = useProduct();
  const [name, setName] = useState("");
  const [form, setForm] = useState<BuilderProductConfig>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Phase F (§A1.17): fetched from the real, coming_soon-aware GET /templates catalog instead of
  // a hardcoded duplicate of LAUNCHPAD_TEMPLATES — de-drifts this page from apps/shell's dialog.
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);

  useEffect(() => {
    if (product) {
      setForm(product.product_config);
      setName(product.name);
    }
  }, [product]);

  useEffect(() => {
    void getTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateBuilderProduct(params.productId, { name: name.trim() || product?.name || "Untitled Product", product_config: form });
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
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Product Name</h2>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Product name"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 outline-none"
        />
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

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Model</h2>
        <p className="text-xs text-gray-400 mb-3">
          The LLM your product&apos;s agents run on. A pricier model costs more per message but may
          give better answers for complex work.
        </p>
        <div className="flex gap-3">
          {(
            [
              { id: "claude-haiku-4-5-20251001", label: "Haiku", blurb: "Fastest, cheapest — good for most conversations." },
              { id: "claude-sonnet-4-6", label: "Sonnet", blurb: "Balanced — the default for most products." },
              { id: "claude-opus-4-8", label: "Opus", blurb: "Most capable, highest cost — complex reasoning." },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setForm((f) => ({ ...f, modelConfig: { model: m.id } }))}
              className={`flex-1 text-left px-4 py-3 rounded-lg border text-sm transition-colors ${
                (form.modelConfig?.model ?? "claude-haiku-4-5-20251001") === m.id
                  ? "border-brand-500 bg-brand-50 text-brand-800"
                  : "border-gray-200 text-gray-600 hover:border-gray-300"
              }`}
            >
              <div className="font-semibold">{m.label}</div>
              <div className="text-xs mt-0.5 text-gray-500">{m.blurb}</div>
            </button>
          ))}
        </div>
      </div>

      {form.membershipModel !== "team" && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Templates Catalog</h2>
          <p className="text-xs text-gray-400 mb-3">
            Which business templates end users can pick from when creating their own business.
            Leave everything unchecked to offer all of them. Templates marked "Coming soon" are
            not yet selectable by end users regardless of this setting.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {templates.map((t) => {
              const selected = form.catalog?.businessTemplates ?? [];
              const checked = selected.includes(t.id);
              return (
                <label
                  key={t.id}
                  className={`flex items-center gap-2 text-sm ${t.coming_soon ? "text-gray-400" : "text-gray-700"}`}
                >
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
                  {t.coming_soon && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-yellow-50 text-yellow-700">Coming soon</span>
                  )}
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
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Notifications</h2>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={form.notificationsConfig?.dailyDigestEnabled ?? false}
            onChange={(e) => setForm((f) => ({ ...f, notificationsConfig: { ...f.notificationsConfig, dailyDigestEnabled: e.target.checked } }))}
            className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          />
          Email me a daily digest of agent activity
        </label>
        <p className="text-xs text-gray-400 mt-1">
          Runs completed, failures, and approvals from the last 24 hours — sent once a day, only
          when there was activity to report.
        </p>
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
