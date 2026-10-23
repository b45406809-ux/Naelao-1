"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  getResellerClients,
  getResellerClient,
  setResellerClientStatus,
  promoteResellerClient,
} from "@/lib/api";
import type {
  ResellerClient,
  ResellerClientsResponse,
  ResellerClientDetail,
} from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  inactive: "bg-gray-100 text-gray-500",
  suspended: "bg-red-100 text-red-700",
  terminated: "bg-gray-100 text-gray-500",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? "bg-gray-100 text-gray-500";
  return (
    <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}

function centsToDisplay(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function BillingSummary({
  billing,
  period,
}: {
  billing: ResellerClientsResponse["billing"];
  period: string;
}) {
  const cards = [
    { label: "Retail Revenue", value: centsToDisplay(billing.retail), muted: false },
    { label: "Wholesale Cost", value: centsToDisplay(billing.wholesale), muted: true },
    { label: "Net Margin", value: centsToDisplay(billing.margin), muted: false, highlight: true },
    { label: "Billing Events", value: String(billing.events), muted: true },
  ];

  return (
    <div className="mb-6">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
        {period} · Billing Summary
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className={`rounded-xl border p-4 ${
              card.highlight ? "border-brand-200 bg-brand-50" : "border-gray-200 bg-white"
            }`}
          >
            <p className="text-xs text-gray-500 mb-1">{card.label}</p>
            <p
              className={`text-xl font-bold ${
                card.highlight ? "text-brand-700" : card.muted ? "text-gray-500" : "text-gray-900"
              }`}
            >
              {card.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ClientRow({
  client,
  onOpen,
}: {
  client: ResellerClient;
  onOpen: (c: ResellerClient) => void;
}) {
  const joined = new Date(client.created_at).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const shortId = client.child_tenant_id.slice(0, 8);

  return (
    <tr
      className="hover:bg-gray-50 transition-colors"
    >
      <td className="px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-brand-100 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-bold text-brand-700">
              {shortId[0]?.toUpperCase() ?? "?"}
            </span>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900 font-mono">{shortId}…</p>
            <p className="text-xs text-gray-400 font-mono">
              owner: {client.child_owner_user_id.slice(0, 8)}…
            </p>
          </div>
        </div>
      </td>
      <td className="px-6 py-4 text-sm text-gray-700 text-center">{client.space_count}</td>
      <td className="px-6 py-4">
        <StatusBadge status={client.status} />
      </td>
      <td className="px-6 py-4 text-sm text-gray-500">{joined}</td>
      <td className="px-6 py-4 text-right">
        <button
          type="button"
          onClick={() => onOpen(client)}
          className="text-brand-600 text-xs font-medium underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
          aria-label={`Manage client ${shortId}`}
        >
          Manage →
        </button>
      </td>
    </tr>
  );
}

function ClientDrawer({
  client,
  onClose,
  onChanged,
}: {
  client: ResellerClient;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ResellerClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmPromote, setConfirmPromote] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dialogId = useId();

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    drawerRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  function handleDrawerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || !drawerRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !drawerRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDetail(await getResellerClient(client.child_tenant_id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load client");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.child_tenant_id]);

  const status = detail?.status ?? client.status;
  const suspended = status === "suspended";
  const terminated = status === "terminated";

  async function toggleSuspend() {
    setBusy(true);
    setError(null);
    try {
      await setResellerClientStatus(client.child_tenant_id, suspended ? "active" : "suspended");
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function promote() {
    setBusy(true);
    setError(null);
    try {
      await promoteResellerClient(client.child_tenant_id);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Promotion failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={() => { if (!busy) onClose(); }} role="presentation" />
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        aria-busy={busy}
        onKeyDown={handleDrawerKeyDown}
        className="relative bg-white w-full max-w-md h-full shadow-2xl overflow-y-auto"
      >
        <div className="px-6 py-5 border-b border-gray-200 flex items-start justify-between">
          <div>
            <p className="text-xs text-gray-400 font-mono">{client.child_tenant_id}</p>
            <h2 id={`${dialogId}-title`} className="text-lg font-bold text-gray-900 mt-1">Client</h2>
            <div className="mt-2">
              <StatusBadge status={status} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-gray-400 hover:text-gray-700 text-xl leading-none"
            aria-label="Close client details"
          >
            ×
          </button>
        </div>

        {error && (
          <div role="alert" className="m-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-gray-400">Loading…</div>
        ) : (
          <div className="p-6 space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Businesses ({detail?.space_count ?? 0})
              </h3>
              {detail && detail.spaces.length > 0 ? (
                <ul className="space-y-2">
                  {detail.spaces.map((s) => (
                    <li
                      key={s.id}
                      className="border border-gray-200 rounded-lg px-3 py-2 flex items-center justify-between"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900">{s.name}</p>
                        <p className="text-xs text-gray-400">
                          {s.spacetype_id} · {s.tenancy_mode}
                        </p>
                      </div>
                      <StatusBadge status={s.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-400">No businesses yet.</p>
              )}
            </div>

            {detail && !terminated && (
              <div className="border-t border-gray-100 pt-5 space-y-3">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                  Actions
                </h3>

                <button
                  type="button"
                  onClick={() => void toggleSuspend()}
                  disabled={busy}
                  className={`w-full px-4 py-2 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50 ${
                    suspended
                      ? "bg-green-600 hover:bg-green-700 text-white"
                      : "bg-yellow-500 hover:bg-yellow-600 text-white"
                  }`}
                >
                  {busy ? "Working…" : suspended ? "Reactivate client" : "Suspend client"}
                </button>
                <p className="text-xs text-gray-400">
                  {suspended
                    ? "Restores access to all of this client's businesses."
                    : "Pauses all of this client's businesses. Data is preserved and reversible."}
                </p>

                {!confirmPromote ? (
                  <button
                    type="button"
                    onClick={() => setConfirmPromote(true)}
                    disabled={busy}
                    className="w-full px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
                  >
                    Promote to standalone product
                  </button>
                ) : (
                  <div role="alert" className="border border-red-200 bg-red-50 rounded-lg p-3 space-y-2">
                    <p className="text-xs text-red-700">
                      This permanently detaches the business from your reseller program. It
                      becomes an independent product and stops counting toward your billing.
                      This cannot be undone.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmPromote(false)}
                        disabled={busy}
                        className="flex-1 px-3 py-1.5 text-xs font-medium border border-gray-200 rounded-lg hover:bg-white"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void promote()}
                        disabled={busy}
                        className="flex-1 px-3 py-1.5 text-xs font-semibold bg-red-600 hover:bg-red-700 text-white rounded-lg disabled:opacity-50"
                      >
                        {busy ? "Working…" : "Confirm promote"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ClientsPage() {
  const [data, setData] = useState<ResellerClientsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ResellerClient | null>(null);
  const [page, setPage] = useState(1);
  const loadRevision = useRef(0);

  async function load(requestedPage = page) {
    const revision = ++loadRevision.current;
    setLoading(true);
    setError(null);
    try {
      const result = await getResellerClients(requestedPage);
      if (revision !== loadRevision.current) return;
      setData(result);
      setPage(result.page);
    } catch (err) {
      if (revision !== loadRevision.current) return;
      setError(err instanceof Error ? err.message : "Failed to load clients");
    } finally {
      if (revision === loadRevision.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(1);
    return () => { loadRevision.current++; };
  }, []);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Client Portfolio</h1>
        <p className="text-gray-500 mt-1">
          Businesses created under your reseller program
        </p>
      </div>

      {loading && <div className="text-center py-12 text-gray-400">Loading…</div>}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-6 flex items-center justify-between">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="text-sm underline ml-4 flex-shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && data && (
        <>
          <BillingSummary billing={data.billing} period={data.current_period} />

          {data.clients.length === 0 ? (
            <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center">
              <p className="text-gray-500 text-sm">No clients yet.</p>
              <p className="text-gray-400 text-xs mt-1">
                Clients appear here when users sign up through your product&apos;s public
                portal.
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-700">
                  {data.client_count} client{data.client_count !== 1 ? "s" : ""}
                </p>
              </div>
              <table className="w-full text-sm">
                <caption className="sr-only">Reseller client portfolio</caption>
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th scope="col" className="text-left px-6 py-3 font-semibold text-gray-600">Tenant</th>
                    <th scope="col" className="text-center px-6 py-3 font-semibold text-gray-600">Spaces</th>
                    <th scope="col" className="text-left px-6 py-3 font-semibold text-gray-600">Status</th>
                    <th scope="col" className="text-left px-6 py-3 font-semibold text-gray-600">Joined</th>
                    <th scope="col" className="px-6 py-3"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.clients.map((client) => (
                    <ClientRow
                      key={client.child_tenant_id}
                      client={client}
                      onOpen={setSelected}
                    />
                  ))}
                </tbody>
              </table>
              {data.page_count > 1 && (
                <nav aria-label="Client pages" className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-4">
                  <span className="text-xs text-gray-500" aria-live="polite">
                    Showing {(data.page - 1) * data.page_size + 1}–{Math.min(data.page * data.page_size, data.client_count)} of {data.client_count}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void load(data.page - 1)}
                      disabled={loading || data.page <= 1}
                      className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-50"
                    >
                      Previous
                    </button>
                    <span className="self-center text-xs text-gray-500" aria-label={`Page ${data.page} of ${data.page_count}`}>
                      {data.page} / {data.page_count}
                    </span>
                    <button
                      type="button"
                      onClick={() => void load(data.page + 1)}
                      disabled={loading || data.page >= data.page_count}
                      className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </nav>
              )}
            </div>
          )}
        </>
      )}

      {selected && (
        <ClientDrawer
          key={selected.child_tenant_id}
          client={selected}
          onClose={() => setSelected(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}
