"use client";

export const runtime = "edge";

import { useEffect, useState } from "react";
import { useProduct } from "../productContext";
import { getAssistantPolicy, updateAssistantPolicy } from "@/lib/api";
import type { AssistantPolicy } from "@/lib/api";

/** The product uses Naelao's shared agent runtime. Workers are configured in the shell's
 * worker-creation flow; this page only controls the space assistant's approval policy. */
export default function ProductAgentsPage() {
  const { product, loading } = useProduct();
  const [policy, setPolicy] = useState<AssistantPolicy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!product) return;
    setPolicyLoading(true);
    getAssistantPolicy(product.id)
      .then(setPolicy)
      .catch(() => setPolicy({ approval_mode: "always_ask", auto_approved_actions: [] }))
      .finally(() => setPolicyLoading(false));
  }, [product]);

  async function setAutonomy(autonomous: boolean) {
    if (!product) return;
    setSaving(true);
    try {
      setPolicy(await updateAssistantPolicy(product.id, { approval_mode: autonomous ? "yolo" : "always_ask" }));
    } finally {
      setSaving(false);
    }
  }

  if (loading || !product) return <div className="text-center py-12 text-gray-400">Loading…</div>;
  const isAutonomous = policy?.approval_mode === "yolo";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-900">Naelao Space Assistant</h3>
            <p className="mt-1 text-sm text-gray-600">Plans and coordinates work through configurable Naelao workers.</p>
          </div>
          <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">Naelao runtime</span>
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-4">
          <div>
            <div className="text-sm font-medium text-gray-700">Approval policy</div>
            <p className="mt-0.5 text-xs text-gray-500">
              {isAutonomous ? "Autonomous — the assistant can act without asking first." : "Guided — the assistant asks before consequential actions."}
            </p>
          </div>
          {!policyLoading && (
            <div className="flex gap-2">
              <button type="button" onClick={() => void setAutonomy(false)} disabled={saving || !isAutonomous} className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${!isAutonomous ? "border-brand-500 bg-brand-50 text-brand-800" : "border-gray-200 text-gray-600 hover:border-gray-300"}`}>Guided</button>
              <button type="button" onClick={() => void setAutonomy(true)} disabled={saving || isAutonomous} className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${isAutonomous ? "border-brand-500 bg-brand-50 text-brand-800" : "border-gray-200 text-gray-600 hover:border-gray-300"}`}>Autonomous</button>
            </div>
          )}
        </div>
      </div>
      <p className="text-sm text-gray-500">Create or configure workers from the workspace. Choose their task instructions, tools, skills, knowledge sources, model, and permissions there.</p>
    </div>
  );
}
