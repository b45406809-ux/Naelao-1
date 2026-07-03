"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  listBuilderProductUsers,
  suspendBuilderProductUser,
  removeBuilderProductUser,
} from "@/lib/api";
import type { BuilderProductEndUser } from "@/lib/api";

export default function ProductUsersPage() {
  const params = useParams<{ productId: string }>();
  const [users, setUsers] = useState<BuilderProductEndUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setUsers(await listBuilderProductUsers(params.productId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.productId]);

  async function handleSuspend(userId: string) {
    setBusyId(userId);
    try {
      await suspendBuilderProductUser(params.productId, userId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(userId: string) {
    if (!confirm("Remove this user's access to the product? This cannot be undone.")) return;
    setBusyId(userId);
    try {
      await removeBuilderProductUser(params.productId, userId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="mb-4">
        <p className="text-sm text-gray-500">
          People who have signed in to this product as end users. Team collaborators (owners,
          admins, members of your own account) are managed separately, not shown here.
        </p>
      </div>

      {loading && <div className="text-center py-12 text-gray-400">Loading…</div>}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-6">
          {error}
        </div>
      )}

      {!loading && !error && users.length === 0 && (
        <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-500 text-sm">No end users yet.</p>
          <p className="text-gray-400 text-xs mt-1">
            Users appear here once someone signs in through your product.
          </p>
        </div>
      )}

      {!loading && !error && users.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-6 py-3 font-semibold text-gray-600">User</th>
                <th className="text-left px-6 py-3 font-semibold text-gray-600">First seen</th>
                <th className="text-left px-6 py-3 font-semibold text-gray-600">Last seen</th>
                <th className="text-left px-6 py-3 font-semibold text-gray-600">Status</th>
                <th className="text-right px-6 py-3 font-semibold text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.end_user_id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4">
                    <p className="font-medium text-gray-900">{u.display_name ?? u.email ?? u.end_user_id.slice(0, 12)}</p>
                    {u.email && <p className="text-xs text-gray-400">{u.email}</p>}
                  </td>
                  <td className="px-6 py-4 text-gray-500">{new Date(u.first_seen_at).toLocaleDateString()}</td>
                  <td className="px-6 py-4 text-gray-500">{u.last_seen_at ? new Date(u.last_seen_at).toLocaleDateString() : "Never"}</td>
                  <td className="px-6 py-4">
                    <span
                      className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${
                        u.suspended_at ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"
                      }`}
                    >
                      {u.suspended_at ? "Suspended" : "Active"}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="inline-flex items-center gap-3">
                      {!u.suspended_at && (
                        <button
                          type="button"
                          onClick={() => void handleSuspend(u.end_user_id)}
                          disabled={busyId === u.end_user_id}
                          className="text-yellow-600 hover:underline text-xs font-medium disabled:opacity-50"
                        >
                          Suspend
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleRemove(u.end_user_id)}
                        disabled={busyId === u.end_user_id}
                        className="text-red-500 hover:underline text-xs font-medium disabled:opacity-50"
                      >
                        Remove
                      </button>
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
