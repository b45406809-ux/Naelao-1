"use client";

// The space switcher selects a user Space while Home/Projects/Threads/Assistant operate on that
// selection. `activeSpaceId` (default = the product root's own space_id) is what every
// shell data call should scope to, not `product.space_id` directly. `product-context.tsx` stays
// the product root identity (slug resolution, auth) — this is a separate, orthogonal concept:
// WHICH space the shell is currently browsing.
//
// Persisted via sessionStorage (not the URL) per-product, so a hard reload keeps you in the
// Space you selected without needing a second dynamic route segment for every existing
// page.

import * as React from "react";

export interface ActiveSpaceContextValue {
  /** The space every shell data call (manifest/projects/threads/chat) should scope to. */
  activeSpaceId: string;
  /** Display name of the active space, when known (set by whoever calls setActiveSpace). */
  activeSpaceName: string | null;
  /** True when browsing a user-created Space rather than the product root. */
  isChildSpace: boolean;
  /** True once the sessionStorage hydration effect below has run. A consumer that auto-selects a
   *  default active space (e.g. the shell layout steering a hybrid/tenant product's user into
   *  their first Space) MUST wait for this — React runs a child's effects before its parent's
   *  within one commit, so an effect in a child of ActiveSpaceProvider would otherwise fire
   *  before hydration and could clobber a real persisted choice with a computed default. Same
   *  precedent as ProductAuthProvider's own isHydrated (auth-provider.tsx). */
  isHydrated: boolean;
  setActiveSpace: (id: string, name?: string | null) => void;
  /** Builder-configured support contact (mailto: or https:) from manifest.legal.support_contact.
   *  Populated by the shell layout once the manifest loads; null until then or if unset. */
  supportContact: string | null;
  setSupportContact: (contact: string | null) => void;
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
  const [supportContact, setSupportContact] = React.useState<string | null>(null);
  const [isHydrated, setIsHydrated] = React.useState(false);

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
    } finally {
      setIsHydrated(true);
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
      isChildSpace: activeSpaceId !== productSpaceId,
      isHydrated,
      setActiveSpace,
      supportContact,
      setSupportContact,
    }),
    [activeSpaceId, activeSpaceName, productSpaceId, isHydrated, setActiveSpace, supportContact]
  );

  return <ActiveSpaceContext.Provider value={value}>{children}</ActiveSpaceContext.Provider>;
}

export function useActiveSpace(): ActiveSpaceContextValue {
  const ctx = React.useContext(ActiveSpaceContext);
  if (!ctx) throw new Error("useActiveSpace must be used within an ActiveSpaceProvider");
  return ctx;
}
