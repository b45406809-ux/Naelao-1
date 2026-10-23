"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBuilderProduct } from "@/lib/api";

export default function InitializeLaunchpadPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function initialize() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const product = await createBuilderProduct({ name: "Launchpad", spacetype_id: "launchpad" });
      router.replace(`/dashboard/products/${encodeURIComponent(product.id)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Launchpad setup failed";
      if (/already exists|launchpad_already_exists/i.test(message)) {
        router.replace("/dashboard/products");
        return;
      }
      setError(message);
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Set up Launchpad</h1>
        <p className="text-gray-500 mt-1">Initialize Naelao’s single Launchpad product workspace.</p>
      </div>
      <section className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="font-semibold text-gray-900">Launchpad</h2>
        <p className="text-sm text-gray-500 mt-2">This creates the one Launchpad root for the Naelao team. Product type and defaults are managed centrally; there are no templates or separate product plans to choose here.</p>
        {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-5">{error}</p>}
        <div className="flex items-center gap-3 mt-6">
          <button type="button" onClick={() => void initialize()} disabled={busy} className="px-5 py-2.5 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50">
            {busy ? "Setting up…" : "Initialize Launchpad"}
          </button>
          <button type="button" onClick={() => router.back()} disabled={busy} className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">Cancel</button>
        </div>
      </section>
    </div>
  );
}
