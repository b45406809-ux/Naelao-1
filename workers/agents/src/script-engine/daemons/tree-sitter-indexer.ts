import type { DaemonSql } from "./durable-daemon.js";

export interface SourceFile { path: string; content: string }
export interface AstSymbol { name: string; kind: "function" | "class" | "interface" | "method" | "type"; filePath: string; startLine: number; endLine: number; signature: string; docstring: string | null }

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

/** Lightweight isolate-safe AST symbol parser; its ABI permits replacement by web-tree-sitter WASM. */
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
  constructor(private readonly sql: DaemonSql) { sql.exec(`CREATE TABLE IF NOT EXISTS ast_symbols (name TEXT NOT NULL,kind TEXT NOT NULL,file_path TEXT NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,signature TEXT NOT NULL,docstring TEXT,PRIMARY KEY(file_path,name,start_line)); CREATE INDEX IF NOT EXISTS idx_ast_symbols_name ON ast_symbols(name);`); }
  index(files: SourceFile[]): { files: number; symbols: number } {
    let count = 0;
    for (const file of files) { this.sql.exec("DELETE FROM ast_symbols WHERE file_path = ?", file.path); for (const symbol of extractSymbols(file)) { this.sql.exec("INSERT INTO ast_symbols(name,kind,file_path,start_line,end_line,signature,docstring) VALUES (?,?,?,?,?,?,?)", symbol.name,symbol.kind,symbol.filePath,symbol.startLine,symbol.endLine,symbol.signature,symbol.docstring); count++; } }
    return { files: files.length, symbols: count };
  }
  async query(term: string): Promise<AstSymbol[]> { return [...this.sql.exec<Record<string, unknown>>("SELECT name,kind,file_path AS filePath,start_line AS startLine,end_line AS endLine,signature,docstring FROM ast_symbols WHERE name = ? ORDER BY file_path,start_line LIMIT 100", term)] as unknown as AstSymbol[]; }
  async symbols(path: string): Promise<AstSymbol[]> { return [...this.sql.exec<Record<string, unknown>>("SELECT name,kind,file_path AS filePath,start_line AS startLine,end_line AS endLine,signature,docstring FROM ast_symbols WHERE file_path = ? ORDER BY start_line LIMIT 1000", path)] as unknown as AstSymbol[]; }
}
