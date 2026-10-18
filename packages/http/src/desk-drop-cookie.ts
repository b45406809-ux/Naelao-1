export const DESK_COOKIE = "__Host-naelao-desk";
export interface DeskSession {
  token: string;
  userId: string;
  productId: string;
  spaceId: string;
  expiresAt: string;
}
export function readDeskSession(
  cookie: string | undefined
): DeskSession | null {
  const raw = cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${DESK_COOKIE}=`))
    ?.slice(DESK_COOKIE.length + 1);
  if (
    !raw ||
    raw.length > 4096 ||
    raw.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      raw
    )
  ) {
    return null;
  }
  try {
    const decoded = atob(raw);
    if (btoa(decoded) !== raw) return null;
    const value = JSON.parse(decoded) as Partial<DeskSession> | null;
    if (
      !value ||
      typeof value.token !== "string" ||
      !/^nps_/.test(value.token) ||
      typeof value.userId !== "string" ||
      !value.userId ||
      typeof value.productId !== "string" ||
      !value.productId ||
      typeof value.spaceId !== "string" ||
      !value.spaceId ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.now()
    ) {
      return null;
    }
    return value as DeskSession;
  } catch {
    return null;
  }
}
