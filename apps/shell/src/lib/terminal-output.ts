export function terminalText(text: string): string {
  let value: unknown; try { value = JSON.parse(text); } catch { return text; }
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return text;
  const row = value as Record<string, unknown>;
  if (row._truncated && typeof row.preview === "string") return `${row.preview}\n${row.instruction ?? ""}`;
  const streams = [row.stdout, row.stderr].filter((s): s is string => typeof s === "string");
  if (streams.length) return streams.join("\n");
  for (const key of ["result", "output"]) if (row[key] !== undefined) return terminalText(typeof row[key] === "string" ? row[key] : JSON.stringify(row[key]));
  return text;
}
export interface AnsiSegment { text: string; color?: string | undefined; bold: boolean }
const colors = ["#111827", "#f87171", "#34d399", "#fbbf24", "#60a5fa", "#c084fc", "#22d3ee", "#e5e7eb"];
/** Render only text and bounded SGR styling. OSC hyperlinks and cursor controls carry no authority. */
export function ansiSegments(input: string): AnsiSegment[] {
  const text = input.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
  const segments: AnsiSegment[] = []; let color: string | undefined, bold = false, offset = 0;
  for (const match of text.matchAll(/\x1b\[([\d;]*)([A-Za-z])/g)) {
    if (match.index! > offset) segments.push({ text: text.slice(offset, match.index).replace(/\x1b/g, ""), color, bold });
    if (match[2] === "m") for (const code of (match[1] || "0").split(";").map(Number)) {
      if (code === 0) { color = undefined; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = undefined;
      else if (code >= 30 && code <= 37) color = colors[code - 30];
      else if (code >= 90 && code <= 97) color = colors[code - 90];
    }
    offset = match.index! + match[0].length;
  }
  segments.push({ text: text.slice(offset).replace(/\x1b(?:\[[\d;]*)?$/g, "").replace(/\x1b/g, ""), color, bold });
  return segments;
}
