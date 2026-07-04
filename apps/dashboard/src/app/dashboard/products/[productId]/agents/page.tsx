"use client";

import { useProduct } from "../productContext";

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

  if (loading || !product) return <div className="text-center py-12 text-gray-400">Loading…</div>;

  return (
    <div className="space-y-4">
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
