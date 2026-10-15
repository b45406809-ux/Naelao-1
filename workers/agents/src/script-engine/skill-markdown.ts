export type SkillReadOptions =
  | { mode: "full" }
  | { mode: "toc" }
  | { mode: "section"; section: string }
  | { mode: "lines"; start: number; end: number };

export const MAX_SKILL_MANUAL_CHARS = 128_000;
export const MAX_SKILL_READ_LINES = 400;
export const MAX_SKILL_HEADINGS = 200;

export function parseSkillReadOptions(args: readonly string[]): SkillReadOptions {
  if (!args.length) return { mode: "full" };
  if ((args.length === 1 && ["--toc", "--headers"].includes(args[0]!))) return { mode: "toc" };
  if (args.length === 2 && args[0] === "--section" && args[1]!.trim()) return { mode: "section", section: args[1]!.trim() };
  if (args.length === 2 && args[0] === "--lines") {
    const match = args[1]!.match(/^(\d+)-(\d+)$/);
    const start = match ? Number(match[1]) : 0, end = match ? Number(match[2]) : 0;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > MAX_SKILL_READ_LINES) {
      throw new Error(`skill_lines_invalid: use --lines START-END for at most ${MAX_SKILL_READ_LINES} lines`);
    }
    return { mode: "lines", start, end };
  }
  throw new Error("usage: skill read <name> [--toc|--headers|--section <heading>|--lines START-END]");
}

interface Heading { depth: number; title: string; line: number; }

function markdownHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0] as "`" | "~", length = fenceMatch[1]!.length;
      if (!fence) fence = { marker, length };
      else if (fence.marker === marker && length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (match) headings.push({ depth: match[1]!.length, title: match[2]!.trim(), line: index + 1 });
  }
  return headings;
}

export function markdownTableOfContents(markdown: string): { text: string; totalHeadings: number } {
  const headings = markdownHeadings(markdown);
  const visible = headings.slice(0, MAX_SKILL_HEADINGS);
  const rows = visible.map(heading => `${"  ".repeat(heading.depth - 1)}${heading.line}. ${"#".repeat(heading.depth)} ${heading.title}`);
  if (headings.length > visible.length) rows.push(`… ${headings.length - visible.length} additional headings omitted`);
  return { text: rows.join("\n"), totalHeadings: headings.length };
}

export function markdownSection(markdown: string, query: string): { text?: string; matches: string[] } {
  const headings = markdownHeadings(markdown);
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const target = normalize(query);
  if (!target) return { matches: [] };
  const exact = headings.filter(heading => normalize(heading.title) === target);
  const matches = exact.length ? exact : headings.filter(heading => normalize(heading.title).includes(target) || target.includes(normalize(heading.title)));
  if (matches.length !== 1) return { matches: matches.slice(0, 20).map(heading => `${heading.line}: ${heading.title}`) };

  const selected = matches[0]!;
  const lines = markdown.split(/\r?\n/);
  const nextHeading = headings.find(heading => heading.line > selected.line && heading.depth <= selected.depth);
  const end = nextHeading ? nextHeading.line - 1 : lines.length;
  return { text: lines.slice(selected.line - 1, end).join("\n").trim(), matches: [] };
}

export function skillLineWindow(content: string, start: number, end: number): { text: string; totalLines: number } {
  const lines = content.split(/\r?\n/);
  return { text: lines.slice(start - 1, end).join("\n"), totalLines: lines.length };
}
