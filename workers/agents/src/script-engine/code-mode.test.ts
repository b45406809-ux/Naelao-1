import { describe, expect, it, vi } from "vitest";
import { createScopedCodeRpc, describeCodeModeTool } from "@naelao/agent-sdk";
import { VirtualCliDispatcher } from "./virtual-cli.js";
import { ScriptToolSurface } from "./tool-surface.js";
import type { ScriptEngineEnv } from "./types.js";
import { buildGuestHarness } from "./dynamic-code.js";

describe("scoped code composition", () => {
  it("keeps bounded MCP intermediate data in code rather than replacing it with a model preview", async () => {
    const rows = { tools: Array.from({ length: 100 }, (_, index) => ({ name: `tool_${index}`, description: "A permitted connected service method with useful details" })) };
    const env: ScriptEngineEnv = { tenantId: "t", spaceId: "s", agentId: "a", platformSecret: "test-secret", scriptsBucket: {} as R2Bucket,
      codeGrantIsActive: async () => true, mcpHubWorker: { fetch: async (request: Request) => Response.json(new URL(request.url).pathname.endsWith("/tools") ? rows : { data: [{ id: "server-1", name: "test-server" }] }) } as unknown as Fetcher };
    new ScriptToolSurface(env, ["mcp-connector"]);
    const rpc = createScopedCodeRpc({ scope: { tenantId: "t", spaceId: "s", agentId: "a" }, capabilities: ["tool:mcp.list_tools"],
      signal: new AbortController().signal, tools: env.codeTools!(), authorize: env.codeAuthorize!, dispatch: env.codeDispatch! });
    expect(await rpc("tool:mcp.list_tools", { server: "test-server" })).toEqual(rows);
  });
  it("filters the real worker catalogue through invocation scope and live grants", async () => {
    const env: ScriptEngineEnv = { tenantId: "t", spaceId: "s", agentId: "a", maxTier: 1, scriptsBucket: {} as R2Bucket,
      codeGrantIsActive: async () => true };
    new ScriptToolSurface(env, ["conversation", "code-exec", "mcp-connector"]);
    const scope = { tenantId: "t", spaceId: "s", agentId: "a" };
    const rpc = createScopedCodeRpc({ scope, capabilities: ["tool:conversation.search", "tool:code.run_js", "tool:mcp.call", "tool:tools.search"],
      signal: new AbortController().signal, tools: env.codeTools!(), authorize: env.codeAuthorize!, dispatch: env.codeDispatch! });
    expect(await rpc("codemode.search", { query: "" })).toMatchObject({ total: 1, results: [{ name: "conversation.search" }] });
    expect(await rpc("codemode.describe", { name: "conversation.search" })).toMatchObject({ usage: expect.stringContaining("conversation.search") });
    env.maxTier = 2;
    expect(await rpc("codemode.search", { query: "" })).toMatchObject({ total: 2 });
    env.codeGrantIsActive = async () => false;
    expect(await rpc("codemode.search", { query: "" })).toMatchObject({ total: 0 });
  });

  it("executes composed calls through the production guest facade and returns only the final result", async () => {
    const dispatch = vi.fn(async (_, capability: string) => capability === "tool:source.list" ? [1, 2, 3] : { valid: true });
    const rpc = createScopedCodeRpc({ scope: { tenantId: "t", spaceId: "s", agentId: "a" },
      capabilities: ["tool:source.list", "tool:source.check"], tools: [
        { name: "source.list", description: "List sources" },
        { name: "source.check", description: "Check a source" },
      ],
      signal: new AbortController().signal, authorize: async () => true, dispatch });
    const source = buildGuestHarness(4096).replace(/^import .*;\n/gm, "").replace("export default", "return");
    const run = async (_: unknown, ctx: { cli: { search(query: string): Promise<unknown>; help(name: string): Promise<unknown>; run(argv: string[]): Promise<unknown> } }) => {
      await ctx.cli.search("sources"); await ctx.cli.help("source.list");
      const rows = await ctx.cli.run(["source.list"]) as number[];
      await ctx.cli.run(["source.check", "--params", JSON.stringify({ id: rows[0] })]);
      return { checked: 1 };
    };
    const guest = new Function("run", "encode", "freeze", "jsonResponse", "byteLength", source)(run, JSON.stringify, Object.freeze, Response.json.bind(Response), (value: string) => new TextEncoder().encode(value).length);
    const response = await guest.fetch(new Request("http://guest/run", { method: "POST", body: JSON.stringify({ args: {} }) }), { __RPC__: { call: rpc }, __PROJECT_ID__: "p" });
    expect(await response.json()).toEqual({ ok: true, result: { checked: 1 } });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("discovers only selected, currently authorized tools and never dispatches discovery as a tool", async () => {
    let revoked = false;
    const dispatch = vi.fn(async () => ({ matches: ["evidence-1"] }));
    const rpc = createScopedCodeRpc({
      scope: { tenantId: "t", spaceId: "s", agentId: "a", projectId: "p" },
      capabilities: ["tool:conversation.search", "tool:forbidden"], signal: new AbortController().signal,
      tools: [{ name: "conversation.search", description: "Search archived conversation", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
        { name: "secret.admin", description: "Private admin operation" }, { name: "forbidden", description: "No longer authorized" }],
      authorize: async (_, capability) => !revoked && capability === "tool:conversation.search", dispatch,
    });
    expect(await rpc("codemode.search", { query: "" })).toMatchObject({ total: 1, results: [{ name: "conversation.search" }] });
    expect(await rpc("codemode.describe", { name: "conversation.search" })).toMatchObject({ usage: "conversation.search --params <json>" });
    await expect(rpc("codemode.describe", { name: "secret.admin" })).rejects.toThrow("code_tool_unavailable");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await rpc("tool:conversation.search", { query: "decision" })).toEqual({ matches: ["evidence-1"] });
    revoked = true;
    expect(await rpc("codemode.search", { query: "" })).toMatchObject({ total: 0 });
    await expect(rpc("tool:conversation.search", {})).rejects.toThrow("code_capability_denied");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("bounds discovery calls and does not invent a precise schema for untyped tools", async () => {
    const rpc = createScopedCodeRpc({ scope: { tenantId: "t", spaceId: "s", agentId: "a" }, capabilities: [],
      signal: new AbortController().signal, maxCalls: 1, tools: [], authorize: async () => true, dispatch: async () => null });
    await expect(rpc("codemode.search", { query: "x", limit: 51 })).rejects.toThrow("code_discovery_input_invalid");
    await expect(rpc("codemode.search", { query: "x" })).rejects.toThrow("code_rpc_quota");
    expect(describeCodeModeTool({ name: "mcp.call", description: "Scoped connector call", parameterHint: "server, tool, params" }).usage).toBe("mcp.call server, tool, params");
  });

  it("passes explicit composition capabilities separately from module arguments", async () => {
    const run = vi.fn(async () => ({ ok: true, output: { count: 1 }, actual_tier: 2, engine: "isolate" }));
    const surface = new ScriptToolSurface({ tenantId: "t", spaceId: "s", agentId: "a", runId: "r", scriptsBucket: {} as R2Bucket, codeRunner: { run } } as never, ["code-exec"]);
    expect(await surface.run("code.run_js", { code: "export async function run(args, ctx) { return args; }", args: { query: "decision" }, capabilities: ["tool:conversation.search"] })).toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ args: { query: "decision" }, capabilities: ["tool:conversation.search"], tier: 2 }));
  });

  it("rejects malformed or ambiguous saved command capability declarations", () => {
    expect(VirtualCliDispatcher.synthesizedCapabilities('// @naelao-capabilities: ["tool:mcp.call"]\nexport async function run(args, ctx) {}')).toEqual(["tool:mcp.call"]);
    expect(() => VirtualCliDispatcher.synthesizedCapabilities('// @naelao-capabilities: ["*"]')).toThrow("invalid_command_capabilities");
    expect(() => VirtualCliDispatcher.synthesizedCapabilities('// @naelao-capabilities: []\n// @naelao-capabilities: []')).toThrow("invalid_command_capabilities");
  });
});
