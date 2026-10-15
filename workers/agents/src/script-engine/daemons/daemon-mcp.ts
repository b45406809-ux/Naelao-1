import type { SourceFile, TreeSitterIndexer } from "./tree-sitter-indexer.js";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 512_000;
const MAX_TOTAL_BYTES = 2_000_000;
const MAX_QUERY_LENGTH = 256;

function isSafeWorkspacePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  let depth = 0;
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { if (depth === 0) return false; depth--; }
    else depth++;
  }
  return depth > 0;
}

export interface DaemonMcpTarget {
  name: string;
  index?(files: SourceFile[], replace?: boolean): { files: number; symbols: number };
  start?(params?: Record<string, unknown>): Promise<unknown>;
  stop?(): Promise<unknown>;
  query?(term: string): Promise<unknown>;
  references?(term: string): Promise<unknown>;
  symbols?(path: string): Promise<unknown>;
  status?(): Promise<unknown>;
}

/**
 * Stateless MCP 2025 transport for a project daemon. The target is supplied by the owning
 * Durable Object, so this handler never accepts an arbitrary worker or storage identifier from
 * the request. Input limits are deliberately enforced before parsing/indexing to keep an MCP
 * caller from turning an AST daemon into an unbounded memory or CPU surface.
 */
export async function handleDaemonMcp(request: Request, target: DaemonMcpTarget): Promise<Response> {
  const rpc = await request.json<{ jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }>().catch(() => null);
  const id = rpc?.id ?? null;
  const result = (value: unknown) => Response.json({ jsonrpc: "2.0", id, result: value }, { headers: { "mcp-session-id": crypto.randomUUID() } });
  const failure = (code: number, message: string, status = 400) => Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
  if (!rpc || rpc.jsonrpc !== "2.0") return failure(-32600, "Invalid Request");
  const daemon = target.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const tools = [
    ...(target.start ? [{ name: `daemon_${daemon}_start`, description: "Start the durable daemon", inputSchema: { type: "object", properties: {} } }] : []),
    ...(target.stop ? [{ name: `daemon_${daemon}_stop`, description: "Stop the durable daemon", inputSchema: { type: "object", properties: {} } }] : []),
    ...(target.index ? [{ name: `daemon_${daemon}_index`, description: "Index bounded workspace source files", inputSchema: { type: "object", properties: { files: { type: "array", maxItems: MAX_FILES }, replace: { type: "boolean" } }, required: ["files"] } }] : []),
    ...(target.query ? [{ name: `daemon_${daemon}_query`, description: "Find indexed symbols by exact name", inputSchema: { type: "object", properties: { term: { type: "string", maxLength: MAX_QUERY_LENGTH } }, required: ["term"] } }] : []),
    ...(target.references ? [{ name: `daemon_${daemon}_references`, description: "Find bounded lexical identifier occurrences by exact name", inputSchema: { type: "object", properties: { term: { type: "string", maxLength: MAX_QUERY_LENGTH } }, required: ["term"] } }] : []),
    ...(target.symbols ? [{ name: `daemon_${daemon}_symbols`, description: "List indexed symbols for a workspace path", inputSchema: { type: "object", properties: { path: { type: "string", maxLength: MAX_QUERY_LENGTH } }, required: ["path"] } }] : []),
    ...(target.status ? [{ name: `daemon_${daemon}_status`, description: "Read daemon status", inputSchema: { type: "object", properties: {} } }] : []),
  ];
  if (rpc.method === "initialize") return result({ protocolVersion: "2025-03-26", serverInfo: { name: `naelao-daemon-${daemon}`, version: "1.0" }, capabilities: { tools: { listChanged: false } } });
  if (rpc.method === "tools/list") return result({ tools });
  if (rpc.method !== "tools/call") return failure(-32601, "Method not found", 404);

  const params = rpc.params ?? {};
  const name = String(params.name ?? "");
  const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown> : {};
  const prefix = `daemon_${daemon}_`;
  if (!name.startsWith(prefix)) return failure(-32602, "Unknown daemon tool");
  const action = name.slice(prefix.length);
  let data: unknown;
  if (action === "start" && target.start) {
    data = await target.start(args);
  } else if (action === "stop" && target.stop) {
    data = await target.stop();
  } else if (action === "index" && target.index) {
    if (!Array.isArray(args.files) || args.files.length > MAX_FILES) return failure(-32602, "files must contain at most 200 entries");
    const files: SourceFile[] = []; let totalBytes = 0;
    for (const value of args.files) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return failure(-32602, "each file must be an object");
      const file = value as Record<string, unknown>;
      if (typeof file.path !== "string" || typeof file.content !== "string" || !isSafeWorkspacePath(file.path)) return failure(-32602, "each file requires a safe workspace path and string content");
      const bytes = new TextEncoder().encode(file.content).byteLength;
      if (bytes > MAX_FILE_BYTES) return failure(-32602, "file content exceeds 512KB");
      totalBytes += bytes;
      if (totalBytes > MAX_TOTAL_BYTES) return failure(-32602, "index request exceeds 2MB total");
      files.push({ path: file.path, content: file.content });
    }
    data = target.index(files, args.replace === true);
  } else if (action === "query" && target.query) {
    const term = args.term;
    if (typeof term !== "string" || !term || term.length > MAX_QUERY_LENGTH) return failure(-32602, "term must be a non-empty string under 256 characters");
    data = await target.query(term);
  } else if (action === "references" && target.references) {
    const term = args.term;
    if (typeof term !== "string" || !/^[A-Za-z_$][\w$]{0,127}$/.test(term)) return failure(-32602, "term must be an identifier under 128 characters");
    data = await target.references(term);
  } else if (action === "symbols" && target.symbols) {
    const path = args.path;
    if (typeof path !== "string" || path.length > MAX_QUERY_LENGTH || !isSafeWorkspacePath(path)) return failure(-32602, "path must be a safe workspace path under 256 characters");
    data = await target.symbols(path);
  } else if (action === "status" && target.status) {
    data = await target.status();
  } else return failure(-32602, "Unknown daemon tool");
  return result({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
}

export function treeSitterDaemonTarget(indexer: TreeSitterIndexer): DaemonMcpTarget {
  return {
    name: "tree-sitter",
    index: files => indexer.index(files),
    query: term => indexer.query(term),
    references: term => indexer.references(term),
    symbols: path => indexer.symbols(path),
    status: async () => indexer.status(),
  };
}
