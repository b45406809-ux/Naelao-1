import type { DaemonSql } from "./durable-daemon.js";

export interface SourceFile { path: string; content: string }
export interface AstSymbol { name: string; kind: "function" | "class" | "interface" | "method" | "type"; filePath: string; startLine: number; endLine: number; signature: string; docstring: string | null }
export interface IdentifierOccurrence { name: string; filePath: string; line: number; column: number }

/** Finds identifier tokens while skipping ordinary comments and quoted strings. This is a
 *  bounded lexical reference aid, not a language-server symbol resolver: shadowing, property
 *  binding and template-string expressions are not semantically classified. */
export function extractIdentifierOccurrences(file: SourceFile): IdentifierOccurrence[] {
  if (!/\.(?:[cm]?[jt]sx?|py)$/.test(file.path)) return [];
  const python = file.path.endsWith(".py"), text = file.content, out: IdentifierOccurrence[] = [];
  let line = 1, column = 1, blockComment = false, quote = "";
  for (let i = 0; i < text.length;) {
    const ch = text[i]!, next = text[i + 1] ?? "";
    if (ch === "\n") { line++; column = 1; i++; if (quote.length === 1) quote = ""; continue; }
    if (blockComment) { if (ch === "*" && next === "/") { blockComment = false; i += 2; column += 2; } else { i++; column++; } continue; }
    if (quote) {
      if (quote.length === 3 && text.slice(i, i + 3) === quote) { quote = ""; i += 3; column += 3; continue; }
      if (ch === "\\") {
        i++; column++;
        if (text[i] === "\n") { i++; line++; column = 1; }
        else if (i < text.length) { i++; column++; }
        continue;
      }
      if (quote.length === 1 && ch === quote) quote = "";
      i++; column++; continue;
    }
    if (ch === "/" && next === "/" && !python) { while (i < text.length && text[i] !== "\n") { i++; column++; } continue; }
    if (ch === "#" && python) { while (i < text.length && text[i] !== "\n") { i++; column++; } continue; }
    if (ch === "/" && next === "*" && !python) { blockComment = true; i += 2; column += 2; continue; }
    if ((ch === "'" || ch === '"') && python && text.slice(i, i + 3) === ch.repeat(3)) { quote = ch.repeat(3); i += 3; column += 3; continue; }
    if (ch === "'" || ch === '"' || ch === "`" && !python) { quote = ch; i++; column++; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i, startColumn = column;
      while (i < text.length && /[A-Za-z0-9_$]/.test(text[i]!)) { i++; column++; }
      out.push({ name: text.slice(start, i), filePath: file.path, line, column: startColumn });
      continue;
    }
    i++; column++;
  }
  return out;
}

function blockEnd(lines: string[], start: number, python: boolean): number {
  if (python) {
    const indent = lines[start]!.match(/^\s*/)?.[0].length ?? 0;
    let end = start;
    for (let i = start + 1; i < lines.length; i++) { const line = lines[i]!; if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= indent) break; if (line.trim()) end = i; }
    return end + 1;
  }
  let depth = 0, opened = false;
  for (let i = start; i < lines.length; i++) for (const char of lines[i]!) { if (char === "{") { depth++; opened = true; } else if (char === "}") depth--; if (opened && depth === 0) return i + 1; }
  return start + 1;
}

/**
 * Lightweight isolate-safe lexical symbol heuristic. Despite the legacy TreeSitterIndexer /
 * ast_symbols names, this is not a syntax parser: it does not validate grammar or support safe
 * semantic merges. Its index is advisory only; merge acceptance remains deterministic tests,
 * repository CAS, or human review.
 */
