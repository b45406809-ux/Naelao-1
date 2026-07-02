// End-user session management
// Uses sessionStorage (ephemeral — cleared when tab closes) for session IDs.
// Uses localStorage for the anonymous end-user ID (persists across sessions).
// G-A07: Ephemeral session token storage for end-users

const SESSION_KEY_PREFIX = "naelao_session_id";
const END_USER_KEY = "naelao_euid";

function sessionKey(spaceId: string): string {
  return `${SESSION_KEY_PREFIX}_${spaceId}`;
}

/**
 * Retrieve the stored session ID for a given Space from sessionStorage.
 * Returns null if not found or if running server-side.
 */
export function getSessionId(spaceId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(sessionKey(spaceId));
  } catch {
    // sessionStorage can throw in private browsing on some browsers
    return null;
  }
}

/**
 * Persist a session ID for a given Space to sessionStorage.
 * Silently fails if sessionStorage is unavailable.
 */
export function storeSessionId(spaceId: string, sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(sessionKey(spaceId), sessionId);
  } catch {
    // ignore
  }
}

/**
 * Clear the stored session ID for a given Space from sessionStorage.
 */
export function clearSessionId(spaceId: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(sessionKey(spaceId));
  } catch {
    // ignore
  }
}

/**
 * Get or create a stable anonymous end-user ID for this browser.
 * Stored in localStorage so it persists across browser sessions.
 * Format: "euid_<random hex>" — not a UUID to avoid depending on crypto polyfills.
 */
export function getOrCreateEndUserId(): string {
  if (typeof window === "undefined") return "euid_server";
  try {
    const existing = localStorage.getItem(END_USER_KEY);
    if (existing) return existing;

    // Generate a random 16-byte hex ID
    const arr = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(arr);
    } else {
      // Fallback for very old environments
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
    }
    const id = `euid_${Array.from(arr)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`;

    localStorage.setItem(END_USER_KEY, id);
    return id;
  } catch {
    // localStorage blocked (e.g., iframe with strict policies)
    return `euid_tmp_${Math.random().toString(36).slice(2)}`;
  }
}
