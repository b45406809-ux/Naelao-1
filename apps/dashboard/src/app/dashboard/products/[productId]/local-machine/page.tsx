"use client";


import { useEffect, useState } from "react";
import { useProduct } from "../productContext";
import {
  listLocalGrants,
  createLocalGrant,
  deleteLocalGrant,
  mintLocalTunnelConnectToken,
  type LocalGrant,
} from "@/lib/api";

// §A1.17 Phase S: local-machine-as-container (Phase M) shipped the full grant/tunnel mechanism
// with zero frontend anywhere — this is that missing UI. Grants are explicit and revocable: no
// default access, and the backend always derives WHICH machine a grant/connection targets from
// the caller's own verified identity, never a field this form could spoof.

const GRANT_TYPES = ["read", "write", "readwrite", "exec"] as const;

export default function LocalMachinePage() {
  const { product, loading } = useProduct();
  const [grants, setGrants] = useState<LocalGrant[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [grantType, setGrantType] = useState<(typeof GRANT_TYPES)[number]>("read");
  const [directory, setDirectory] = useState("");
  const [commands, setCommands] = useState("");
  const [creating, setCreating] = useState(false);

  const [connectInfo, setConnectInfo] = useState<{ token: string; connect_path: string; expires_in_seconds: number } | null>(null);
  const [connecting, setConnecting] = useState(false);

  async function refresh(spaceId: string) {
    setGrantsLoading(true);
    try {
      setGrants(await listLocalGrants(spaceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load grants");
    } finally {
      setGrantsLoading(false);
    }
  }

  useEffect(() => {
    if (product) void refresh(product.id);
  }, [product]);

  async function handleCreate() {
    if (!product) return;
    setError(null);
    setCreating(true);
    try {
      if (grantType === "exec") {
        const list = commands.split("\n").map((c) => c.trim()).filter(Boolean);
        if (list.length === 0) throw new Error("Enter at least one exact command");
        await createLocalGrant(product.id, { grant_type: "exec", commands: list });
      } else {
        if (!directory.trim()) throw new Error("Enter a directory");
        await createLocalGrant(product.id, { grant_type: grantType, directory: directory.trim() });
      }
      setDirectory("");
      setCommands("");
      await refresh(product.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create grant");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(grantId: string) {
    if (!product) return;
    await deleteLocalGrant(product.id, grantId);
    await refresh(product.id);
  }

  async function handleConnect() {
    if (!product) return;
    setConnecting(true);
    setError(null);
    try {
      const info = await mintLocalTunnelConnectToken(product.id);
      setConnectInfo(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mint a connect token");
    } finally {
      setConnecting(false);
    }
  }

  if (loading || !product) return <div className="text-center py-12 text-gray-400">Loading…</div>;

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">{error}</div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="font-semibold text-gray-900">My Local Machine</h3>
        <p className="text-sm text-gray-600 mt-1">
          Let this product's agents read/write files or run exact commands on YOUR OWN machine,
          over a direct connection from the Naelao Local Agent. No access is granted by default —
          each grant below is explicit and can be revoked at any time.
        </p>

        <div className="mt-4 pt-4 border-t border-gray-100">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-700">Connection</div>
              <p className="text-xs text-gray-500 mt-0.5">
                Mint a short-lived connect token, then run the Naelao Local Agent on your machine
                with it to open the tunnel.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleConnect()}
              disabled={connecting}
              className="px-3 py-1.5 text-sm font-medium rounded-lg border border-brand-500 bg-brand-50 text-brand-800 hover:bg-brand-100 transition-colors disabled:opacity-50"
            >
              {connecting ? "Minting…" : "Connect"}
            </button>
          </div>
          {connectInfo && (
            <div className="mt-3 bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs font-mono text-gray-700 overflow-x-auto">
              <div className="mb-2 text-gray-500 font-sans">
                Expires in {connectInfo.expires_in_seconds}s — run this on your machine now:
              </div>
              node naelao-local-agent.mjs --token {connectInfo.token} --path {connectInfo.connect_path}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="font-semibold text-gray-900">Add a grant</h3>
        <div className="mt-3 flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
            <select
              value={grantType}
              onChange={(e) => setGrantType(e.target.value as (typeof GRANT_TYPES)[number])}
              className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm"
            >
              {GRANT_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          {grantType === "exec" ? (
            <div className="flex-1 min-w-[240px]">
              <label className="block text-xs font-medium text-gray-600 mb-1">Exact commands (one per line)</label>
              <textarea
                value={commands}
                onChange={(e) => setCommands(e.target.value)}
                rows={2}
                placeholder={"npm test\ngit status"}
                className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm font-mono"
              />
            </div>
          ) : (
            <div className="flex-1 min-w-[240px]">
              <label className="block text-xs font-medium text-gray-600 mb-1">Directory</label>
              <input
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder="/Users/you/projects/my-repo"
                className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm font-mono"
              />
            </div>
          )}
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50"
          >
            {creating ? "Adding…" : "Add grant"}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200">
        <div className="p-5 pb-0">
          <h3 className="font-semibold text-gray-900">Active grants</h3>
        </div>
        {grantsLoading ? (
          <div className="p-5 text-sm text-gray-400">Loading…</div>
        ) : grants.length === 0 ? (
          <div className="p-5 text-sm text-gray-500">No grants yet — your machine is not reachable by any agent.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {grants.map((g) => (
              <li key={g.id} className="p-5 flex items-center justify-between">
                <div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-medium mr-2 uppercase">{g.grant_type}</span>
                  <span className="text-sm font-mono text-gray-700">
                    {g.grant_type === "exec" ? JSON.parse(g.commands_json ?? "[]").join(", ") : g.directory}
                  </span>
                  <div className="text-xs text-gray-400 mt-0.5">Added {new Date(g.created_at).toLocaleString()}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(g.id)}
                  className="text-sm text-red-600 hover:text-red-800 font-medium"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
