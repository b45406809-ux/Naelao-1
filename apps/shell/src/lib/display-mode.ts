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

const TECHNICAL_KEYS = /^(?:model(?:Id|_id|Name|_name)?|compute(?:Tier|_tier)?|execution(?:Tier|_tier)|tier(?:Id|_id|Name|_name)?|rawTierId|(?:base|head)?Commit|commit(?:Id|Oid|_id|_oid)?|git(?:Hash|Oid|_hash|_oid)?|patch|mergeMarkers)$/i;
const MERGE_MARKER_LINE = /^(?:<{7}|={7}|>{7}).*(?:\r?\n|$)/gm;

/**
 * Last-mile projection for data rendered in Client Workspace cards. API payloads are shared
 * with the developer foundry, so business mode must remove implementation machinery
 * recursively rather than trusting every individual component to remember each field.
 */
export function projectForDisplay<T>(value: T, mode: DisplayMode): T {
  if (mode === "developer") return structuredClone(value);
  const clean = (current: unknown): unknown => {
    if (typeof current === "string") return current.replace(MERGE_MARKER_LINE, "");
    if (Array.isArray(current)) return current.map(clean);
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current)
        .filter(([key]) => !TECHNICAL_KEYS.test(key))
        .map(([key, nested]) => [key, clean(nested)]));
    }
    return current;
  };
  return clean(value) as T;
}
