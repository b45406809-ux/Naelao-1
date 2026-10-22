"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

/**
 * A destructive-action confirmation that requires typing the resource's own name back — stricter
 * than a plain "are you sure?" toggle (e.g. clients/page.tsx's inline confirmPromote pattern),
 * reserved for irreversible actions like deleting a live product. First shared UI component in
 * apps/dashboard/src/components/ — extract further reuses here rather than re-copying this.
 */
export function ConfirmByTypingDialog({
  title,
  description,
  confirmText,
  actionLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  /** The exact string the user must type (typically the resource's name). */
  confirmText: string;
  actionLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dialogId = useId();
  const matches = typed === confirmText;

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => { if (!busy) onCancel(); }} role="presentation" />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        aria-describedby={`${dialogId}-description`}
        aria-busy={busy}
        onKeyDown={handleDialogKeyDown}
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6"
      >
        <h2 id={`${dialogId}-title`} className="text-lg font-bold text-gray-900 mb-2">{title}</h2>
        <p id={`${dialogId}-description`} className="text-sm text-gray-500 mb-4">{description}</p>

        <label htmlFor={`${dialogId}-confirm`} className="block text-sm font-medium text-gray-700 mb-1">
          Type <span className="font-mono font-semibold text-gray-900">{confirmText}</span> to confirm
        </label>
        <input
          id={`${dialogId}-confirm`}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={busy}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none transition text-sm font-mono"
        />

        <div className="flex gap-3 mt-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!matches || busy}
            className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {busy ? "Working…" : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
