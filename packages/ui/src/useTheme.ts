import * as React from "react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "naelao_theme";

function resolveSystemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
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
    const stored = typeof window !== "undefined" ? (window.localStorage.getItem(STORAGE_KEY) as ThemeMode | null) : null;
    const initial = stored ?? "system";
    setModeState(initial);
    applyTheme(initial);
  }, []);

  const setMode = React.useCallback((next: ThemeMode) => {
    setModeState(next);
    applyTheme(next);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return { mode, setMode };
}
