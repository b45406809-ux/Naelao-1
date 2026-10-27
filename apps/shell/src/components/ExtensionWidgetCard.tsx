"use client";

import * as React from "react";

type WidgetView = {
  title: string;
  body?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  layout?: "summary" | "list" | "table" | "progress";
  fields?: Array<{ label: string; value: string }>;
  items?: Array<{ title: string; detail?: string; status?: "pending" | "running" | "complete" | "blocked" | "failed" }>;
  progress?: number;
};

export function ExtensionWidgetCard({ view }: { view: WidgetView }) {
  const color = view.tone === "success" ? "#16803c" : view.tone === "warning" ? "#9a6700" : view.tone === "danger" ? "#b42318" : "var(--text2)";
  const statusColor: Record<NonNullable<NonNullable<WidgetView["items"]>[number]["status"]>, string> = {
    pending: "var(--text3)", running: "#175cd3", complete: "#16803c", blocked: "#9a6700", failed: "#b42318",
  };
  return (
    <section aria-label={view.title} style={{ marginTop: 8, border: "1px solid var(--border)", borderLeft: `3px solid ${color}`, borderRadius: 9, padding: "10px 12px", background: "var(--surface1, var(--bg))", maxWidth: 520 }}>
      <h4 style={{ margin: 0, color: "var(--text1)", fontSize: 13, fontWeight: 650 }}>{view.title}</h4>
      {view.body && <p style={{ margin: "6px 0 0", color: "var(--text2)", fontSize: 12.5, whiteSpace: "pre-wrap" }}>{view.body}</p>}
      {view.layout === "progress" && view.progress !== undefined && <div aria-label={`${view.progress}% complete`} style={{ marginTop: 9 }}>
        <div style={{ height: 6, overflow: "hidden", borderRadius: 6, background: "var(--surface2, #eaecf0)" }}>
          <div style={{ width: `${view.progress}%`, height: "100%", background: color, transition: "width 150ms ease" }} />
        </div>
        <div style={{ marginTop: 3, color: "var(--text3)", fontSize: 11 }}>{view.progress}%</div>
      </div>}
      {!!view.fields?.length && <dl style={{ margin: "8px 0 0", display: "grid", gridTemplateColumns: "minmax(90px, auto) 1fr", gap: "4px 10px", fontSize: 12 }}>
        {view.fields.map((field, index) => <React.Fragment key={`${field.label}:${index}`}>
          <dt style={{ color: "var(--text3)" }}>{field.label}</dt><dd style={{ margin: 0, color: "var(--text2)", overflowWrap: "anywhere" }}>{field.value}</dd>
        </React.Fragment>)}
      </dl>}
      {!!view.items?.length && <ol aria-label={view.layout === "table" ? "Widget details" : "Widget items"} style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
        {view.items.map((item, index) => <li key={`${item.title}:${index}`} style={{ display: "grid", gridTemplateColumns: view.layout === "table" ? "minmax(100px, 0.7fr) 1fr" : "1fr auto", gap: 8, alignItems: "baseline", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
          <span style={{ color: "var(--text1)", fontSize: 12, fontWeight: 550, overflowWrap: "anywhere" }}>{item.title}</span>
          <span style={{ color: item.status ? statusColor[item.status] : "var(--text2)", fontSize: 11, overflowWrap: "anywhere", textAlign: "right" }}>
            {item.detail ?? item.status ?? ""}{item.detail && item.status ? ` · ${item.status}` : ""}
          </span>
        </li>)}
      </ol>}
    </section>
  );
}
