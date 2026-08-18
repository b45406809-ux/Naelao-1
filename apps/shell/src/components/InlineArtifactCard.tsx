"use client";

// Step 5/7/11: an inline preview of an artifact the assistant CREATED this turn — like Claude
// showing an artifact in the chat. HTML renders in a sandboxed iframe; other text renders in a
// scrollable <pre>; everything is downloadable. Rendered directly under the assistant reply (not
// buried in the side-panel Artifacts tab), and — for artifacts.create — this is what shows on
// SUCCESS instead of the tool-call table (step 11).

import * as React from "react";
import { getArtifact, type ArtifactContent, type SessionCredentials } from "@/lib/api";

function isHtml(a: { content_type?: string | undefined; filename: string }): boolean {
  return (a.content_type ?? "").includes("html") || /\.html?$/i.test(a.filename);
}

export function InlineArtifactCard({
  spaceId,
  artifactId,
  filename,
  contentType,
  session,
}: {
  spaceId: string;
  artifactId: string;
  filename: string;
  contentType?: string;
  session: SessionCredentials;
}) {
  const [detail, setDetail] = React.useState<ArtifactContent | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [expanded, setExpanded] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    getArtifact(spaceId, artifactId, session)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [spaceId, artifactId, session]);

  const html = detail ? isHtml({ content_type: detail.content_type, filename: detail.filename }) : isHtml({ content_type: contentType, filename });

  function download() {
    if (!detail?.content) return;
    const blob = new Blob([detail.content], { type: detail.content_type || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className="inline-artifact-card"
      style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", marginTop: 8, background: "var(--surface1, var(--bg))" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--surface2, #f9f8f5)", borderBottom: expanded ? "1px solid var(--border)" : "none" }}>
        <span style={{ fontSize: 14 }}>📄</span>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--text1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{filename}</span>
        <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11.5 }} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Hide" : "Preview"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11.5 }} disabled={!detail?.content} onClick={download}>
          Download
        </button>
      </div>
      {expanded && (
        <div>
          {failed ? (
            <div style={{ padding: 16, fontSize: 12.5, color: "var(--text3)" }}>Couldn&apos;t load this artifact.</div>
          ) : !detail ? (
            <div style={{ padding: 16, fontSize: 12.5, color: "var(--text3)" }}>Loading preview…</div>
          ) : detail.too_large || detail.binary || !detail.content ? (
            <div style={{ padding: 16, fontSize: 12.5, color: "var(--text3)" }}>
              {detail.binary ? "Binary file — download to open it." : "This file is too large to preview inline — download it to view."}
            </div>
          ) : html ? (
            <iframe
              title={filename}
              sandbox="allow-scripts allow-same-origin"
              srcDoc={detail.content}
              style={{ width: "100%", height: 360, border: "none", background: "#fff" }}
            />
          ) : (
            <pre style={{ margin: 0, padding: 12, maxHeight: 360, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text1)" }}>
              {detail.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
