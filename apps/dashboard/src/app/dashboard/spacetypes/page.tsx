"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listSpaceTypes } from "@/lib/api";
import type { SpaceType } from "@/lib/api";

const STATUS_CONFIG: Record<
  string,
  { label: string; className: string }
> = {
  draft: { label: "Draft", className: "bg-gray-100 text-gray-600" },
  published: { label: "Published", className: "bg-green-100 text-green-700" },
  deprecated: {
    label: "Deprecated",
    className: "bg-yellow-100 text-yellow-700",
  },
};

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    className: "bg-gray-100 text-gray-600",
  };
  return (
    <span
      className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}

export default function SpaceTypesPage() {
  const [spaceTypes, setSpaceTypes] = useState<SpaceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await listSpaceTypes();
      setSpaceTypes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load SpaceTypes");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">SpaceTypes</h1>
          <p className="text-gray-500 mt-1">
            Blueprints that define what a Space is and how it behaves
          </p>
        </div>
        <Link
          href="/dashboard/spacetypes/new"
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
        >
          + New SpaceType
        </Link>
      </div>

      {loading && (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-6">
          {error}
          <button
            type="button"
            onClick={() => void load()}
            className="ml-3 text-sm underline"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && spaceTypes.length === 0 && (
        <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-500 mb-4">No SpaceTypes yet.</p>
          <Link
            href="/dashboard/spacetypes/new"
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
          >
            Create your first SpaceType
          </Link>
        </div>
      )}

      {!loading && !error && spaceTypes.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-6 py-3 font-semibold text-gray-600">
                  Name
                </th>
                <th className="text-left px-6 py-3 font-semibold text-gray-600">
                  Status
                </th>
                <th className="text-left px-6 py-3 font-semibold text-gray-600">
                  Version
                </th>
                <th className="text-left px-6 py-3 font-semibold text-gray-600">
                  Created
                </th>
                <th className="text-right px-6 py-3 font-semibold text-gray-600">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {spaceTypes.map((st) => (
                <tr key={st.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4">
                    <p className="font-medium text-gray-900">{st.name}</p>
                    {st.description && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate max-w-xs">
                        {st.description}
                      </p>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={st.status} />
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    v{st.version ?? "1"}
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    {new Date(st.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="inline-flex items-center gap-3">
                      <Link
                        href={`/dashboard/spacetypes/${st.id}/edit`}
                        className="text-brand-600 hover:underline text-xs font-medium"
                      >
                        Edit
                      </Link>
                      <Link
                        href={`/dashboard/spacetypes/${st.id}`}
                        className="text-gray-500 hover:text-gray-700 text-xs"
                      >
                        View
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
