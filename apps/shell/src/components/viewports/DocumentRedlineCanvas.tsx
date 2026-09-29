"use client";

import * as React from "react";
import type { ViewportProps } from "./DomainCanvases";

type Segment = { kind: "plain" | "addition" | "deletion"; text: string };

function redline(source: string): Segment[] {
  const parts: Segment[] = [];
  const pattern = /(\+\+[\s\S]*?\+\+|~~[\s\S]*?~~)/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > offset) parts.push({ kind: "plain", text: source.slice(offset, index) });
    const token = match[0];
    parts.push({ kind: token.startsWith("++") ? "addition" : "deletion", text: token.slice(2, -2) });
    offset = index + token.length;
  }
  if (offset < source.length) parts.push({ kind: "plain", text: source.slice(offset) });
  return parts;
}

export function DocumentRedlineCanvas({ files, selected, onSelect, onAction }: ViewportProps) {
  const clauses = React.useMemo(() => (selected?.content ?? "").split(/\n\s*\n/).filter(Boolean), [selected?.content]);
  const [decisions, setDecisions] = React.useState<Record<number, "accepted" | "rejected">>({});
  React.useEffect(() => setDecisions({}), [selected?.path, selected?.content]);

  return <div className="document-redline" data-testid="document-redline-canvas">
    <aside className="canvas-file-list" aria-label="Document files">
      {files.map(file => <button key={file.path} type="button" className={selected?.path === file.path ? "active" : ""} onClick={() => onSelect(file.path)}>{file.path}</button>)}
    </aside>
    <article className="redline-page">
      {!selected && <p className="canvas-empty">Select a document to review its redline.</p>}
      {clauses.map((clause, index) => <section className={`redline-clause ${decisions[index] ?? ""}`} key={`${index}-${clause.slice(0, 20)}`}>
        <div className="redline-columns">
          <div><span className="canvas-eyebrow">Original</span><p>{redline(clause).filter(s => s.kind !== "addition").map((s, i) => s.kind === "deletion" ? <del key={i}>{s.text}</del> : <React.Fragment key={i}>{s.text}</React.Fragment>)}</p></div>
          <div><span className="canvas-eyebrow">Proposed</span><p>{redline(clause).filter(s => s.kind !== "deletion").map((s, i) => s.kind === "addition" ? <ins key={i}>{s.text}</ins> : <React.Fragment key={i}>{s.text}</React.Fragment>)}</p></div>
        </div>
        <div className="clause-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(decisions[index])} onClick={() => { setDecisions(d => ({ ...d, [index]: "accepted" })); onAction("redline.accept_clause", { path: selected?.path ?? "", clauseIndex: index }); }}>Accept</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(decisions[index])} onClick={() => { setDecisions(d => ({ ...d, [index]: "rejected" })); onAction("redline.reject_clause", { path: selected?.path ?? "", clauseIndex: index }); }}>Reject</button>
          {decisions[index] && <span aria-live="polite">{decisions[index]}</span>}
        </div>
      </section>)}
    </article>
  </div>;
}
