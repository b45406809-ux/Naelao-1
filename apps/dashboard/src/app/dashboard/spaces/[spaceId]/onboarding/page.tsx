"use client";

// First-run onboarding wizard. The provisioner records onboarding state on the space
// (config_json.onboarding) from the template's bootstrap; this renders it: credential prompts
// connect platforms (vault + MCP register), preference prompts become space preferences, and the
// projects the assistant will create are previewed. Finishing marks onboarding complete.

import { useEffect, useState, FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSpace, getTemplates, connectPlatform, apiFetch } from "@/lib/api";
import type { OnboardingPrompt, TemplateInfo } from "@/lib/api";

interface OnboardingState {
  template_id: string;
  status: "pending" | "complete";
  projects?: string[];
  setup_scripts?: string[];
}

export default function OnboardingPage() {
  const params = useParams();
  const router = useRouter();
  const spaceId = params["spaceId"] as string;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [template, setTemplate] = useState<TemplateInfo | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [space, templates] = await Promise.all([getSpace(spaceId), getTemplates()]);
        let cfg: Record<string, unknown> = {};
        try { cfg = JSON.parse(space.config_json || "{}") as Record<string, unknown>; } catch { cfg = {}; }
        setConfig(cfg);
        const ob = (cfg["onboarding"] as OnboardingState | undefined) ?? null;
        setOnboarding(ob);
        if (ob?.status === "complete") setDone(true);
        const tpl = templates.find((t) => t.id === (ob?.template_id ?? cfg["template_id"])) ?? null;
        setTemplate(tpl);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load onboarding");
      } finally {
        setLoading(false);
      }
    })();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [spaceId]);

  const prompts: OnboardingPrompt[] = template?.bootstrap?.prompts ?? [];

  async function finish(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // 1. Credential prompts → connect the platform (stores the key + registers the MCP server).
      for (const p of prompts) {
        if (p.type === "credential" && p.connector && answers[p.id]) {
          await connectPlatform(p.connector, spaceId, answers[p.id]!);
        }
      }
      // 2. Preference prompts → persist on the space (merge, don't clobber config_json).
      const preferences: Record<string, string> = {};
      for (const p of prompts) {
        if (p.type !== "credential" && answers[p.id]) preferences[p.id] = answers[p.id]!;
      }
      const merged = {
        ...config,
        preferences: { ...(config["preferences"] as object ?? {}), ...preferences },
      };
      // PATCH /spaces/:id expects snake_case config_overrides (replaces config_json wholesale).
      await apiFetch(`/spaces/${spaceId}`, { method: "PATCH", body: JSON.stringify({ config_overrides: merged }) });
      // 3. Run the bootstrap: create projects, run setup scripts, mark onboarding complete.
      await apiFetch(`/spaces/${spaceId}/bootstrap/complete`, { method: "POST", body: "{}" });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setSubmitting(false);
    }
  }

  function set(id: string, v: string) { setAnswers((a) => ({ ...a, [id]: v })); }

  if (loading) return <div className="mx-auto max-w-2xl px-4 py-8 text-sm text-gray-500">Loading…</div>;

  if (!template?.bootstrap) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900">Setup</h1>
        <p className="mt-2 text-sm text-gray-500">This space has no guided setup. You&apos;re all set.</p>
        <button onClick={() => router.push(`/dashboard/products/${spaceId}`)} className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white">
          Go to product
        </button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900">You&apos;re all set 🎉</h1>
        <p className="mt-2 text-sm text-gray-600">
          {template.name} is configured. Your assistant will set up these projects: {(onboarding?.projects ?? []).join(", ") || "—"}.
        </p>
        {/* Tier 2/3 follow-up: this button previously linked to /dashboard/spaces/:spaceId, which
            has no page.tsx at all (a dormant 404 — this page was orphaned, nothing ever reached
            it, so the broken link was never exercised). /dashboard/products/:productId is the
            actively-maintained product detail page; a product IS a deployed Space, so spaceId is
            exactly the id it expects. */}
        <button onClick={() => router.push(`/dashboard/products/${spaceId}`)} className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white">
          Go to product
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900">Set up {template.name}</h1>
      <p className="mt-1 mb-6 text-sm text-gray-500">{template.description}</p>

      {(onboarding?.projects?.length ?? 0) > 0 && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Your assistant will create</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {onboarding!.projects!.map((p) => (
              <span key={p} className="rounded-md bg-white px-2.5 py-1 text-sm text-gray-700 ring-1 ring-gray-200">{p}</span>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={finish} className="space-y-5">
        {prompts.map((p) => (
          <div key={p.id}>
            <label className="block text-sm font-medium text-gray-800">
              {p.question} {p.required && <span className="text-red-500">*</span>}
              {p.type === "credential" && <span className="ml-1 text-xs text-gray-400">(stored encrypted)</span>}
            </label>
            {p.type === "choice" ? (
              <select value={answers[p.id] ?? ""} onChange={(e) => set(p.id, e.target.value)} required={p.required} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">Select…</option>
                {(p.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : p.type === "boolean" ? (
              <select value={answers[p.id] ?? ""} onChange={(e) => set(p.id, e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">Select…</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            ) : (
              <input
                type={p.type === "credential" ? "password" : "text"}
                value={answers[p.id] ?? ""}
                onChange={(e) => set(p.id, e.target.value)}
                required={p.required}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            )}
          </div>
        ))}

        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={submitting} className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
          {submitting ? "Setting up…" : "Finish setup"}
        </button>
      </form>
    </div>
  );
}
