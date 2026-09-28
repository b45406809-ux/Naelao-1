"use client";
import * as React from "react";
import { validateGeneratedWidget, type GeneratedWidget as Widget } from "@naelao/agent-sdk";

export function GeneratedWidget({ value }: { value: unknown }) {
  let widget: Widget;
  try { widget = validateGeneratedWidget(value); } catch { return <div role="alert" className="bubble">Unsafe or invalid widget was blocked.</div>; }
  const emit = (value: unknown) => window.dispatchEvent(new CustomEvent("naelao:widget-action", { detail: { widgetId: widget.id, value } }));
  if (widget.type === "datetime") return <label>{widget.label}<input type="datetime-local" defaultValue={widget.value} min={widget.min} max={widget.max} onChange={e => emit(e.currentTarget.value)}/></label>;
  if (widget.type === "range") return <label>{widget.label}<input type="range" min={widget.min} max={widget.max} step={widget.step} defaultValue={widget.value} onChange={e => emit(Number(e.currentTarget.value))}/></label>;
  if (widget.type === "multi_select") return <fieldset><legend>{widget.label}</legend>{widget.options.map(option => <label key={option} style={{ display: "inline-flex", margin: 4 }}><input type="checkbox" defaultChecked={widget.selected?.includes(option)} onChange={e => emit({ option, selected: e.currentTarget.checked })}/>{option}</label>)}</fieldset>;
  if (widget.type === "decision_table") return <DecisionTable widget={widget}/>;
  return <article className="card" style={{ padding: 12 }}><strong>{widget.title}</strong>{widget.description && <p>{widget.description}</p>}{widget.progress !== undefined && <progress value={widget.progress} max={100}/>}<button className="btn btn-primary btn-sm" onClick={() => emit(widget.action)}>{widget.action === "approve" ? "Approve" : "Rollback"}</button></article>;
}
function DecisionTable({ widget }: { widget: Extract<Widget, { type: "decision_table" }> }) { const [query, setQuery] = React.useState(""), [sort, setSort] = React.useState(widget.columns[0] ?? ""); const rows = [...widget.rows].filter(r => JSON.stringify(r).toLowerCase().includes(query.toLowerCase())).sort((a,b) => String(a[sort] ?? "").localeCompare(String(b[sort] ?? ""))); return <div><input aria-label="Filter comparison" placeholder="Filter" value={query} onChange={e => setQuery(e.currentTarget.value)}/><table><thead><tr>{widget.columns.map(c => <th key={c}><button type="button" onClick={() => setSort(c)}>{c}</button></th>)}</tr></thead><tbody>{rows.map((row,i) => <tr key={i}>{widget.columns.map(c => <td key={c}>{String(row[c] ?? "")}</td>)}</tr>)}</tbody></table></div>; }
