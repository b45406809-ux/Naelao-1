import { parse } from "shell-quote";

export interface ShellRedirect { fd: 0 | 1 | 2; mode: "read" | "write" | "append"; path: string }
export interface ShellCommand { argv: string[]; environment: Record<string, string>; redirects: ShellRedirect[] }
export interface ShellPipeline { when: "always" | "success" | "failure"; commands: ShellCommand[] }

/** The supported shell-quote parser owns escaping and expansion. This AST adapter deliberately
 * rejects executable substitutions, subshells and globs until the VFS implements their semantics. */
export function parseShell(source: string, environment: Record<string, string> = {}, deferExpansion = false): ShellPipeline[] {
  if (source.length > 65_536 || source.includes("\0")) throw new Error("shell_input_limit");
  let quote: string | undefined;
  let escaped = false;
  let normalized = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (escaped) { normalized += c; escaped = false; continue; }
    if (c === "\\" && quote !== "'") { normalized += c; escaped = true; continue; }
    if (c === quote) quote = undefined;
    else if (!quote && (c === "'" || c === '"')) quote = c;
    else if (quote !== "'" && (c === "`" || c === "$" && source[i + 1] === "(")) throw new Error("shell_substitution_not_supported");
    normalized += c === "\n" && !quote ? ";" : c;
  }
  if (quote || escaped) throw new Error("unterminated_shell_quote");
  const tokens = parse(normalized, deferExpansion ? (name) => `\u0001${name}\u0002` : environment) as Array<string | { op?: string; pattern?: string; comment?: string }>;
  const pipelines: ShellPipeline[] = [];
  let pipeline: ShellPipeline = { when: "always", commands: [] };
  let command: ShellCommand = { argv: [], environment: {}, redirects: [] };
  const finishCommand = () => {
    if (!command.argv.length && !Object.keys(command.environment).length) throw new Error("empty_shell_command");
    if (command.argv.length > 256) throw new Error("shell_argument_limit");
    pipeline.commands.push(command);
    command = { argv: [], environment: {}, redirects: [] };
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (typeof token === "string") {
      const assignment = !command.argv.length ? /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(token) : null;
      if (assignment) command.environment[assignment[1]!] = assignment[2]!;
      else command.argv.push(token);
      continue;
    }
    if (token.comment !== undefined) continue;
    const op = token.op;
    if ([">", ">>", "<"].includes(op ?? "")) {
      let fd: 0 | 1 | 2 = op === "<" ? 0 : 1;
      if (command.argv.at(-1) === "2") { command.argv.pop(); fd = 2; }
      const target = tokens[++i];
      if (typeof target !== "string") throw new Error("shell_redirect_target_required");
      command.redirects.push({ fd, mode: op === "<" ? "read" : op === ">>" ? "append" : "write", path: target });
    } else if (op === "|") finishCommand();
    else if ([";", "&&", "||"].includes(op ?? "")) {
      if (!command.argv.length && !Object.keys(command.environment).length && op === ";") continue;
      finishCommand(); pipelines.push(pipeline);
      pipeline = { when: op === "&&" ? "success" : op === "||" ? "failure" : "always", commands: [] };
    } else throw new Error(`unsupported_shell_operator:${op ?? "glob"}`);
  }
  if (command.argv.length || Object.keys(command.environment).length) finishCommand();
  else if (pipeline.commands.length) throw new Error("empty_pipeline_stage");
  if (pipeline.commands.length) pipelines.push(pipeline);
  const last = tokens.at(-1);
  if (typeof last === "object" && ["|", "&&", "||"].includes(last.op ?? "")) throw new Error("empty_shell_command");
  if (pipelines.reduce((count, item) => count + item.commands.length, 0) > 128) throw new Error("shell_stage_limit");
  return pipelines;
}

export function shellWords(source: string): string[] {
  const tree = parseShell(source);
  if (tree.length !== 1 || tree[0]!.commands.length !== 1 || tree[0]!.commands[0]!.redirects.length) throw new Error("simple_cli_command_required");
  return tree[0]!.commands[0]!.argv;
}
