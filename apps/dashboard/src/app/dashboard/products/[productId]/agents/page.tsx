"use client";


import { useEffect, useState } from "react";
import { useProduct } from "../productContext";
import { getAssistantPolicy, updateAssistantPolicy } from "@/lib/api";
import type { AssistantPolicy } from "@/lib/api";

// Read-only view of the SpaceType's core agents (Phase D, §A1.17 plan). Hardcoded to match
// workers/agents/src/launchpad/spacetype.ts's LAUNCHPAD_CORE_AGENTS — same simplification
// precedent as the Configuration tab's template catalogue: no builder-reachable read route for
// this exists yet, and per-product enable/disable would require threading a new productConfig
// field through the provisioner's agent-install step (workers/provisioner/src/index.ts), which
// this pass deliberately does not do — flagged here as a real follow-up, not silently dropped.
const CORE_AGENTS = [
  {
    id: "launchpad-fulfillment-v1",
    name: "Fulfillment Agent",
    description: "Handles order processing, product delivery, and customer receipts automatically.",
    trigger: "Webhook: order.completed",
    requiresApprovalFor: ["customer_email_send", "refund_issue"],
  },
  {
    id: "launchpad-support-v1",
    name: "Support Assistant",
    description: "Answers customer questions and escalates issues that need a human.",
    trigger: "Webhook: message.received",
    requiresApprovalFor: ["refund_issue", "policy_exception"],
  },
  {
    id: "launchpad-content-v1",
    name: "Content & Marketing Agent",
    description: "Drafts and schedules marketing content on a daily cadence.",
    trigger: "Schedule: 9:00 AM daily",
    requiresApprovalFor: ["content_publish", "broadcast_send"],
  },
];

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
      const next = await updateAssistantPolicy(product.id, { approval_mode: autonomous ? "yolo" : "always_ask" });
      setPolicy(next);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !product) return <div className="text-center py-12 text-gray-400">Loading…</div>;

  const isAutonomous = policy?.approval_mode === "yolo";

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-900">Naelao Agent — Space Assistant</h3>
            <p className="text-sm text-gray-600 mt-1">
              Helps the owner design, launch, and run the business — proposes ideas, scaffolds
              projects, and reports back on what's working.
            </p>
          </div>
          <span className="text-xs px-2.5 py-0.5 rounded-full font-medium bg-brand-50 text-brand-700">
            Continuous
          </span>
        </div>
        <div className="mt-4 pt-4 border-t border-gray-100">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-700">Autonomy</div>
              <p className="text-xs text-gray-500 mt-0.5">
                {isAutonomous
                  ? "Autonomous — the assistant acts without asking first."
                  : "Guided (default) — the assistant asks before scaffolding a project or spending anything; it can still look around freely."}
              </p>
            </div>
            {!policyLoading && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void setAutonomy(false)}
                  disabled={saving || !isAutonomous}
                  className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                    !isAutonomous ? "border-brand-500 bg-brand-50 text-brand-800" : "border-gray-200 text-gray-600 hover:border-gray-300"
                  }`}
                >
                  Guided
                </button>
                <button
                  type="button"
                  onClick={() => void setAutonomy(true)}
                  disabled={saving || isAutonomous}
                  className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                    isAutonomous ? "border-brand-500 bg-brand-50 text-brand-800" : "border-gray-200 text-gray-600 hover:border-gray-300"
                  }`}
                >
                  Autonomous
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <p className="text-sm text-gray-500">
        The core agents every Launchpad business is provisioned with. Per-agent enable/disable is
        not yet configurable from here — contact support if you need to remove one for this
        product.
      </p>
      {CORE_AGENTS.map((agent) => (
        <div key={agent.id} className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-900">{agent.name}</h3>
            <span className="text-xs px-2.5 py-0.5 rounded-full font-medium bg-brand-50 text-brand-700">
              {agent.trigger}
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-2">{agent.description}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {agent.requiresApprovalFor.map((action) => (
              <span key={action} className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                requires approval: {action}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
