"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "editor" | "viewer";
  status: "active" | "invited" | "suspended";
  created_at: string;
}

const ROLES = ["admin", "editor", "viewer"] as const;

export default function TeamPage() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", role: "editor" as string });
  const [inviting, setInviting] = useState(false);

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<{ data: TeamMember[] }>("/v1/team/members");
      setMembers(data.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }

  async function invite() {
    if (!inviteForm.email) return;
    setInviting(true);
    try {
      await apiFetch("/v1/team/invitations", {
        method: "POST",
        body: JSON.stringify({ email: inviteForm.email, role: inviteForm.role }),
      });
      setShowInvite(false);
      setInviteForm({ email: "", role: "editor" });
      await load();
    } catch { /* ignore */ } finally { setInviting(false); }
  }

  async function updateRole(memberId: string, role: string) {
    try {
      await apiFetch(`/v1/team/members/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      setMembers((prev) => prev.map((m) => m.id === memberId ? { ...m, role: role as TeamMember["role"] } : m));
    } catch { /* ignore */ }
  }

  async function removeMember(memberId: string) {
    if (!confirm("Remove this team member?")) return;
    try {
      await apiFetch(`/v1/team/members/${memberId}`, { method: "DELETE" });
      setMembers((prev) => prev.filter((m) => m.id !== memberId));
    } catch { /* ignore */ }
  }

  const ROLE_COLORS: Record<string, string> = {
    owner: "bg-purple-100 text-purple-700",
    admin: "bg-blue-100 text-blue-700",
    editor: "bg-green-100 text-green-700",
    viewer: "bg-gray-100 text-gray-600",
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Team</h1>
          <p className="text-gray-500 mt-1">Manage team members and their access levels</p>
        </div>
        <button onClick={() => setShowInvite(true)} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700">
          + Invite Member
        </button>
      </div>

      {showInvite && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">Invite Team Member</h2>
          <div className="flex gap-3">
            <input type="email" value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
              placeholder="colleague@company.com"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            <select value={inviteForm.role} onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
              {ROLES.map((r) => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
            </select>
            <button onClick={() => void invite()} disabled={inviting}
              className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50">
              {inviting ? "Sending…" : "Send Invite"}
            </button>
            <button onClick={() => setShowInvite(false)} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50">
              Cancel
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-3">An invitation email will be sent with a magic link. Links expire in 7 days.</p>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Member</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Role</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Status</th>
                <th className="px-4 py-3 text-left text-gray-500 font-medium">Joined</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {members.map((m) => (
                <tr key={m.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{m.name || m.email}</p>
                    {m.name && <p className="text-xs text-gray-400">{m.email}</p>}
                  </td>
                  <td className="px-4 py-3">
                    {m.role === "owner" ? (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ROLE_COLORS["owner"]}`}>Owner</span>
                    ) : (
                      <select value={m.role} onChange={(e) => void updateRole(m.id, e.target.value)}
                        className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500">
                        {ROLES.map((r) => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${m.status === "active" ? "bg-green-100 text-green-700" : m.status === "invited" ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-500"}`}>
                      {m.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{new Date(m.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    {m.role !== "owner" && (
                      <button onClick={() => void removeMember(m.id)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
                    )}
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
