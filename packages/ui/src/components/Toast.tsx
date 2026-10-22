import * as React from "react";

export interface ToastState {
  message: string;
  key: number;
}

export function useToast() {
  const [toast, setToast] = React.useState<ToastState | null>(null);
  const show = React.useCallback((message: string) => {
    setToast({ message, key: Date.now() });
  }, []);
  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);
  return { toast, show };
}

export function Toast({ toast }: { toast: ToastState | null }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className={["toast", toast ? "show" : ""].filter(Boolean).join(" ")}>
      {toast?.message ?? ""}
    </div>
  );
}
