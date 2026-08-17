// Shared "click Connect" logic for a catalogued connector — used by the sidebar Connectors page
// and the chat input bar's Connectors popover / inline "Connect this app" card. The business
// detail page (spaces/[businessId]/page.tsx) has its own long-standing inline copy of this same
// branching predating this file; left as-is rather than refactored under this pass, so this is a
// second, small, deliberate instance of the same pattern rather than a shared import there.

import { startOAuthConnect, startProviderConnect, connectPlatform, type ConnectorInfo, type SessionCredentials } from "./api";

/** Starts connecting `connector`. Composio/OAuth connectors navigate the real browser away (the
 *  caller doesn't need to do anything else — the redirect back lands on `returnUrl` with a
 *  `${id}_connected=1`/`${id}_oauth_error=` marker). A manual-key connector has no redirect —
 *  returns `{ needsManualKey: true }` so the caller can show a key input and call
 *  `submitManualKey` once the user provides one. */
export async function startConnectorConnect(
  spaceId: string,
  session: SessionCredentials,
  connector: ConnectorInfo,
  returnUrl: string
): Promise<{ needsManualKey: boolean }> {
  if (connector.composio || connector.pipedream) {
    const { connect_url } = await startProviderConnect(spaceId, session, connector.id, returnUrl);
    window.location.href = connect_url;
    return { needsManualKey: false };
  }
  if (connector.oauth) {
    const { authorize_url } = await startOAuthConnect(spaceId, session, connector.id, returnUrl);
    window.location.href = authorize_url;
    return { needsManualKey: false };
  }
  return { needsManualKey: true };
}

/**
 * Connect an app from the full provider directory rather than the curated catalogue. Always a
 * hosted redirect — that is the entire point of the directory: Composio and Pipedream run the
 * OAuth dance with their own registered app credentials, so there is no key for anyone to find.
 */
export async function startDirectoryConnect(
  spaceId: string,
  session: SessionCredentials,
  appId: string,
  returnUrl: string
): Promise<void> {
  const { connect_url } = await startProviderConnect(spaceId, session, appId, returnUrl);
  window.location.href = connect_url;
}

export async function submitManualConnectorKey(
  spaceId: string,
  session: SessionCredentials,
  connectorId: string,
  apiKey: string
): Promise<void> {
  await connectPlatform(spaceId, session, connectorId, apiKey);
}

/** Reads and clears `${connectorId}_connected=1` / `${connectorId}_oauth_error=...` return
 *  markers from the current URL for one specific connector (a redirect flow lands back on
 *  whatever page started it, so both the business detail page and this new Connectors page need
 *  to handle their own return trip independently). Returns what happened, or null if neither
 *  marker was present. */
export function consumeConnectorReturnMarker(connectorId: string): { connected: boolean; error?: string } | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const connectedKey = `${connectorId}_connected`;
  const errorKey = `${connectorId}_oauth_error`;
  const connected = params.get(connectedKey);
  const error = params.get(errorKey);
  if (!connected && !error) return null;
  params.delete(connectedKey);
  params.delete(errorKey);
  const clean = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
  window.history.replaceState({}, "", clean);
  return { connected: !!connected, ...(error ? { error } : {}) };
}
