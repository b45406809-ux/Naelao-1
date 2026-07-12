// Chat transport session-id storage — ported from apps/portal/src/lib/session.ts. Distinct from
// productAccount.ts's `nps_...` product session: this is the chat SESSION row
// (SpaceDO-backed, message history) a signed-in end user's Home/thread chat surface resumes.
// Keyed per (spaceId, key) so multiple concurrent chat surfaces (Home vs. a specific thread) can
// coexist without clobbering each other; `key` defaults to "home".

function storageKey(spaceId: string, key: string): string {
  return `naelao_chat_session:${spaceId}:${key}`;
}

export function getChatSessionId(spaceId: string, key = "home"): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(storageKey(spaceId, key));
  } catch {
    return null;
  }
}

export function storeChatSessionId(spaceId: string, sessionId: string, key = "home"): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(storageKey(spaceId, key), sessionId);
  } catch {
    /* ignore */
  }
}

export function clearChatSessionId(spaceId: string, key = "home"): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(storageKey(spaceId, key));
  } catch {
    /* ignore */
  }
}

// §A1.27: the currently in-flight agent run for a chat session, if any — lets Chat.tsx reattach
// its SSE/poll stream on mount (a reload, or a remount from navigating away and back) instead of
// only showing history with no indication a run is still going. Cleared the moment the run
// resolves (done/error), so a stale id never survives past its own run. Same sessionStorage scope
// as the chat session id above — a genuinely NEW tab/browser session still starts fresh; this
// fixes reload/remount within the same tab, not cross-tab/cross-session resumption.
function activeRunStorageKey(spaceId: string, key: string): string {
  return `naelao_active_run:${spaceId}:${key}`;
}

export function getActiveRunId(spaceId: string, key = "home"): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(activeRunStorageKey(spaceId, key));
  } catch {
    return null;
  }
}

export function storeActiveRunId(spaceId: string, runId: string, key = "home"): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(activeRunStorageKey(spaceId, key), runId);
  } catch {
    /* ignore */
  }
}

export function clearActiveRunId(spaceId: string, key = "home"): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(activeRunStorageKey(spaceId, key));
  } catch {
    /* ignore */
  }
}
