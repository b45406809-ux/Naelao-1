"use client";

import * as React from "react";

/**
 * The hover/tap action row under a chat message — copy on every message, edit on the last one the
 * user sent.
 *
 * `packages/ui/src/styles.css` has carried `.msg-actions`, `.msg-action`, `.msg-action .tooltip`
 * and `.msg-row:hover .msg-actions{opacity:1}` for a long time with no component ever emitting
 * them; the only affordance that existed was a text "Edit" button, always visible, on one message.
 * This wires the existing styles up rather than inventing a second set.
 *
 * Touch: `:hover` never fires on a tap, so the row would be permanently invisible on a phone.
 * Rather than making it always-visible there (which is what the plain `@media (hover:none)` escape
 * hatch does, and which puts two buttons under every message in a long thread), tapping the row
 * reveals it — matching how the user described Claude Code behaving.
 */

function CopyIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function EditIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export function MessageActions({
  content,
  onEdit,
  align = "left",
}: {
  content: string;
  /** Omitted for every message except the last one the user sent. */
  onEdit?: (() => void) | undefined;
  align?: "left" | "right";
}): React.ReactElement {
  const [copied, setCopied] = React.useState(false);

  const copy = React.useCallback(() => {
    // `navigator.clipboard` needs a secure context and can be refused outright; the textarea
    // fallback is what keeps this working on an http origin or a locked-down browser rather than
    // failing silently and looking like a broken button.
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(content).then(done).catch(() => fallbackCopy(content, done));
    } else {
      fallbackCopy(content, done);
    }
  }, [content]);

  return (
    <div className="msg-actions" style={align === "right" ? { justifyContent: "flex-end" } : undefined}>
      <button type="button" className="msg-action" onClick={copy} aria-label={copied ? "Copied" : "Copy message"}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        <span className="tooltip">{copied ? "Copied" : "Copy"}</span>
      </button>
      {onEdit && (
        <button type="button" className="msg-action" onClick={onEdit} aria-label="Edit and ask again">
          <EditIcon />
          <span className="tooltip">Edit</span>
        </button>
      )}
    </div>
  );
}

function fallbackCopy(text: string, done: () => void): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch {
    // Nothing sensible left to try. Staying silent beats a scary error for a copy button.
  }
}
