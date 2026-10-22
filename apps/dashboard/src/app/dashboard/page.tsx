"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listSpaces, listSpaceTypes } from "@/lib/api";
import type { Space, SpaceType } from "@/lib/api";
import { useAuth } from "@/lib/auth-provider";

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className="text-3xl font-bold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  paused: "bg-yellow-100 text-yellow-700",
  suspended: "bg-red-100 text-red-700",
  deleted: "bg-gray-100 text-gray-500",
};

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "bg-gray-100 text-gray-500";
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${color}`}>
      {status}
    </span>
  );
}

export default function DashboardPage() {
  const { claims, planTier } = useAuth();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spaceTypes, setSpaceTypes] = useState<SpaceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [s, st] = await Promise.all([listSpaces(), listSpaceTypes()]);
        setSpaces(s);
        setSpaceTypes(st);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const recentSpaces = spaces.slice(0, 5);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Overview</h1>
        <p className="text-gray-500 mt-1">
          Welcome back, {claims?.email ?? "builder"}
        </p>
      </div>

      {loading && (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-6">
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            <StatCard label="Total Spaces" value={spaces.length} />
            <StatCard label="SpaceTypes" value={spaceTypes.length} />
            <StatCard
              label="Current Plan"
              value={planTier ? planTier.charAt(0).toUpperCase() + planTier.slice(1) : "Checking…"}
              sub="Upgrade anytime in Settings"
            />
          </div>

          {/* Quick actions */}
          <div className="flex gap-3 mb-8">
            <Link
              href="/dashboard/products/new"
              className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
            >
              + New Space
            </Link>
          </div>

          {/* Recent spaces */}
          <div className="bg-white rounded-xl border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Recent Spaces</h2>
              <Link
                href="/dashboard/products"
                className="text-sm text-brand-600 hover:underline"
              >
                View all
              </Link>
            </div>

            {recentSpaces.length === 0 ? (
              <div className="px-6 py-10 text-center text-gray-400">
                <p className="text-sm">No spaces yet.</p>
                <Link
                  href="/dashboard/products"
                  className="text-brand-600 text-sm hover:underline mt-1 inline-block"
                >
                  Create your first Space
                </Link>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {recentSpaces.map((space) => (
                  <li
                    key={space.id}
                    className="px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
                  >
                    <div>
                      <p className="font-medium text-gray-900">{space.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {new Date(space.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={space.status} />
                      <Link
                        href={`/dashboard/spaces/${space.id}/kb`}
                        className="text-xs text-brand-600 hover:underline"
                      >
                        Manage KB
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
