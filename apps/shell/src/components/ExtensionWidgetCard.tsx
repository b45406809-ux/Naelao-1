"use client";

import * as React from "react";

export function ExtensionWidgetCard({ view }: { view: { title: string; body?: string; tone?: "neutral" | "success" | "warning" | "danger"; fields?: Array<{ label: string; value: string }> } }) {
  const color = view.tone === "success" ? "#16803c" : view.tone === "warning" ? "#9a6700" : view.tone === "danger" ? "#b42318" : "var(--text2)";
  return (
    <section aria-label={view.title} style={{ marginTop: 8, border: "1px solid var(--border)", borderLeft: `3px solid ${color}`, borderRadius: 9, padding: "10px 12px", background: "var(--surface1, var(--bg))", maxWidth: 520 }}>
      <h4 style={{ margin: 0, color: "var(--text1)", fontSize: 13, fontWeight: 650 }}>{view.title}</h4>
      {view.body && <p style={{ margin: "6px 0 0", color: "var(--text2)", fontSize: 12.5, whiteSpace: "pre-wrap" }}>{view.body}</p>}
      {!!view.fields?.length && <dl style={{ margin: "8px 0 0", display: "grid", gridTemplateColumns: "minmax(90px, auto) 1fr", gap: "4px 10px", fontSize: 12 }}>
        {view.fields.map((field, index) => <React.Fragment key={`${field.label}:${index}`}>
          <dt style={{ color: "var(--text3)" }}>{field.label}</dt><dd style={{ margin: 0, color: "var(--text2)", overflowWrap: "anywhere" }}>{field.value}</dd>
        </React.Fragment>)}
      </dl>}
    </section>
  );
}
