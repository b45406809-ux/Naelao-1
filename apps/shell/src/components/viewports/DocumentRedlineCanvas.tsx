"use client";

import * as React from "react";
import { documentClauseNodeId } from "@naelao/agent-sdk";
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

export function DocumentRedlineCanvas({ files, selected, onSelect, onAction, onLease }: ViewportProps) {
  const clauses = React.useMemo(() => (selected?.content ?? "").split(/\n\s*\n/).filter(Boolean), [selected?.content]);
  const [decisions, setDecisions] = React.useState<Record<number, "accepted" | "rejected">>({});
  const [leaseState, setLeaseState] = React.useState<Record<number, string>>({});
  const renewals = React.useRef(new Map<number, number>());
  const pending = React.useRef(new Set<number>());
  React.useEffect(() => setDecisions({}), [selected?.path, selected?.content]);

  const nodeId = (index: number) => documentClauseNodeId(selected?.path ?? "", index);
  const claimNode = (index: number) => {
    if (!selected || !onLease || pending.current.has(index) || renewals.current.has(index)) return;
    pending.current.add(index);
    const id = nodeId(index);
    void onLease("claim", id).then(result => {
      if (result.acquired) {
        setLeaseState(state => ({ ...state, [index]: "You are editing this clause" }));
        renewals.current.set(index, window.setInterval(() => { void onLease("renew", id); }, 8_000));
      } else setLeaseState(state => ({ ...state, [index]: result.error_code === "node_lease_conflict" ? "This clause is being edited elsewhere" : "Edit lock unavailable" }));
    }).catch(() => setLeaseState(state => ({ ...state, [index]: "Edit lock unavailable" }))).finally(() => pending.current.delete(index));
  };
  const releaseNode = (index: number) => {
    const timer = renewals.current.get(index);
    if (timer !== undefined) window.clearInterval(timer);
    renewals.current.delete(index);
    if (selected && onLease) void onLease("release", nodeId(index)).catch(() => undefined);
    setLeaseState(state => { const next = { ...state }; delete next[index]; return next; });
  };
  React.useEffect(() => () => {
    for (const [index, timer] of renewals.current) {
      window.clearInterval(timer);
      if (selected && onLease) void onLease("release", nodeId(index)).catch(() => undefined);
    }
    renewals.current.clear();
  }, [selected?.path, onLease]);

  return <div className="document-redline" data-testid="document-redline-canvas">
    <aside className="canvas-file-list" aria-label="Document files">
      {files.map(file => <button key={file.path} type="button" className={selected?.path === file.path ? "active" : ""} onClick={() => onSelect(file.path)}>{file.path}</button>)}
    </aside>
    <article className="redline-page">
      {!selected && <p className="canvas-empty">Select a document to review its redline.</p>}
      {clauses.map((clause, index) => <section className={`redline-clause ${decisions[index] ?? ""}`} key={`${index}-${clause.slice(0, 20)}`} tabIndex={0} onPointerEnter={() => claimNode(index)} onPointerLeave={event => { if (!event.currentTarget.contains(document.activeElement)) releaseNode(index); }} onFocus={() => claimNode(index)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) releaseNode(index); }}>
        <div className="redline-columns">
          <div><span className="canvas-eyebrow">Original</span><p>{redline(clause).filter(s => s.kind !== "addition").map((s, i) => s.kind === "deletion" ? <del key={i}>{s.text}</del> : <React.Fragment key={i}>{s.text}</React.Fragment>)}</p></div>
          <div><span className="canvas-eyebrow">Proposed</span><p>{redline(clause).filter(s => s.kind !== "deletion").map((s, i) => s.kind === "addition" ? <ins key={i}>{s.text}</ins> : <React.Fragment key={i}>{s.text}</React.Fragment>)}</p></div>
        </div>
        <div className="clause-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(decisions[index])} onClick={() => { setDecisions(d => ({ ...d, [index]: "accepted" })); onAction("redline.accept_clause", { path: selected?.path ?? "", clauseIndex: index, nodeId: nodeId(index) }); }}>Accept</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(decisions[index])} onClick={() => { setDecisions(d => ({ ...d, [index]: "rejected" })); onAction("redline.reject_clause", { path: selected?.path ?? "", clauseIndex: index, nodeId: nodeId(index) }); }}>Reject</button>
          {decisions[index] && <span aria-live="polite">{decisions[index]}</span>}
        </div>
        {leaseState[index] && <span aria-live="polite" className="canvas-eyebrow">{leaseState[index]}</span>}
      </section>)}
    </article>
  </div>;
}
