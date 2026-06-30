"use client";

// Connectors console — the external-platform connector layer ("Whop first, everything else
// coming soon"). Reads the Naelao-authored connector catalogue and lets a builder connect a
// platform by storing its API key (encrypted vault) + registering it as an MCP server. The
// agent then reaches it through mcp-connector — no per-platform code. Coming-soon connectors
// render greyed out. Money-in stays on Naelao's reserved commerce path (these are read-mostly).

import { useEffect, useState, FormEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getConnectorStatus, connectPlatform } from "@/lib/api";
import type { Connector } from "@/lib/api";

const CATEGORY_LABEL: Record<string, string> = {
  course_product: "Courses & Products",
  newsletter: "Newsletter",
  community: "Community",
  booking: "Booking",
  marketplace: "Marketplace",
  freelance: "Freelance",
  social: "Social",
};

function ConnectForm({ connector, spaceId, onDone }: { connector: Connector; spaceId: string; onDone: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await connectPlatform(connector.id, spaceId, apiKey);
      setApiKey("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex gap-2">
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={`${connector.name} API key`}
        className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
        required
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Connecting…" : "Connect"}
      </button>
      {error && <span className="self-center text-xs text-red-600">{error}</span>}
    </form>
  );
}

function ConnectorCard({ connector, spaceId, onChange }: { connector: Connector; spaceId: string; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const comingSoon = connector.status === "coming_soon";

  return (
    <div className={`rounded-xl border p-4 ${comingSoon ? "border-gray-200 bg-gray-50 opacity-70" : "border-gray-200 bg-white"}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900">{connector.name}</h3>
            {connector.connected && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Connected</span>
            )}
            {comingSoon && (
              <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-500">Coming soon</span>
            )}
          </div>
          <p className="mt-0.5 text-xs uppercase tracking-wide text-gray-400">{CATEGORY_LABEL[connector.category] ?? connector.category}</p>
        </div>
        {!comingSoon && !connector.connected && (
          <button onClick={() => setOpen((v) => !v)} className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-1 text-sm font-medium text-brand-700">
            {open ? "Cancel" : "Connect"}
          </button>
        )}
      </div>

      <p className="mt-2 text-sm text-gray-600">{connector.summary}</p>

      {connector.operations && connector.operations.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {connector.operations.slice(0, 6).map((op) => (
            <span key={op.name} className="rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-600" title={op.description}>
              {op.name}
            </span>
          ))}
        </div>
      )}

      {!comingSoon && open && !connector.connected && (
        <ConnectForm connector={connector} spaceId={spaceId} onDone={() => { setOpen(false); onChange(); }} />
      )}
    </div>
  );
}

export default function ConnectorsPage() {
  const params = useParams();
  const spaceId = params["spaceId"] as string;
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setConnectors(await getConnectorStatus(spaceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load connectors");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [spaceId]);

  const available = connectors.filter((c) => c.status === "available");
  const comingSoon = connectors.filter((c) => c.status === "coming_soon");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Connectors</h1>
        <Link href={`/dashboard/spaces/${spaceId}`} className="text-sm text-brand-600">← Back to space</Link>
      </div>
      <p className="mb-6 text-sm text-gray-500">
        Connect an external platform so your agents can run it on autopilot. The platform keeps
        processing payments — you&apos;re billed for the automation, not a cut of the sale.
      </p>

      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {!loading && (
        <>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-400">Available</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {available.map((c) => <ConnectorCard key={c.id} connector={c} spaceId={spaceId} onChange={load} />)}
          </div>

          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-gray-400">Coming soon</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {comingSoon.map((c) => <ConnectorCard key={c.id} connector={c} spaceId={spaceId} onChange={load} />)}
          </div>
        </>
      )}
    </div>
  );
}
