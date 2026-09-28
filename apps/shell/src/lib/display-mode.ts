export type DisplayMode = "business" | "developer";

const KEY = "naelao.display_mode";
export const DEFAULT_DISPLAY_MODE: DisplayMode = "business";

export function readDisplayMode(storage: Pick<Storage, "getItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage): DisplayMode {
  const value = storage?.getItem(KEY);
  return value === "developer" ? "developer" : DEFAULT_DISPLAY_MODE;
}

export function persistDisplayMode(mode: DisplayMode, storage: Pick<Storage, "setItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage): void {
  storage?.setItem(KEY, mode);
}

export function developerOnly<T>(mode: DisplayMode, value: T): T | undefined {
  return mode === "developer" ? value : undefined;
}
