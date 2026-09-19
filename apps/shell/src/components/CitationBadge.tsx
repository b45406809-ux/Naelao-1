"use client";

import * as React from "react";
import {
  resolveCitation,
  type Message,
  type SessionCredentials,
} from "@/lib/api";

type Citation = NonNullable<
  NonNullable<Message["metadata"]>["citations"]
>[number];

/** Authenticated source badge. React text nodes escape both labels and source bytes; source
 * content is never injected as HTML and no private document/chunk identifier is sent to click
 * analytics. */
export function CitationBadges({
  citations,
  spaceId,
  projectId,
  session,
}: {
  citations: Citation[];
  spaceId: string;
  projectId: string;
  session: SessionCredentials;
}): React.ReactElement {
  const [open, setOpen] = React.useState<{
    citation: Citation;
    content?: string;
    error?: string;
  } | null>(null);
  async function show(citation: Citation) {
    setOpen({ citation });
    try {
      const resolved = await resolveCitation(
        spaceId,
        projectId,
        citation,
        session
      );
      setOpen({ citation, content: resolved.content });
      window.dispatchEvent(
        new CustomEvent("naelao:citation-open", {
          detail: { ordinal: citation.ordinal },
        })
      );
    } catch (error) {
      setOpen({
        citation,
        error: error instanceof Error ? error.message : "Source unavailable",
      });
    }
  }
  return (
    <>
      <span
        aria-label="Sources"
        style={{ display: "inline-flex", gap: 4, marginTop: 6 }}
      >
        {[...citations]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((citation) => (
            <button
              key={citation.identity}
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={`Open source ${citation.ordinal}`}
              onClick={() => void show(citation)}
            >
              [{citation.ordinal}] {citation.label ?? "Source"}
            </button>
          ))}
      </span>
      {open && (
        <dialog
          open
          aria-modal="true"
          aria-label={`Source ${open.citation.ordinal}`}
          style={{
            position: "fixed",
            inset: "10% 4% 10% auto",
            width: "min(560px,92vw)",
            zIndex: 80,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 16,
            boxShadow: "0 20px 60px rgba(0,0,0,.3)",
            overflow: "auto",
          }}
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setOpen(null)}
            aria-label="Close source"
          >
            Close
          </button>
          <h2>Source {open.citation.ordinal}</h2>
          {open.error ? (
            <p role="alert">{open.error}</p>
          ) : open.content === undefined ? (
            <p>Loading source…</p>
          ) : (
            <pre style={{ whiteSpace: "pre-wrap" }}>{open.content}</pre>
          )}
        </dialog>
      )}
    </>
  );
}
