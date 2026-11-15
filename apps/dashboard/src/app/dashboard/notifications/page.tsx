"use client";

import { useCallback, useEffect, useState } from "react";
import { listMyPlatformNotifications, markMyPlatformNotificationRead, type PlatformNotification } from "@/lib/api";

function displayDate(value: string): string {
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function NotificationsPage() {
  const [items, setItems] = useState<PlatformNotification[]>([]);
  const [showRead, setShowRead] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const page = await listMyPlatformNotifications({ status: showRead ? "all" : "unread" });
      setItems(page.data);
      setCursor(page.next_cursor);
      setHasMore(page.has_more);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [showRead]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listMyPlatformNotifications({ status: showRead ? "all" : "unread", cursor });
      setItems((current) => [...current, ...page.data]);
      setCursor(page.next_cursor);
      setHasMore(page.has_more);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  async function markRead(item: PlatformNotification) {
    setBusyId(item.id);
    setFailed(false);
    try {
      await markMyPlatformNotificationRead(item.id);
      if (showRead) {
        setItems((current) => current.map((entry) => entry.id === item.id
          ? { ...entry, read_at: entry.read_at ?? new Date().toISOString() }
          : entry));
      } else {
        setItems((current) => current.filter((entry) => entry.id !== item.id));
      }
    } catch {
      setFailed(true);
    } finally {
      setBusyId(null);
    }
  }

  return <div className="mx-auto max-w-4xl space-y-6">
    <header>
      <h1 className="text-2xl font-bold text-gray-900">Notifications</h1>
      <p className="mt-1 text-sm text-gray-500">Private notices for your platform account. Space and Product-user inboxes remain separate.</p>
    </header>

    <div className="flex items-center justify-between gap-3">
      <button type="button" className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
        onClick={() => setShowRead((value) => !value)}>
        {showRead ? "Show unread only" : "Show read too"}
      </button>
      <span className="text-sm text-gray-500">{items.length} shown</span>
    </div>

    {failed && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      Could not load or update notifications. Your unread state was not changed. <button type="button" className="ml-2 underline" onClick={() => void refresh()}>Retry</button>
    </div>}
    {loading ? <p className="text-sm text-gray-500">Loading notifications…</p>
      : items.length === 0 ? <p className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500">
        {showRead ? "No notifications yet." : "You are caught up."}
      </p>
        : <ul className="space-y-3">
          {items.map((item) => <li key={item.id} className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="font-semibold text-gray-900">{item.title}</h2>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-600">{item.body}</p>
                <p className="mt-3 text-xs text-gray-400">{item.type} · {displayDate(item.created_at)}</p>
              </div>
              {item.read_at ? <span className="text-xs text-gray-500">Read</span>
                : <button type="button" disabled={busyId === item.id}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  onClick={() => void markRead(item)}>
                  {busyId === item.id ? "Saving…" : "Mark read"}
                </button>}
            </div>
          </li>)}
        </ul>}

    {!loading && hasMore && <div className="text-center">
      <button type="button" disabled={loadingMore} onClick={() => void loadMore()}
        className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
        {loadingMore ? "Loading…" : "Load older notifications"}
      </button>
    </div>}
  </div>;
}
