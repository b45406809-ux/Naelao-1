import { describe, expect, it, vi } from "vitest";
import { DurableDaemon, DurableDaemonRegistry, type DaemonSql } from "./durable-daemon.js";
import { extractIdentifierOccurrences, extractSymbols, TreeSitterIndexer } from "./tree-sitter-indexer.js";
import { createDOStorage } from "../../../../../tests/unit/helpers/sqlite-do-shim.js";
import { VirtualCliDispatcher, interceptPlatformCli } from "../virtual-cli.js";

class StateSql implements DaemonSql {
  row: Record<string, unknown> | undefined;
  exec<T>(query: string, ...values: unknown[]): Iterable<T> {
    if (query.startsWith("SELECT")) return (this.row ? [this.row] : []) as T[];
    if (query.startsWith("INSERT INTO durable_daemons")) this.row = { name: values[0], state: values[1], workflow_id: values[2], started_at: values[3], stopped_at: values[4], error: values[5] };
    return [];
  }
}

describe("durable daemons", () => {
  it("persists lifecycle while workflow work remains detached", async () => {
    const sql = new StateSql(); const terminate = vi.fn(async () => undefined);
    const workflow = { id: "wf", status: vi.fn(async () => ({ status: "running" })), terminate };
    const daemon = new DurableDaemon("audit", sql, { create: vi.fn(async () => workflow), get: vi.fn(async () => workflow) });
    expect((await daemon.start()).state).toBe("RUNNING");
    expect((await daemon.status()).workflowId).toBe("wf");
    expect((await daemon.stop()).state).toBe("STOPPED"); expect(terminate).toHaveBeenCalledOnce();
  });
  it("routes only through the ext namespace", async () => {
    const target = { start: vi.fn(async () => ({ state: "RUNNING" })), stop: vi.fn(), status: vi.fn() };
    const registry = new DurableDaemonRegistry(); registry.register("audit", target);
    const cli = new VirtualCliDispatcher({ tenantId: "t", spaceId: "s", vault: { fetchWithAuth: vi.fn() }, daemons: registry });
    expect((await cli.execute(["ext:audit", "start"]))?.stdout).toContain("RUNNING");
    expect(interceptPlatformCli("ext:audit status")?.operation).toBe("ext:audit");
  });
});

describe("tree-sitter-compatible symbol extraction", () => {
  it("returns accurate TypeScript and Python coordinates", () => {
    const ts = extractSymbols({ path: "src/a.ts", content: "/** x */\nexport interface User {\n id: string\n}\nexport function greet(name: string): string {\n return name\n}" });
    expect(ts).toEqual(expect.arrayContaining([expect.objectContaining({ name: "User", kind: "interface", startLine: 2, endLine: 4 }), expect.objectContaining({ name: "greet", startLine: 5, endLine: 7 })]));
    const py = extractSymbols({ path: "a.py", content: "class Greeter:\n    def hello(self, name: str) -> str:\n        return name\n\ndef top():\n    pass" });
    expect(py).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Greeter", startLine: 1, endLine: 3 }), expect.objectContaining({ name: "hello", kind: "method", startLine: 2, endLine: 3 }), expect.objectContaining({ name: "top", startLine: 5 })]));
  });

  it("indexes bounded exact identifier occurrences without treating comments or string literals as references", async () => {
    const sql = createDOStorage().sql;
    const indexer = new TreeSitterIndexer({ exec: (query, ...params) => sql.exec(query, ...params).toArray() } as never);
    const indexed = indexer.index([{ path: "src/user.ts", content: "const User = 1; // User\nconst label = 'User';\nfunction find(User: number) { return User }" }], true);
    expect(indexed.files).toBe(1);
    expect(await indexer.references("User")).toEqual([
      expect.objectContaining({ filePath: "src/user.ts", line: 1, columnNumber: 7 }),
      expect.objectContaining({ filePath: "src/user.ts", line: 3, columnNumber: 15 }),
      expect.objectContaining({ filePath: "src/user.ts", line: 3, columnNumber: 38 }),
    ]);
    expect(indexer.status()).toEqual({ parser: "bounded lexical symbol/indexer", semanticReferences: false });
    indexer.index([{ path: "src/account.ts", content: "export interface Account { id: string }" }], true);
    expect(await indexer.references("User")).toEqual([]);
    expect(await indexer.query("Account")).toHaveLength(1);
  });

  it("omits comments and quoted strings while retaining source identifier locations", () => {
    expect(extractIdentifierOccurrences({ path: "src/a.ts", content: "// User\nconst x = 'User'; /* User */ use(User)" }))
      .toEqual([expect.objectContaining({ name: "const", line: 2 }), expect.objectContaining({ name: "x", line: 2 }),
        expect.objectContaining({ name: "use", line: 2 }), expect.objectContaining({ name: "User", line: 2 })]);
    expect(extractIdentifierOccurrences({ path: "src/a.py", content: "def run(User):\n    '''User in a docstring'''\n    return User # User in a comment" }))
      .toEqual([expect.objectContaining({ name: "def", line: 1 }), expect.objectContaining({ name: "run", line: 1 }),
        expect.objectContaining({ name: "User", line: 1 }), expect.objectContaining({ name: "return", line: 3 }),
        expect.objectContaining({ name: "User", line: 3 })]);
  });
});

describe("project LSP CLI", () => {
  it("routes namespaced commands through the virtual platform dispatcher", () => {
    expect(interceptPlatformCli("lsp find-refs User")).toEqual({ operation: "lsp.command", params: { argv: ["find-refs", "User"] } });
    expect(interceptPlatformCli("lsp find-symbol User")).toMatchObject({ operation: "lsp.command" });
    expect(() => interceptPlatformCli("lsp delete-all")).toThrow("usage: lsp");
  });
});
