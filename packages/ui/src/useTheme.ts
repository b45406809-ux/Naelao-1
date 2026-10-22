import * as React from "react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "naelao_theme";

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function resolveSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const resolved = mode === "system" ? (resolveSystemPrefersDark() ? "dark" : "light") : mode;
  document.documentElement.setAttribute("data-theme", resolved);
}

export function useTheme(): { mode: ThemeMode; setMode: (mode: ThemeMode) => void } {
  const [mode, setModeState] = React.useState<ThemeMode>("system");

  React.useEffect(() => {
    let stored: string | null = null;
    try { stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null; }
    catch { /* Storage can be unavailable in privacy-restricted browser contexts. */ }
    const initial = normalizeThemeMode(stored);
    setModeState(initial);
    applyTheme(initial);
  }, []);

  const setMode = React.useCallback((next: ThemeMode) => {
    const normalized = normalizeThemeMode(next);
    setModeState(normalized);
    applyTheme(normalized);
    try { if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, normalized); }
    catch { /* The current page theme still changes when persistence is unavailable. */ }
  }, []);

  return { mode, setMode };
}
