"use client";

import * as React from "react";
import type { ViewportProps } from "./DomainCanvases";

const columnName = (index: number) => String.fromCharCode(65 + index);
function parseTable(content: string): string[][] {
  return content.split(/\r?\n/).filter(Boolean).map(row => row.split(content.includes("\t") ? "\t" : ","));
}

export function SpreadsheetFormulaGrid({ files, selected, onSelect, onAction }: ViewportProps) {
  const sourceRows = React.useMemo(() => parseTable(selected?.content ?? ""), [selected?.content]);
  const [cells, setCells] = React.useState<Record<string, string>>({});
  const [active, setActive] = React.useState("A1");
  React.useEffect(() => {
    const next: Record<string, string> = {};
    sourceRows.forEach((row, y) => row.forEach((value, x) => { next[`${columnName(x)}${y + 1}`] = value; }));
    setCells(next);
  }, [sourceRows]);
  const columns = Math.max(8, ...sourceRows.map(row => row.length));
  const rows = Math.max(16, sourceRows.length);
  const update = (value: string) => { setCells(current => ({ ...current, [active]: value })); onAction("spreadsheet.update_cell", { path: selected?.path ?? "", cell: active, value }); };

  return <div className="formula-grid" data-testid="spreadsheet-formula-grid">
    <div className="formula-toolbar">
      <select aria-label="Spreadsheet file" value={selected?.path ?? ""} onChange={e => onSelect(e.target.value)}><option value="">Select spreadsheet</option>{files.map(file => <option key={file.path}>{file.path}</option>)}</select>
      <strong>{active}</strong><span>ƒx</span><input aria-label="Formula bar" value={cells[active] ?? ""} onChange={e => update(e.target.value)} placeholder="Enter a value or =formula" />
      <span className="live-indicator">● Live</span>
    </div>
    <div className="grid-scroll"><table><thead><tr><th />{Array.from({ length: columns }, (_, x) => <th key={x}>{columnName(x)}</th>)}</tr></thead><tbody>{Array.from({ length: rows }, (_, y) => <tr key={y}><th>{y + 1}</th>{Array.from({ length: columns }, (_, x) => { const address = `${columnName(x)}${y + 1}`; return <td key={address} className={active === address ? "active" : ""} onClick={() => setActive(address)}>{cells[address] ?? ""}</td>; })}</tr>)}</tbody></table></div>
  </div>;
}
