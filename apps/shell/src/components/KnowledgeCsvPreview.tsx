"use client";

import * as React from "react";

const MAX_PREVIEW_ROWS = 201; // header plus 200 rows
const MAX_PREVIEW_COLUMNS = 40;
const MAX_PREVIEW_CELL_CHARS = 256;

export interface KnowledgeCsvPreviewResult {
  rows: string[][];
  truncatedRows: boolean;
  truncatedColumns: boolean;
  truncatedCells: boolean;
  malformedQuotes: boolean;
}

/** Bounded display parser only. The original CSV remains the editable source sent to Knowledge. */
export function parseKnowledgeCsvPreview(text: string): KnowledgeCsvPreviewResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let malformedQuotes = false;
  let truncatedRows = false;
  let truncatedColumns = false;
  let truncatedCells = false;
  const pushField = () => {
    if (row.length < MAX_PREVIEW_COLUMNS) {
      row.push(field.slice(0, MAX_PREVIEW_CELL_CHARS));
      if (field.length > MAX_PREVIEW_CELL_CHARS) truncatedCells = true;
    } else truncatedColumns = true;
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (rows.length < MAX_PREVIEW_ROWS) rows.push(row);
    else truncatedRows = true;
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ",") pushField();
    else if (char === "\n") pushRow();
    else if (char !== "\r") field += char;
  }
  if (quoted) malformedQuotes = true;
  if (field.length > 0 || row.length > 0) pushRow();
  return { rows, truncatedRows, truncatedColumns, truncatedCells, malformedQuotes };
}

export function KnowledgeCsvPreview({ content }: { content: string }) {
  const parsed = React.useMemo(() => parseKnowledgeCsvPreview(content), [content]);
  if (!content) return null;
  const [head = [], ...body] = parsed.rows;
  return (
    <details style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, fontSize: 12 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>CSV table preview · values shown as text</summary>
      <p style={{ color: "var(--text3)" }}>The editable text above remains the source. This preview does not infer number types or execute spreadsheet formulas.</p>
      {parsed.malformedQuotes && <p role="alert">A quoted field is not closed. Review the original CSV text before adding it.</p>}
      {(parsed.truncatedRows || parsed.truncatedColumns || parsed.truncatedCells) &&
        <p role="status">Preview limits reached: {[
          parsed.truncatedRows && "showing up to 200 data rows",
          parsed.truncatedColumns && "showing up to 40 columns",
          parsed.truncatedCells && "cell display clipped to 256 characters",
        ].filter(Boolean).join("; ")}. The source text is unchanged.</p>}
      {head.length > 0 && <div style={{ maxHeight: 280, overflow: "auto" }}>
        <table style={{ borderCollapse: "collapse", minWidth: "100%" }}>
          <thead><tr>{head.map((value, index) => <th key={index} scope="col" style={{ borderBottom: "1px solid var(--border)", padding: 6, textAlign: "left" }}>{value || `Column ${index + 1}`}</th>)}</tr></thead>
          <tbody>{body.map((cells, rowIndex) => <tr key={rowIndex}>
            {head.map((_, columnIndex) => <td key={columnIndex} style={{ borderBottom: "1px solid var(--border)", padding: 6, whiteSpace: "pre-wrap" }}>{cells[columnIndex] ?? ""}</td>)}
          </tr>)}</tbody>
        </table>
      </div>}
    </details>
  );
}
