"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

interface UsageData {
  period_start: string;
  period_end: string;
  sessions: number;
  messages: number;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number;
  stripe_meter_usage?: number;
}

interface UsageLimits {
  tier: string;
  monthly_sessions: number;
  monthly_tokens: number;
  spaces: number;
  spaces_used: number;
  seats: number;
  seats_used: number;
}

export default function UsagePage() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [limits, setLimits] = useState<UsageLimits | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [u, l] = await Promise.all([
          apiFetch<{ data: UsageData }>("/v1/usage/current"),
          apiFetch<{ data: UsageLimits }>("/v1/usage/limits"),
        ]);
        setUsage(u.data);
        setLimits(l.data);
      } catch { /* ignore */ } finally { setLoading(false); }
    }
    void load();
  }, []);

  function pct(used: number, limit: number): number {
    return Math.min(100, Math.round((used / limit) * 100));
  }

  function Bar({ value, max, warn = 80 }: { value: number; max: number; warn?: number }) {
    const p = pct(value, max);
    return (
      <div className="mt-1 bg-gray-100 rounded-full h-2 overflow-hidden">
        <div className={`h-2 rounded-full transition-all ${p >= warn ? "bg-red-500" : "bg-brand-500"}`} style={{ width: `${p}%` }} />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Usage & Analytics</h1>
        <p className="text-gray-500 mt-1">Current billing period usage</p>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : (
        <div className="space-y-6">
          {/* Plan overview */}
          {limits && (
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-gray-900">Plan: {limits.tier.charAt(0).toUpperCase() + limits.tier.slice(1)}</h2>
                <a href="/dashboard/settings/billing" className="text-sm text-brand-600 hover:underline">Upgrade</a>
              </div>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Spaces</span>
                    <span className="font-medium">{limits.spaces_used} / {limits.spaces}</span>
                  </div>
                  <Bar value={limits.spaces_used} max={limits.spaces} />
                </div>
                <div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Seats</span>
                    <span className="font-medium">{limits.seats_used} / {limits.seats}</span>
                  </div>
                  <Bar value={limits.seats_used} max={limits.seats} />
                </div>
              </div>
            </div>
          )}

          {/* Current period usage */}
          {usage && (
            <>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h2 className="font-semibold text-gray-900 mb-1">Current Period</h2>
                <p className="text-xs text-gray-400 mb-4">
                  {new Date(usage.period_start).toLocaleDateString()} — {new Date(usage.period_end).toLocaleDateString()}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { label: "Sessions", value: usage.sessions.toLocaleString() },
                    { label: "Messages", value: usage.messages.toLocaleString() },
                    { label: "Input Tokens", value: usage.tokens_input.toLocaleString() },
                    { label: "Output Tokens", value: usage.tokens_output.toLocaleString() },
                  ].map((s) => (
                    <div key={s.label} className="bg-gray-50 rounded-lg p-4">
                      <p className="text-xs text-gray-500 font-medium">{s.label}</p>
                      <p className="text-2xl font-bold text-gray-900 mt-1">{s.value}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h2 className="font-semibold text-gray-900 mb-4">Cost Estimate</h2>
                <div className="flex items-end gap-2">
                  <p className="text-4xl font-bold text-gray-900">${usage.cost_usd.toFixed(4)}</p>
                  <p className="text-gray-500 mb-1 text-sm">this period</p>
                </div>
                {usage.stripe_meter_usage !== undefined && (
                  <p className="text-xs text-gray-400 mt-2">Stripe meter: {usage.stripe_meter_usage.toLocaleString()} units</p>
                )}
              </div>

              {limits && (
                <div className="bg-white rounded-xl border border-gray-200 p-6">
                  <h2 className="font-semibold text-gray-900 mb-4">Monthly Quota</h2>
                  <div className="space-y-4">
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-600">Sessions</span>
                        <span className="font-medium">{usage.sessions.toLocaleString()} / {limits.monthly_sessions.toLocaleString()}</span>
                      </div>
                      <Bar value={usage.sessions} max={limits.monthly_sessions} />
                    </div>
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-600">Total Tokens</span>
                        <span className="font-medium">{(usage.tokens_input + usage.tokens_output).toLocaleString()} / {limits.monthly_tokens.toLocaleString()}</span>
                      </div>
                      <Bar value={usage.tokens_input + usage.tokens_output} max={limits.monthly_tokens} />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
