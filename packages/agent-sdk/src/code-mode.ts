/** Host-owned descriptions. Discovery never grants a capability. */
export interface CodeModeTool {
  name: string;
  description: string;
  parameterHint?: string;
  inputSchema?: Record<string, unknown>;
}
/** CLI facade injected into composed code. Operations are invoked as argv, not as a
 * model-native JSON tool catalogue. The host still resolves argv to scoped operations. */
export interface CodeModeCli {
  search(query: string, limit?: number): Promise<ReturnType<typeof searchCodeModeTools>>;
  help(name: string): Promise<ReturnType<typeof describeCodeModeTool>>;
  run(argv: readonly string[]): Promise<unknown>;
}

export function describeCodeModeTool(tool: CodeModeTool) {
  const usage = `${tool.name}${tool.parameterHint ? ` ${tool.parameterHint}` : " --params <json>"}`;
  return { name: tool.name, description: tool.description, usage };
}

/** Parse one virtual CLI command. It deliberately supports a single command and a JSON
 * parameter payload; pipes, shell syntax, and positional guessing are handled by the existing
 * virtual shell, not by the composition RPC. */
export function parseCodeModeCommand(tools: readonly CodeModeTool[], argv: readonly string[]) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64 || argv.some(value => typeof value !== "string" || value.length > 8192)) throw new Error("cli_command_invalid");
  const [name, ...flags] = argv;
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,180}$/.test(name!) || !tools.some(tool => tool.name === name)) throw new Error("cli_command_unavailable");
  let input: unknown = {};
  if (flags.length) {
    if (flags.length !== 2 || flags[0] !== "--params") throw new Error("cli_command_usage: use --params <json>");
    try { input = JSON.parse(flags[1]!); } catch { throw new Error("cli_command_params_invalid"); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("cli_command_params_invalid");
  }
  return { name: name!, input };
}

/** Bounded deterministic discovery over an already authorized invocation catalogue. */
export function searchCodeModeTools(tools: readonly CodeModeTool[], query: string, limit = 10) {
  if (typeof query !== "string" || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("code_discovery_input_invalid");
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const ranked = tools.map(tool => ({ tool, score: words.reduce((score, word) => score + (tool.name.toLowerCase().includes(word) ? 3 : `${tool.description} ${tool.parameterHint ?? ""}`.toLowerCase().includes(word) ? 1 : 0), 0) }))
    .filter(row => words.length === 0 || row.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return { results: ranked.slice(0, limit).map(({ tool }) => ({ name: tool.name, description: tool.description })), total: ranked.length, truncated: ranked.length > limit };
}
