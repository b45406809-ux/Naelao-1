"use client";

// Step 4: a multi-format file viewer for the Files panels — PDF, images, and Office documents
// text/html/markdown/csv. PDFs and images use native browser rendering. Office archive binaries are
// offered as downloads instead of parsing untrusted ZIP/XML content in the user's browser.

import * as React from "react";
import { Markdown } from "@/components/Markdown";
import { HtmlPreviewFrame } from "@/components/HtmlPreviewFrame";
import type { WorkspaceFileContent } from "@/lib/api";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function ext(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

/** Simple CSV → rows. Handles quoted fields and embedded commas/newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function TableView({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return <p style={{ fontSize: 11.5, color: "var(--text3)" }}>Empty.</p>;
  const [head, ...body] = rows;
  return (
    <div style={{ maxHeight: 300, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
      <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%" }}>
        <thead>
          <tr>
            {head!.map((h, i) => (
              <th key={i} style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border)", background: "var(--surface2)", position: "sticky", top: 0, whiteSpace: "nowrap" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, 500).map((r, ri) => (
            <tr key={ri}>
              {r.map((cell, ci) => (
                <td key={ci} style={{ padding: "3px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** PDF via a blob URL in an iframe — the browser's own native PDF viewer, no library. */
function PdfView({ content }: { content: string }) {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    const blob = new Blob([base64ToBytes(content) as unknown as BlobPart], { type: "application/pdf" });
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [content]);
  if (!url) return null;
  return <iframe title="PDF" src={url} style={{ width: "100%", height: 340, border: "1px solid var(--border)", borderRadius: 6, background: "#fff" }} />;
}

export function FileViewer({
  file,
  interactive = false,
}: {
  file: WorkspaceFileContent;
  /** AVOS plan step 6 — turns on click-to-inspect for an HTML preview (see HtmlPreviewFrame's own
   *  header for why this is opt-in: only a caller that knows a Chat.tsx listener is mounted
   *  nearby should turn it on). */
  interactive?: boolean;
}) {
  if (file.too_large) {
    return <p style={{ color: "var(--text3)", fontSize: 11.5, margin: 0 }}>Too large to preview inline.</p>;
  }

  // Binary (base64) types. No hooks here — each sub-view owns its own so the rules of hooks hold
  // regardless of which branch renders.
  if (file.encoding === "base64" && file.content) {
    const ct = file.content_type ?? "";
    const dataUrl = `data:${ct};base64,${file.content}`;
    if (ct === "application/pdf") return <PdfView content={file.content} />;
    if (ct.startsWith("image/")) {
      return <img src={dataUrl} alt={file.path} style={{ maxWidth: "100%", maxHeight: 340, borderRadius: 6, display: "block" }} />;
    }
    // A known-binary type we can't render inline (e.g. .pptx) — offer the raw bytes to save.
    return (
      <div style={{ fontSize: 11.5, color: "var(--text3)" }}>
        <p style={{ margin: "0 0 6px" }}>Preview isn&rsquo;t available for this file type.</p>
        <a href={dataUrl} download={file.path.split("/").pop()} style={{ color: "var(--accent)" }}>Download to view</a>
      </div>
    );
  }

  // Text types.
  const e = ext(file.path);
  const text = file.content ?? "";
  if (e === "html" || e === "htm") {
    return <HtmlPreviewFrame html={text} title={file.path} interactive={interactive} />;
  }
  if (e === "md" || e === "markdown") {
    return <div style={{ maxHeight: 300, overflow: "auto", fontSize: 12 }}><Markdown text={text} /></div>;
  }
  if (e === "csv" || e === "tsv") {
    return <TableView rows={parseCsv(e === "tsv" ? text.replace(/\t/g, ",") : text)} />;
  }
  return <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 300, overflow: "auto", margin: 0 }}>{text}</pre>;
}
