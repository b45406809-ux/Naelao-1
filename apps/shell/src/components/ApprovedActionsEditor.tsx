"use client";

// A small add/remove editor for an approval policy's `auto_approved_actions` list — shared by the
// Dashboard's space-wide Configuration panel and the per-agent policy editor (AgentPolicyPanel),
// so "which tools never need to ask" is editable in both places rather than only a read-only list
// with no way to change it short of clicking "Always allow" on a live approval card.

import * as React from "react";

export function ApprovedActionsEditor({
  actions,
  canEdit,
  busy,
  onAdd,
  onRemove,
}: {
  actions: string[];
  canEdit: boolean;
  busy: boolean;
  onAdd: (action: string) => void;
  onRemove: (action: string) => void;
}) {
  const [draft, setDraft] = React.useState("");

  function submit() {
    const trimmed = draft.trim();
    if (!trimmed || actions.includes(trimmed)) return;
    onAdd(trimmed);
    setDraft("");
  }

  return (
    <div>
      {actions.length === 0 ? (
        <div style={{ color: "var(--text3)", fontSize: 12 }}>Every action is confirmed before it happens.</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {actions.map((a) => (
            <span
              key={a}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontFamily: "monospace",
                background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 999,
                padding: "2px 4px 2px 8px",
              }}
            >
              {a}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => onRemove(a)}
                  disabled={busy}
                  title={`Stop auto-approving ${a}`}
                  style={{
                    border: "none", background: "transparent", color: "var(--text3)", cursor: "pointer",
                    fontSize: 13, lineHeight: 1, padding: "0 4px",
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {canEdit && (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input
            className="form-input"
            placeholder="e.g. web-search.search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            disabled={busy}
            style={{ flex: 1, fontSize: 11.5, fontFamily: "monospace" }}
          />
          <button type="button" className="btn btn-ghost btn-sm" onClick={submit} disabled={busy || !draft.trim()}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}
