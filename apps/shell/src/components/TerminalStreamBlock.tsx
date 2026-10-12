"use client";
import React from "react";
import { ansiSegments, foldTerminalOutput, terminalText } from "../lib/terminal-output";

export function TerminalStreamBlock({ command, output, failed, active }: { command?: string | undefined; output?: string | undefined; failed?: boolean; active?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const cleaned = React.useMemo(() => terminalText(output ?? ""), [output]);
  const folded = React.useMemo(() => foldTerminalOutput(cleaned), [cleaned]);
  const shouldFold = folded.folded && !active;
  const visibleOutput = shouldFold && !expanded ? folded.preview : cleaned;
  return <div role="log" aria-label="Command output" aria-live={active ? "polite" : "off"} style={{ background: "#111827", color: "#e5e7eb", borderRadius: 8, padding: 10, fontFamily: "var(--font-mono, monospace)", fontSize: 11.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
    {command && <div style={{ color: "#34d399" }}>$ {command}</div>}
    {output && <div style={{ color: failed ? "#f87171" : undefined }}>{ansiSegments(visibleOutput).map((segment, i) => <span key={i} style={{ color: segment.color, fontWeight: segment.bold ? 700 : undefined }}>{segment.text}</span>)}</div>}
    {shouldFold && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} style={{ display: "block", marginTop: 8, color: "#93c5fd", background: "transparent", border: 0, padding: 0, font: "inherit", cursor: "pointer" }}>
      {expanded ? "Fold full output" : `Output folded · ${folded.hiddenLines.toLocaleString()} lines hidden · show full output`}
    </button>}
    {active && <span aria-label="Running">▍</span>}
  </div>;
}
