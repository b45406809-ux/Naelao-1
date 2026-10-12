"use client";
import React from "react";
import { ansiSegments, terminalText } from "../lib/terminal-output";

export function TerminalStreamBlock({ command, output, failed, active }: { command?: string | undefined; output?: string | undefined; failed?: boolean; active?: boolean }) {
  return <div role="log" aria-label="Command output" aria-live={active ? "polite" : "off"} style={{ background: "#111827", color: "#e5e7eb", borderRadius: 8, padding: 10, fontFamily: "var(--font-mono, monospace)", fontSize: 11.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
    {command && <div style={{ color: "#34d399" }}>$ {command}</div>}
    {output && <div style={{ color: failed ? "#f87171" : undefined }}>{ansiSegments(terminalText(output)).map((segment, i) => <span key={i} style={{ color: segment.color, fontWeight: segment.bold ? 700 : undefined }}>{segment.text}</span>)}</div>}
    {active && <span aria-label="Running">▍</span>}
  </div>;
}
