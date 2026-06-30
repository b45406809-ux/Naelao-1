"use client";

import { useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { listSpaces, listSpaceTypes, createSpace } from "@/lib/api";
import type { Space, SpaceType } from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  paused: "bg-yellow-100 text-yellow-700",
  suspended: "bg-red-100 text-red-700",
  deleted: "bg-gray-100 text-gray-500",
};

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "bg-gray-100 text-gray-500";
  return (
    <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium capitalize ${color}`}>
      {status}
    </span>
  );
}

function CreateSpaceModal({
  spaceTypes,
  onClose,
  onCreated,
}: {
  spaceTypes: SpaceType[];
  onClose: () => void;
  onCreated: (space: Space) => void;
}) {
  const [name, setName] = useState("");
  const [spaceTypeId, setSpaceTypeId] = useState(spaceTypes[0]?.id ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (!spaceTypeId) {
      setError("Please select a SpaceType");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const space = await createSpace({ name: name.trim(), spacetype_id: spaceTypeId });
      onCreated(space);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create Space");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        role="presentation"
      />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-5">New Space</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Space Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g. My Support Space"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              SpaceType <span className="text-red-500">*</span>
            </label>
            {spaceTypes.length === 0 ? (
              <p className="text-sm text-red-600">
                No SpaceTypes available.{" "}
                <Link
                  href="/dashboard/spacetypes/new"
                  className="underline"
                  onClick={onClose}
                >
                  Create one first
                </Link>
                .
              </p>
            ) : (
              <select
                value={spaceTypeId}
                onChange={(e) => setSpaceTypeId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm bg-white"
              >
                {spaceTypes.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || spaceTypes.length === 0}
              className="flex-1 px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {loading ? "Creating..." : "Create Space"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function SpacesPage() {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spaceTypes, setSpaceTypes] = useState<SpaceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  // SpaceType name lookup
  const spaceTypeMap = Object.fromEntries(
    spaceTypes.map((st) => [st.id, st.name])
  );

  async function load() {
    setLoading(true);
    setError(null);
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

  useEffect(() => {
    void load();
  }, []);

  function handleCreated(space: Space) {
    setSpaces((prev) => [space, ...prev]);
    setShowModal(false);
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Spaces</h1>
          <p className="text-gray-500 mt-1">
            Deployed instances of your SpaceTypes
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
        >
          + New Space
        </button>
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

      {!loading && !error && spaces.length === 0 && (
        <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-500 mb-4">No Spaces yet.</p>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
          >
            Create your first Space
          </button>
        </div>
      )}

      {!loading && !error && spaces.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-6 py-3 font-semibold text-gray-600">
                  Name
                </th>
                <th className="text-left px-6 py-3 font-semibold text-gray-600">
                  SpaceType
                </th>
                <th className="text-left px-6 py-3 font-semibold text-gray-600">
                  Status
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
              {spaces.map((space) => (
                <tr
                  key={space.id}
                  className="hover:bg-gray-50 transition-colors"
                >
                  <td className="px-6 py-4 font-medium text-gray-900">
                    {space.name}
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    {spaceTypeMap[space.spacetype_id] ?? space.spacetype_id}
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={space.status} />
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    {new Date(space.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="inline-flex items-center gap-3">
                      <Link
                        href={`/dashboard/spaces/${space.id}/commerce`}
                        className="text-brand-600 hover:underline text-xs font-medium"
                      >
                        Commerce
                      </Link>
                      <Link
                        href={`/dashboard/spaces/${space.id}/kb`}
                        className="text-brand-600 hover:underline text-xs font-medium"
                      >
                        Manage KB
                      </Link>
                      <Link
                        href={`/dashboard/spaces/${space.id}/settings`}
                        className="text-gray-500 hover:text-gray-700 text-xs"
                      >
                        Settings
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <CreateSpaceModal
          spaceTypes={spaceTypes}
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
