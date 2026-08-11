"use client";

// A small add/remove editor for an approval policy's `auto_approved_actions` list — shared by the
// Dashboard's space-wide Configuration panel and the per-agent policy editor (AgentPolicyPanel),
// so "which tools never need to ask" is editable in both places rather than only a read-only list
// with no way to change it short of clicking "Always allow" on a live approval card.
//
// Live-reported gap: this used to be a free-text field with a single example placeholder, so the
// only way to discover what could BE approved was to guess a name or wait for a real approval card
// to teach you one. `catalogue` (built from GET .../assistant/capabilities, the same data the
// Skills tab already reads) makes every operation the agent could ever call browsable here —
// grouped by the prebuilt script that owns it, with that script's own description, so a bare name
// like "thread.send_message" reads as "the thing that lets me chat inside an existing thread"
// rather than an opaque string you'd have to already know to type.

import * as React from "react";

export interface OperationGroup {
  script: string;
  description: string;
  operations: string[];
}

export function ApprovedActionsEditor({
  actions,
  canEdit,
  busy,
  onAdd,
  onRemove,
  catalogue,
}: {
  actions: string[];
  canEdit: boolean;
  busy: boolean;
  onAdd: (action: string) => void;
  onRemove: (action: string) => void;
  /** Every operation the agent could call, grouped by owning script — lets someone browse and
   *  add rather than only type a name they already know. Omitted/undefined where no capabilities
   *  fetch is wired, or while it's still loading (falls back to the plain free-text field only). */
  catalogue?: OperationGroup[] | undefined;
}) {
  const [draft, setDraft] = React.useState("");
  const [browsing, setBrowsing] = React.useState(false);

  function submit() {
    const trimmed = draft.trim();
    if (!trimmed || actions.includes(trimmed)) return;
    onAdd(trimmed);
    setDraft("");
  }

  const approvedSet = React.useMemo(() => new Set(actions), [actions]);
  const totalOps = React.useMemo(() => (catalogue ?? []).reduce((n, g) => n + g.operations.length, 0), [catalogue]);

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
      {canEdit && catalogue && catalogue.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => setBrowsing((v) => !v)}
            style={{
              background: "transparent", border: "none", color: "var(--accent)", cursor: "pointer",
              fontSize: 11.5, padding: 0,
            }}
          >
            {browsing ? "Hide" : `Browse all ${totalOps} available tools`}
          </button>
          {browsing && (
            <div style={{ marginTop: 6, maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
              {catalogue.map((group) => (
                <div key={group.script} style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)" }}>{group.script}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text3)", lineHeight: 1.4, marginBottom: 4 }}>{group.description}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {group.operations.map((op) => {
                      const already = approvedSet.has(op);
                      return (
                        <button
                          key={op}
                          type="button"
                          disabled={busy || already}
                          onClick={() => onAdd(op)}
                          title={already ? "Already pre-approved" : `Pre-approve ${op}`}
                          style={{
                            fontSize: 10.5, fontFamily: "monospace", padding: "2px 7px", borderRadius: 999,
                            border: "1px solid var(--border)",
                            background: already ? "var(--surface2)" : "transparent",
                            color: already ? "var(--text3)" : "var(--text2)",
                            cursor: already ? "default" : "pointer",
                          }}
                        >
                          {already ? "✓ " : "+ "}{op}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
