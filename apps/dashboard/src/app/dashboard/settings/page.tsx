"use client";

import { useEffect, useState, FormEvent } from "react";
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  getBillingSubscription,
  createBillingCheckout,
} from "@/lib/api";
import type { ApiKey } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// G-BE40: Settings — subscription info, API keys, org info

const PLAN_TIERS = [
  {
    id: "growth",
    name: "Growth",
    price: "$49/mo",
    description: "More Spaces, more documents, priority support",
  },
  {
    id: "business",
    name: "Business",
    price: "$199/mo",
    description: "Unlimited Spaces, advanced analytics, SLA",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Custom",
    description: "Dedicated infrastructure, custom contracts",
  },
];

const PLAN_BADGE: Record<string, string> = {
  free: "bg-gray-100 text-gray-600",
  growth: "bg-blue-100 text-blue-700",
  business: "bg-purple-100 text-purple-700",
  enterprise: "bg-yellow-100 text-yellow-700",
};

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-200">
        <h2 className="font-semibold text-gray-900">{title}</h2>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const { claims } = useAuth();

  // Billing state
  const [subscription, setSubscription] = useState<{
    plan_tier: string;
    status: string;
    current_period_end: string;
  } | null>(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

  // API keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    async function loadBilling() {
      try {
        const sub = await getBillingSubscription();
        setSubscription(sub);
      } catch {
        setBillingError("Could not load subscription info");
      } finally {
        setBillingLoading(false);
      }
    }
    async function loadKeys() {
      try {
        const keys = await listApiKeys();
        setApiKeys(keys);
      } catch {
        setKeysError("Could not load API keys");
      } finally {
        setKeysLoading(false);
      }
    }
    void Promise.all([loadBilling(), loadKeys()]);
  }, []);

  async function handleUpgrade(planId: string) {
    setCheckoutLoading(planId);
    try {
      const { url } = await createBillingCheckout(planId);
      window.location.href = url;
    } catch (err) {
      setBillingError(
        err instanceof Error ? err.message : "Failed to start checkout"
      );
    } finally {
      setCheckoutLoading(null);
    }
  }

  async function handleCreateKey(e: FormEvent) {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    setCreatingKey(true);
    setNewKeyValue(null);
    try {
      const result = await createApiKey(newKeyName.trim());
      setNewKeyValue(result.key);
      setApiKeys((prev) => [result, ...prev]);
      setNewKeyName("");
    } catch (err) {
      setKeysError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setCreatingKey(false);
    }
  }

  async function handleRevokeKey(id: string) {
    if (!confirm("Revoke this API key? Any apps using it will stop working."))
      return;
    setRevokingId(id);
    try {
      await revokeApiKey(id);
      setApiKeys((prev) => prev.filter((k) => k.id !== id));
    } catch (err) {
      setKeysError(err instanceof Error ? err.message : "Failed to revoke key");
    } finally {
      setRevokingId(null);
    }
  }

  const planTier = subscription?.plan_tier ?? "free";
  const planBadge = PLAN_BADGE[planTier] ?? PLAN_BADGE["free"]!;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-500 mt-1">
          Manage your subscription, API keys, and organization
        </p>
      </div>

      {/* Org Info */}
      <SectionCard title="Organization">
        <div className="space-y-3">
          <div>
            <p className="text-sm text-gray-500">Organization ID</p>
            <p className="font-medium text-gray-900 mt-0.5">
              {claims?.tid ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Account Email</p>
            <p className="font-medium text-gray-900 mt-0.5">
              {claims?.email ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Role</p>
            <p className="font-medium text-gray-900 capitalize mt-0.5">
              {claims?.role ?? "—"}
            </p>
          </div>
        </div>
      </SectionCard>

      {/* Subscription */}
      <SectionCard title="Subscription">
        {billingLoading ? (
          <div className="text-sm text-gray-400">Loading...</div>
        ) : billingError ? (
          <p className="text-sm text-red-600">{billingError}</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <span
                className={`px-3 py-1 rounded-full text-sm font-semibold capitalize ${planBadge}`}
              >
                {planTier} Plan
              </span>
              {subscription?.status && (
                <span className="text-sm text-gray-500">
                  Status: {subscription.status}
                </span>
              )}
              {subscription?.current_period_end && (
                <span className="text-sm text-gray-500">
                  Renews:{" "}
                  {new Date(subscription.current_period_end).toLocaleDateString()}
                </span>
              )}
            </div>

            {planTier !== "enterprise" && (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-3">
                  Upgrade your plan
                </p>
                <div className="grid gap-3">
                  {PLAN_TIERS.filter((p) => p.id !== planTier).map((plan) => (
                    <div
                      key={plan.id}
                      className="flex items-center justify-between p-4 rounded-lg border border-gray-200 hover:border-brand-200 hover:bg-brand-50 transition-colors"
                    >
                      <div>
                        <p className="font-semibold text-gray-900">
                          {plan.name}{" "}
                          <span className="text-brand-600">{plan.price}</span>
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {plan.description}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleUpgrade(plan.id)}
                        disabled={checkoutLoading === plan.id}
                        className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap"
                      >
                        {checkoutLoading === plan.id ? "Loading..." : "Upgrade"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {/* API Keys */}
      <SectionCard title="API Keys">
        {keysError && (
          <p className="text-sm text-red-600 mb-4">{keysError}</p>
        )}

        {/* Create new key */}
        <form onSubmit={handleCreateKey} className="flex gap-3 mb-5">
          <input
            type="text"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Key name (e.g. production)"
            required
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
          />
          <button
            type="submit"
            disabled={creatingKey || !newKeyName.trim()}
            className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap"
          >
            {creatingKey ? "Creating..." : "Create Key"}
          </button>
        </form>

        {/* Show newly created key once */}
        {newKeyValue && (
          <div className="mb-5 p-4 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-sm font-semibold text-green-800 mb-1">
              New API key — copy now, it won't be shown again
            </p>
            <code className="text-xs bg-white border border-green-300 rounded px-2 py-1 block break-all">
              {newKeyValue}
            </code>
          </div>
        )}

        {keysLoading ? (
          <div className="text-sm text-gray-400">Loading keys...</div>
        ) : apiKeys.length === 0 ? (
          <p className="text-sm text-gray-400">
            No API keys yet. Create one above.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {apiKeys.map((key) => (
              <li
                key={key.id}
                className="py-3 flex items-center justify-between"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {key.name}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {key.key_prefix}•••••••{" "}
                    &middot;{" "}
                    Created{" "}
                    {new Date(key.created_at).toLocaleDateString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevokeKey(key.id)}
                  disabled={revokingId === key.id}
                  className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50 transition-colors"
                >
                  {revokingId === key.id ? "Revoking..." : "Revoke"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
