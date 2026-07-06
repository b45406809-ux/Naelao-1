"use client";

// The space switcher previously only ever navigated to a business's own admin/detail page
// (/spaces/:id) — Home/Projects/Threads/Assistant kept operating on the product root no matter
// which business was selected, contradicting the whole point of a switcher. This context is the
// missing piece: `activeSpaceId` (default = the product root's own space_id) is what every
// shell data call should scope to, not `product.space_id` directly. `product-context.tsx` stays
// the product root identity (slug resolution, auth) — this is a separate, orthogonal concept:
// WHICH space the shell is currently browsing.
//
// Persisted via sessionStorage (not the URL) per-product, so a hard reload keeps you in the
// business you switched to without needing a second dynanic route segment for every existing
// page.

import * as React from "react";

export interface ActiveSpaceContextValue {
  /** The space every shell data call (manifest/projects/threads/chat) should scope to. */
  activeSpaceId: string;
  /** Display name of the active space, when known (set by whoever calls setActiveSpace). */
  activeSpaceName: string | null;
  /** True when browsing a business other than the product root. */
  isBusinessSpace: boolean;
  setActiveSpace: (id: string, name?: string | null) => void;
}

const ActiveSpaceContext = React.createContext<ActiveSpaceContextValue | null>(null);

function storageKey(productSpaceId: string): string {
  return `naelao:active-space:${productSpaceId}`;
}

export function ActiveSpaceProvider({
  productSpaceId,
  children,
}: {
  productSpaceId: string;
  children: React.ReactNode;
}) {
  const [activeSpaceId, setActiveSpaceId] = React.useState(productSpaceId);
  const [activeSpaceName, setActiveSpaceName] = React.useState<string | null>(null);

  // Hydrate from sessionStorage once, client-side only — avoids an SSR/first-paint mismatch.
  React.useEffect(() => {
    try {
      const stored = sessionStorage.getItem(storageKey(productSpaceId));
      if (stored) {
        const parsed = JSON.parse(stored) as { id?: string; name?: string | null };
        if (parsed.id) {
          setActiveSpaceId(parsed.id);
          setActiveSpaceName(parsed.name ?? null);
        }
      }
    } catch {
      /* sessionStorage unavailable (private mode, etc.) — stay on the product root */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productSpaceId]);

  const setActiveSpace = React.useCallback(
    (id: string, name?: string | null) => {
      setActiveSpaceId(id);
      setActiveSpaceName(name ?? null);
      try {
        if (id === productSpaceId) {
          sessionStorage.removeItem(storageKey(productSpaceId));
        } else {
          sessionStorage.setItem(storageKey(productSpaceId), JSON.stringify({ id, name: name ?? null }));
        }
      } catch {
        /* best-effort persistence only — in-memory state above still switches correctly */
      }
    },
    [productSpaceId]
  );

  const value = React.useMemo<ActiveSpaceContextValue>(
    () => ({
      activeSpaceId,
      activeSpaceName,
      isBusinessSpace: activeSpaceId !== productSpaceId,
      setActiveSpace,
    }),
    [activeSpaceId, activeSpaceName, productSpaceId, setActiveSpace]
  );

  return <ActiveSpaceContext.Provider value={value}>{children}</ActiveSpaceContext.Provider>;
}

export function useActiveSpace(): ActiveSpaceContextValue {
  const ctx = React.useContext(ActiveSpaceContext);
  if (!ctx) throw new Error("useActiveSpace must be used within an ActiveSpaceProvider");
  return ctx;
}
