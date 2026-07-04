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
