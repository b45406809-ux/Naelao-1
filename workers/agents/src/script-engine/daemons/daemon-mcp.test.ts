import { describe, expect, it } from "vitest";
import { handleDaemonMcp, treeSitterDaemonTarget } from "./daemon-mcp.js";
import { TreeSitterIndexer } from "./tree-sitter-indexer.js";

class SqlMock {
  rows: Array<Record<string, unknown>> = [];
  exec<T = Record<string, unknown>>(query: string, ...values: unknown[]): Iterable<T> {
    if (query.startsWith("SELECT name")) return this.rows.filter(row => row.name === values[0]) as T[];
    if (query.startsWith("SELECT name") && values[0]) return this.rows as T[];
    if (query.startsWith("DELETE")) this.rows = this.rows.filter(row => row.file_path !== values[0]);
    if (query.startsWith("INSERT")) this.rows.push({ name: values[0], kind: values[1], file_path: values[2], start_line: values[3], end_line: values[4], signature: values[5], docstring: values[6] });
    return [] as T[];
  }
}

async function call(method: string, params?: Record<string, unknown>) {
  const sql = new SqlMock();
  const response = await handleDaemonMcp(new Request("http://daemon/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), treeSitterDaemonTarget(new TreeSitterIndexer(sql)));
  return { response, body: await response.json() as { result?: { structuredContent?: unknown }; error?: { message?: string } } };
}

describe("daemon MCP", () => {
  it("discovers and indexes through the bounded JSON-RPC surface", async () => {
    const listed = await call("tools/list");
    expect((listed.body.result?.structuredContent as never) ?? listed.body.result).toBeDefined();
    const indexed = await call("tools/call", { name: "daemon_tree-sitter_index", arguments: { files: [{ path: "src/a.ts", content: "export function hello() {}" }] } });
    expect(indexed.response.status).toBe(200);
    const queried = await call("tools/call", { name: "daemon_tree-sitter_query", arguments: { term: "hello" } });
    expect(queried.response.status).toBe(200);
  });

  it("rejects oversized input before indexing", async () => {
    const result = await call("tools/call", { name: "daemon_tree-sitter_index", arguments: { files: [{ path: "a.ts", content: "x".repeat(512_001) }] } });
    expect(result.response.status).toBe(400);
    expect(result.body.error?.message).toContain("512KB");
  });

  it("rejects paths that escape the workspace", async () => {
    const result = await call("tools/call", { name: "daemon_tree-sitter_index", arguments: { files: [{ path: "../secret.ts", content: "export function leaked() {}" }] } });
    expect(result.response.status).toBe(400);
    expect(result.body.error?.message).toContain("safe workspace path");
  });

  it("exposes lifecycle operations for a declared workflow daemon", async () => {
    const target = { name: "reports", start: async () => ({ state: "RUNNING" }), stop: async () => ({ state: "STOPPED" }), status: async () => ({ state: "RUNNING" }) };
    const response = await handleDaemonMcp(new Request("http://daemon/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "daemon_reports_start", arguments: {} } }) }), target);
    expect(response.status).toBe(200);
    expect((await response.json() as { result?: { structuredContent?: { state?: string } } }).result?.structuredContent?.state).toBe("RUNNING");
  });
});