export function extractSymbols(file: SourceFile): AstSymbol[] {
  if (!/\.(?:[cm]?[jt]sx?|py)$/.test(file.path)) return [];
  const lines = file.content.split(/\r?\n/); const python = file.path.endsWith(".py"); const out: AstSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!; let match: RegExpMatchArray | null = null; let kind: AstSymbol["kind"] | null = null;
    if (python) { match = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*(\([^)]*\)(?:\s*->\s*[^:]+)?):/) ; kind = match ? ((line.match(/^\s*/)?.[0].length ?? 0) ? "method" : "function") : null; if (!match) { match = line.match(/^\s*class\s+([A-Za-z_]\w*)\s*(\([^)]*\))?\s*:/); kind = match ? "class" : null; } }
    else {
      match = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\)(?:\s*:\s*[^={]+)?)/); kind = match ? "function" : null;
      if (!match) { match = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)[^\{]*/); kind = match ? "class" : null; }
      if (!match) { match = line.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)[^\{]*/); kind = match ? "interface" : null; }
      if (!match) { match = line.match(/^\s*export\s+type\s+([A-Za-z_$][\w$]*)\s*=/); kind = match ? "type" : null; }
      if (!match) { match = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/); kind = match ? "function" : null; }
    }
    if (!match || !kind) continue;
    let docstring: string | null = null; const previous = lines[i - 1]?.trim(); if (previous?.startsWith("//")) docstring = previous.replace(/^\/\/\s?/, "");
    if (python && lines[i + 1]?.trim().match(/^(?:'''|\"\"\")/)) docstring = lines[i + 1]!.trim().replace(/^(?:'''|\"\"\")|(?:'''|\"\"\")$/g, "");
    out.push({ name: match[1]!, kind, filePath: file.path, startLine: i + 1, endLine: blockEnd(lines, i, python), signature: line.trim().replace(/\s*\{\s*$/, ""), docstring });
  }
  return out;
}

export class TreeSitterIndexer {
  constructor(private readonly sql: DaemonSql) { sql.exec(`CREATE TABLE IF NOT EXISTS ast_symbols (name TEXT NOT NULL,kind TEXT NOT NULL,file_path TEXT NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,signature TEXT NOT NULL,docstring TEXT,PRIMARY KEY(file_path,name,start_line)); CREATE INDEX IF NOT EXISTS idx_ast_symbols_name ON ast_symbols(name); CREATE TABLE IF NOT EXISTS ast_references (name TEXT NOT NULL,file_path TEXT NOT NULL,line INTEGER NOT NULL,column_no INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_ast_references_name ON ast_references(name);`); }
  index(files: SourceFile[], replace = false): { files: number; symbols: number } {
    let count = 0;
    if (replace) { this.sql.exec("DELETE FROM ast_symbols"); this.sql.exec("DELETE FROM ast_references"); }
    for (const file of files) {
      this.sql.exec("DELETE FROM ast_symbols WHERE file_path = ?", file.path);
      this.sql.exec("DELETE FROM ast_references WHERE file_path = ?", file.path);
      for (const symbol of extractSymbols(file)) { this.sql.exec("INSERT INTO ast_symbols(name,kind,file_path,start_line,end_line,signature,docstring) VALUES (?,?,?,?,?,?,?)", symbol.name,symbol.kind,symbol.filePath,symbol.startLine,symbol.endLine,symbol.signature,symbol.docstring); count++; }
      for (const ref of extractIdentifierOccurrences(file).slice(0, 10_000)) this.sql.exec("INSERT INTO ast_references(name,file_path,line,column_no) VALUES (?,?,?,?)", ref.name, ref.filePath, ref.line, ref.column);
    }
    return { files: files.length, symbols: count };
  }
  async query(term: string): Promise<AstSymbol[]> { return [...this.sql.exec("SELECT name,kind,file_path AS filePath,start_line AS startLine,end_line AS endLine,signature,docstring FROM ast_symbols WHERE name = ? ORDER BY file_path,start_line LIMIT 100", term)] as unknown as AstSymbol[]; }
  async symbols(path: string): Promise<AstSymbol[]> { return [...this.sql.exec("SELECT name,kind,file_path AS filePath,start_line AS startLine,end_line AS endLine,signature,docstring FROM ast_symbols WHERE file_path = ? ORDER BY start_line LIMIT 1000", path)] as unknown as AstSymbol[]; }
  async references(term: string): Promise<IdentifierOccurrence[]> { return [...this.sql.exec("SELECT name,file_path AS filePath,line,column_no AS columnNumber FROM ast_references WHERE name = ? ORDER BY file_path,line,column_no LIMIT 500", term)] as unknown as IdentifierOccurrence[]; }
  status(): { parser: string; semanticReferences: false } { return { parser: "bounded lexical symbol/indexer", semanticReferences: false }; }
}
