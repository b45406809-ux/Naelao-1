import { normalizeWorkspacePath } from "./workspace-paths.js";
import { inspectMutation, type WriteGuardOptions } from "@naelao/security";
import { parseCliWords, VirtualCliDispatcher } from "./virtual-cli.js";

export interface VirtualFileSystem {
  read(path: string): Promise<string | undefined>;
  list(): Promise<string[]>;
  write?(path: string, contents: string, options?: { expectedHash?: string }): Promise<void>;
  edit?(path: string, oldText: string, newText: string, options?: { expectedHash?: string }): Promise<void>;
}

export interface VirtualShellResult {
  exit_code: number;
  stdout: string;
  stderr?: string;
}
export interface VirtualPosixOptions {
  writeGuard?: WriteGuardOptions;
  cli?: VirtualCliDispatcher;
}
const BUILTINS = new Set(["cat", "grep", "sed", "awk", "find", "jq", "diff", "stripe", "gh", "r2", "resend", "twilio", "avos"]);

function pipelines(command: string): string[] {
  const result: string[] = [];
  let value = "";
  let quote: string | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      value += char;
      escaped = true;
      continue;
    }
    if (quote) {
      value += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      value += char;
      continue;
    }
    if (char === "|") {
      if (!value.trim()) throw new Error("empty_pipeline_stage");
      result.push(value.trim());
      value = "";
      continue;
    }
    value += char;
  }
  if (quote || !value.trim()) throw new Error("invalid_pipeline");
  result.push(value.trim());
  return result;
}

async function inputFromFiles(
  fs: VirtualFileSystem,
  args: string[],
  stdin: string
): Promise<string> {
  if (!args.length) return stdin;
  const chunks: string[] = [];
  for (const arg of args) {
    const value = await fs.read(normalizeWorkspacePath(arg));
    if (value === undefined) throw new Error(`${arg}: no such file`);
    chunks.push(value);
  }
  return chunks.join("");
}

async function stage(
  fs: VirtualFileSystem,
  words: string[],
  stdin: string
): Promise<string> {
  const [cmd, ...args] = words;
  if (cmd === "cat")
    return inputFromFiles(
      fs,
      args.filter((x) => !x.startsWith("-")),
      stdin
    );
  if (cmd === "grep") {
    const numbered = args.includes("-n");
    const insensitive = args.includes("-i");
    const positional = args.filter((x) => !x.startsWith("-"));
    const pattern = positional.shift();
    if (!pattern) throw new Error("grep: pattern required");
    const source = await inputFromFiles(fs, positional, stdin);
    const re = new RegExp(pattern, insensitive ? "i" : "");
    return source
      .split(/\r?\n/)
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => re.test(line))
      .map(({ line, i }) => (numbered ? `${i + 1}:${line}` : line))
      .join("\n");
  }
  if (cmd === "sed") {
    const expression = args[0];
    if (!expression) throw new Error("sed: expression required");
    const source = await inputFromFiles(fs, args.slice(1), stdin);
    const match = expression.match(/^s(.)(.*?)\1(.*?)\1([gi]*)$/);
    if (!match) throw new Error("sed: only s/old/new/[gi] is supported");
    return source.replace(
      new RegExp(
        match[2]!,
        match[4]!.includes("g")
          ? `g${match[4]!.includes("i") ? "i" : ""}`
          : match[4]!.includes("i")
            ? "i"
            : ""
      ),
      match[3]!
    );
  }
  if (cmd === "awk") {
    const program = args[0] ?? "";
    const source = await inputFromFiles(fs, args.slice(1), stdin);
    const print = program.match(/^\{\s*print\s+\$(\d+)\s*\}$/);
    if (!print) throw new Error("awk: only '{print $N}' is supported");
    return source
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[Number(print[1]) - 1] ?? "")
      .join("\n");
  }
  if (cmd === "find") {
    const root =
      args[0] && !args[0]!.startsWith("-")
        ? normalizeWorkspacePath(`${args[0]}/_`).replace(/\/_$/, "")
        : "";
    const nameAt = args.indexOf("-name");
    const glob = nameAt >= 0 ? args[nameAt + 1] : undefined;
    const re = glob
      ? new RegExp(
          `^${glob
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replaceAll("*", ".*")
            .replaceAll("?", ".")}$`
        )
      : null;
    return (await fs.list())
      .filter(
        (p) =>
          (!root || p === root || p.startsWith(`${root}/`)) &&
          (!re || re.test(p.split("/").at(-1)!))
      )
      .map((p) => `/workspace/${p}`)
      .join("\n");
  }
  if (cmd === "jq") {
    const filter = args[0] ?? ".";
    const source = await inputFromFiles(fs, args.slice(1), stdin);
    let value: unknown = JSON.parse(source);
    if (filter !== ".")
      for (const key of filter.replace(/^\./, "").split("."))
        value = (value as Record<string, unknown>)?.[key];
    return typeof value === "string"
      ? JSON.stringify(value)
      : JSON.stringify(value, null, 2);
  }
  if (cmd === "diff") {
    if (args.length !== 2) throw new Error("diff: two files required");
    const [a, b] = await Promise.all(
      args.map((p) => fs.read(normalizeWorkspacePath(p)))
    );
    if (a === undefined || b === undefined)
      throw new Error("diff: no such file");
    if (a === b) return "";
    return `--- ${args[0]}\n+++ ${args[1]}\n-${a}\n+${b}`;
  }
  throw new Error(`unsupported virtual command: ${cmd}`);
}

export function canRunVirtually(command: string): boolean {
  try {
    return pipelines(command).every((part) =>
      BUILTINS.has(parseCliWords(part)[0] ?? "") || /^(?:ext|auto):[a-z][a-z0-9_-]*$/i.test(parseCliWords(part)[0] ?? "")
    );
  } catch {
    return false;
  }
}

/** Runs a bounded POSIX subset entirely in the Worker isolate; no container is started. */
export async function executeVirtualPosix(
  command: string,
  fs: VirtualFileSystem,
  options: VirtualPosixOptions = {}
): Promise<VirtualShellResult> {
  let stdout = "";
  try {
    // This is intentionally the first awaited operation: no filesystem/API handler can run first.
    if (options.writeGuard) await inspectMutation(command, { ...options.writeGuard, kind: "shell" });
    for (const part of pipelines(command)) {
      const words = parseCliWords(part);
      const intercepted = await options.cli?.execute(words, stdout);
      stdout = intercepted ? intercepted.stdout : await stage(fs, words, stdout);
    }
    return { exit_code: 0, stdout };
  } catch (error) {
    return {
      exit_code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
