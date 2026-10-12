export const DESK_COOKIE = "__Host-naelao-desk";
export interface DeskSession { token: string; userId: string; productId: string; spaceId: string; expiresAt: string }
export function readDeskSession(cookie: string | undefined): DeskSession | null {
  const raw = cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${DESK_COOKIE}=`))?.slice(DESK_COOKIE.length + 1);
  if (!raw || raw.length > 4096) return null;
  try {
    const value = JSON.parse(atob(raw)) as DeskSession;
    return typeof value.token === "string" && /^nps_/.test(value.token) && typeof value.userId === "string" && typeof value.productId === "string" && typeof value.spaceId === "string" && Date.parse(value.expiresAt) > Date.now() ? value : null;
  } catch { return null; }
}
