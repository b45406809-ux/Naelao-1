"use client";

export const runtime = "edge";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { updateBuilderProduct, getOpenRouterWorkerModelCards, type OpenRouterWorkerModelCard } from "@/lib/api";
import type { BuilderProductConfig } from "@/lib/api";
import { useProduct } from "../productContext";
import { ALLOWED_MODELS } from "@naelao/billing-core";

/** Cheapest capable model that actually resolves on a Workers-AI-only gateway. Claude ids stay
 *  selectable for deployments whose gateway has Anthropic wired, but they can't be the default
 *  here: a product born pointing at an unreachable model fails at its first message. */
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Short human labels for the shared allowlist. An id with no entry falls back to the id itself,
 *  so adding a model to ALLOWED_MODELS can never leave this picker blank. */
const MODEL_LABELS: Record<string, string> = {
  "claude-haiku-4-5-20251001": "Haiku — needs Anthropic on your gateway",
  "claude-sonnet-4-6": "Sonnet — needs Anthropic on your gateway",
  "claude-opus-4-8": "Opus — needs Anthropic on your gateway",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "Llama 3.3 70B — balanced default",
  "@cf/meta/llama-4-scout-17b-16e-instruct": "Llama 4 Scout — fast",
  "@cf/openai/gpt-oss-120b": "GPT-OSS 120B — most capable",
  "@cf/openai/gpt-oss-20b": "GPT-OSS 20B — cheap",
  "@cf/qwen/qwen3-30b-a3b-fp8": "Qwen3 30B",
  "@cf/mistralai/mistral-small-3.1-24b-instruct": "Mistral Small",
  "@cf/ibm-granite/granite-4.0-h-micro": "Granite Micro — cheapest",
  "@cf/google/gemma-4-26b-a4b-it": "Gemma 4 26B",
  "@cf/zai-org/glm-4.7-flash": "GLM 4.7 Flash",
  "@cf/zai-org/glm-5.2": "GLM 5.2",
  "@cf/nvidia/nemotron-3-120b-a12b": "Nemotron 3 120B",
  "@cf/moonshotai/kimi-k2.6": "Kimi K2.6",
  "@cf/moonshotai/kimi-k2.7-code": "Kimi K2.7 Code",
  "google-ai-studio/gemini-flash-lite-latest": "Gemini Flash-Lite — needs a Google AI Studio key configured",
  "google-ai-studio/gemini-flash-latest": "Gemini Flash — needs a Google AI Studio key configured",
  "google-ai-studio/gemini-pro-latest": "Gemini Pro — needs a Google AI Studio key configured",
};

