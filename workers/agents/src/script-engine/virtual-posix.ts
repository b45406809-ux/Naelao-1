import { normalizeWorkspacePath } from "./workspace-paths.js";
import { inspectMutation, type WriteGuardOptions } from "@naelao/security";
import { VirtualCliDispatcher } from "./virtual-cli.js";
import { parseShell } from "./shell-parser.js";

export interface VirtualFileSystem {
  read(path: string): Promise<string | undefined>;
  list(): Promise<string[]>;
  write?(path: string, contents: string, options?: { expectedHash?: string | null }): Promise<void>;
  remove?(path: string): Promise<void>;
  edit?(path: string, oldText: string, newText: string, options?: { expectedHash?: string }): Promise<void>;
}

export interface VirtualShellResult {
  exit_code: number;
  stdout: string;
  stderr?: string;
  events?: Array<{ type: "command" | "worker" | "output_limit"; name: string; data?: unknown }>;
}
export interface VirtualPosixOptions {
  writeGuard?: WriteGuardOptions;
  cli?: VirtualCliDispatcher;
  environment?: Record<string, string>;
  signal?: AbortSignal;
  deadline?: number;
  maxOutputBytes?: number;
  pipefail?: boolean;
  authorize?: (resource: { kind: "command" | "file"; name: string; access?: "read" | "write" }) => Promise<boolean>;
  resolve?: (words: string[], stdin: string, context: { signal: AbortSignal; environment: Record<string, string> }) => Promise<VirtualShellResult | null>;
}
const BUILTINS = new Set(["cat", "grep", "sed", "awk", "find", "jq", "diff", "echo", "printf", "pwd", "ls", "head", "tail", "wc", "sort", "uniq", "true", "false", "touch", "rm", "cp", "mv", "stripe", "gh", "r2", "resend", "twilio", "avos", "naelao", "workflow", "schedule", "browse", "see", "fetch-md", "runtime", "lsp"]);

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
  if (cmd === "true" || cmd === "false") return "";
  if (cmd === "ls") {
    const root = args.find((arg) => !arg.startsWith("-"));
    const prefix = root && ![".", "/workspace"].includes(root) ? `${normalizeWorkspacePath(root)}/` : "";
    return [...new Set((await fs.list()).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0]))].sort().join("\n");
  }
  if (cmd === "head" || cmd === "tail") {
    const at = args.indexOf("-n");
    const count = at < 0 ? 10 : Number(args[at + 1]);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${cmd}: invalid line count`);
    const paths = args.filter((_, i) => at < 0 || i !== at && i !== at + 1);
    const lines = (await inputFromFiles(fs, paths, stdin)).split(/\r?\n/);
    return (cmd === "head" ? lines.slice(0, count) : lines.slice(-count)).join("\n");
  }
  if (cmd === "wc") {
    const value = await inputFromFiles(fs, args.filter((arg) => !arg.startsWith("-")), stdin);
    return String(args.includes("-c") ? new TextEncoder().encode(value).length : args.includes("-w") ? value.trim().split(/\s+/).filter(Boolean).length : value.split("\n").length - (value.endsWith("\n") ? 1 : 0));
  }
  if (cmd === "sort" || cmd === "uniq") {
    const lines = (await inputFromFiles(fs, args.filter((arg) => !arg.startsWith("-")), stdin)).split(/\r?\n/);
    return (cmd === "sort" ? lines.sort() : lines.filter((line, i) => !i || line !== lines[i - 1])).join("\n");
  }
  if (["touch", "rm", "cp", "mv"].includes(cmd ?? "")) {
    if (cmd === "rm") {
      if (!fs.remove) throw new Error("filesystem_remove_unavailable");
      for (const path of args.filter((arg) => !arg.startsWith("-"))) await fs.remove(normalizeWorkspacePath(path));
    } else {
      if (!fs.write) throw new Error("filesystem_write_unavailable");
      if (cmd === "touch") {
        for (const path of args) { const normalized = normalizeWorkspacePath(path); if (await fs.read(normalized) === undefined) await fs.write(normalized, ""); }
      } else {
        if (args.length !== 2) throw new Error(`${cmd}: source and destination required`);
        const contents = await inputFromFiles(fs, [args[0]!], "");
        await fs.write(normalizeWorkspacePath(args[1]!), contents);
        if (cmd === "mv") { if (!fs.remove) throw new Error("filesystem_remove_unavailable"); await fs.remove(normalizeWorkspacePath(args[0]!)); }
      }
    }
    return "";
  }
  if (cmd === "echo") return args.join(" ");
  if (cmd === "printf") {
    const format = args.shift() ?? "";
    return format.replace(/\\\\n/g, "\n").replace(/%s/g, () => args.shift() ?? "");
  }
  if (cmd === "pwd") return "/workspace";
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

export function canRunVirtually(command: string, registered?: (name: string) => boolean): boolean {
  try {
    return parseShell(command).every((pipeline) => pipeline.commands.every(({ argv }) => !argv.length || BUILTINS.has(argv[0]!) || registered?.(argv[0]!) || /^(?:ext|auto):[a-z][a-z0-9_-]*$/i.test(argv[0]!)));
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
  let stdout = "", stderr = "", exit_code = 0;
  const events: NonNullable<VirtualShellResult["events"]> = [];
  const environment = { ...(options.environment ?? {}) };
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = options.deadline === undefined ? undefined : setTimeout(abort, Math.max(0, options.deadline - Date.now()));
  const check = () => { if (controller.signal.aborted) throw new Error("shell_cancelled_or_deadline_exceeded"); };
  const cancellable = async <T>(action: () => Promise<T>): Promise<T> => {
    check();
    return new Promise<T>((resolve, reject) => {
      const stopped = () => reject(new Error("shell_cancelled_or_deadline_exceeded"));
      controller.signal.addEventListener("abort", stopped, { once: true });
      action().then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", stopped));
    });
  };
  const authorize = async (kind: "command" | "file", name: string, access?: "read" | "write") => {
    check();
    if (options.authorize && !await options.authorize({ kind, name, ...(access ? { access } : {}) })) throw new Error(`shell_permission_denied:${name}`);
  };
  const securedFs: VirtualFileSystem = {
    read: async (path) => { await authorize("file", normalizeWorkspacePath(path), "read"); return fs.read(path); },
    list: async () => { await authorize("file", "/workspace", "read"); return fs.list(); },
    ...(fs.write ? { write: async (path: string, contents: string) => { await authorize("file", normalizeWorkspacePath(path), "write"); await fs.write!(path, contents); } } : {}),
    ...(fs.remove ? { remove: async (path: string) => { await authorize("file", normalizeWorkspacePath(path), "write"); await fs.remove!(path); } } : {}),
  };
  const expand = (text: string) => text.replace(/\u0001([^\u0002]+)\u0002/g, (_, name: string) => environment[name] ?? "");
  const limit = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    const max = Math.max(1, options.maxOutputBytes ?? 65_536);
    if (bytes.length <= max) return value;
    events.push({ type: "output_limit", name: "stdout/stderr", data: { bytes: bytes.length, max } });
    return new TextDecoder().decode(bytes.subarray(0, max));
  };
  try {
    // This is intentionally the first awaited operation: no filesystem/API handler can run first.
    if (options.writeGuard) await inspectMutation(command, { ...options.writeGuard, kind: "shell" });
    for (const pipeline of parseShell(command, environment, true)) {
      if (pipeline.when === "success" && exit_code !== 0 || pipeline.when === "failure" && exit_code === 0) continue;
      let input = "", pipelineCode = 0;
      for (const item of pipeline.commands) {
        check();
        const words = item.argv.map(expand);
        const assignments = Object.fromEntries(Object.entries(item.environment).map(([key, value]) => [key, expand(value)]));
        if (!words.length) { Object.assign(environment, assignments); continue; }
        await authorize("command", words[0]!);
        for (const redirect of item.redirects.filter((r) => r.mode === "read")) input = await inputFromFiles(securedFs, [expand(redirect.path)], "");
        let intercepted: VirtualShellResult | null | undefined;
        const value: VirtualShellResult = await cancellable(async () => {
          const resolved = await options.resolve?.(words, input, { signal: controller.signal, environment: { ...environment, ...assignments } });
          intercepted = resolved ?? await options.cli?.execute(words, input);
          return intercepted ?? { exit_code: 0, stdout: await stage(securedFs, words, input) };
        });
        check();
        if (!intercepted && (words[0] === "false" || words[0] === "grep" && value.stdout === "" || words[0] === "diff" && value.stdout !== "")) value.exit_code = 1;
        let visibleOut = limit(value.stdout), visibleError = limit(value.stderr ?? "");
        for (const redirect of item.redirects.filter((r) => r.mode !== "read")) {
          if (!securedFs.write) throw new Error("filesystem_write_unavailable");
          const path = normalizeWorkspacePath(expand(redirect.path));
          const prior = redirect.mode === "append" ? await securedFs.read(path) ?? "" : "";
          await securedFs.write(path, prior + (redirect.fd === 2 ? visibleError : visibleOut));
          if (redirect.fd === 2) visibleError = ""; else visibleOut = "";
        }
        input = visibleOut;
        stderr = limit(stderr + visibleError);
        pipelineCode = options.pipefail && pipelineCode ? pipelineCode : value.exit_code;
        events.push({ type: "command", name: words[0]!, data: { exit_code: value.exit_code } }, ...(value.events ?? []));
      }
      exit_code = pipelineCode; stdout = limit(stdout + input);
    }
    return { exit_code, stdout, ...(stderr ? { stderr } : {}), ...(events.length ? { events } : {}) };
  } catch (error) {
    return {
      exit_code: controller.signal.aborted ? 130 : 1,
      stdout,
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
