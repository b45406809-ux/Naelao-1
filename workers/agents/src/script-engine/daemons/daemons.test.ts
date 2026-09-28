import { describe, expect, it, vi } from "vitest";
import { DurableDaemon, DurableDaemonRegistry, type DaemonSql } from "./durable-daemon.js";
import { extractSymbols } from "./tree-sitter-indexer.js";
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
});