export default function ProductConfigurationPage() {
  const params = useParams<{ productId: string }>();
  const { product, loading, refetch } = useProduct();
  const [name, setName] = useState("");
  const [form, setForm] = useState<BuilderProductConfig>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [workerCards, setWorkerCards] = useState<OpenRouterWorkerModelCard[]>([]);
  const [workerModelSearch, setWorkerModelSearch] = useState("");

  useEffect(() => {
    if (product) {
      setForm(product.product_config);
      setName(product.name);
    }
  }, [product]);

  useEffect(() => {
    if (product) void getOpenRouterWorkerModelCards(product.id).then(setWorkerCards).catch(() => setWorkerCards([]));
  }, [product]);

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
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Model</h2>
        <p className="text-xs text-gray-400 mb-3">
          The LLM your product&apos;s agents run on. A pricier model costs more per message but may
          give better answers for complex work.
        </p>
        {/* Rendered from the shared allowlist rather than a hardcoded list. This used to offer
            only the three Claude ids — none of which resolve on an AI Gateway without Anthropic
            wired, which is this deployment (CLAUDE.md item 68). Every product created here was
            therefore born pointing at a model its own agents could never call, and the failure
            surfaced only at the first message. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {ALLOWED_MODELS.map((id) => {
            const selected = (form.modelConfig?.model ?? DEFAULT_MODEL) === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setForm((f) => ({ ...f, modelConfig: { model: id } }))}
                className={`text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                  selected ? "border-brand-500 bg-brand-50 text-brand-800" : "border-gray-200 text-gray-600 hover:border-gray-300"
                }`}
              >
                <div className="font-semibold text-xs">{MODEL_LABELS[id] ?? id}</div>
                <div className="text-[11px] mt-0.5 text-gray-400 font-mono truncate">{id}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Worker model pool</h2>
        <p className="text-xs text-gray-500 mb-4">Choose OpenRouter models workers may use. Cards and prices come from your active OpenRouter key. Eligibility is checked again when a worker starts; provider availability and your subscription limits can still change.</p>
        <label className="block text-xs font-medium text-gray-600 mb-1">Selection</label>
        <select value={form.workerModelPool?.selectionMode ?? "automatic"} onChange={e => setForm(f => ({ ...f, workerModelPool: { ...f.workerModelPool, modelIds: f.workerModelPool?.modelIds ?? [], selectionMode: e.target.value as "automatic" | "planner" } }))} className="mb-4 rounded border border-gray-300 px-2 py-1.5 text-sm">
          <option value="automatic">System One selects from this pool</option>
          <option value="planner">Planner chooses from this pool</option>
        </select>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          {(["inputUsdPerMillion", "outputUsdPerMillion"] as const).map(key => <label key={key} className="text-xs font-medium text-gray-600">Maximum {key.startsWith("input") ? "input" : "output"} price (USD / 1M tokens)
            <input type="number" min="0" max="1000" step="0.001" value={form.workerModelPool?.[key] ?? ""} onChange={e => setForm(f => ({ ...f, workerModelPool: { ...f.workerModelPool, modelIds: f.workerModelPool?.modelIds ?? [], [key]: e.target.value === "" ? undefined : Number(e.target.value) } }))} className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </label>)}
        </div>
        <input value={workerModelSearch} onChange={e => setWorkerModelSearch(e.target.value)} placeholder="Search OpenRouter model cards" className="mb-3 block w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        <div className="space-y-2 max-h-96 overflow-auto">
          {workerCards.filter(card => card.inputModalities?.includes("text") && card.outputModalities?.includes("text") && card.supportedParameters?.includes("tools") && `${card.name} ${card.model}`.toLowerCase().includes(workerModelSearch.toLowerCase())).map(card => {
            const ids = form.workerModelPool?.modelIds ?? [];
            const selected = ids.includes(card.model);
            return <label key={card.id} className="flex gap-3 rounded-lg border border-gray-200 p-3 text-sm">
              <input type="checkbox" checked={selected} onChange={e => setForm(f => {
                const current = f.workerModelPool?.modelIds ?? [];
                const modelIds = e.target.checked ? [...new Set([...current, card.model])] : current.filter(id => id !== card.model);
                const modelsByPlan = Object.fromEntries(Object.entries(f.workerModelPool?.modelsByPlan ?? {}).map(([planId, ids]) => [planId, ids.filter(id => id !== card.model)]));
                return { ...f, workerModelPool: { ...f.workerModelPool, modelIds, modelsByPlan, selectionMode: f.workerModelPool?.selectionMode ?? "automatic" } };
              })} className="mt-1 rounded border-gray-300 text-brand-600" />
              <span className="min-w-0"><span className="block font-medium text-gray-800">{card.name}</span><span className="block truncate font-mono text-[11px] text-gray-500">{card.model}</span><span className="block text-xs text-gray-500">{card.contextLength?.toLocaleString() ?? "Unknown"} context · input ${((card.promptPriceUsdPerToken ?? 0) * 1_000_000).toFixed(3)}/M · output ${((card.completionPriceUsdPerToken ?? 0) * 1_000_000).toFixed(3)}/M</span></span>
            </label>;
          })}
          {workerCards.length === 0 && <p className="text-sm text-gray-500">Connect an OpenRouter key in Space settings to load live model cards.</p>}
        </div>
        {(form.workerModelPool?.modelIds.length ?? 0) > 0 && <p className="mt-3 text-xs text-gray-500">Allowed worker models: {form.workerModelPool?.modelIds.length}. An empty pool uses the existing runtime default.</p>}

      </div>

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
