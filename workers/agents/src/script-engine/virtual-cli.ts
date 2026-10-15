import { parseShell, shellWords } from "./shell-parser.js";

export interface CliDispatch {
  operation: string;
  params: Record<string, unknown>;
}

/**
 * Planner coordination commands. These are deliberately parsed here, at the Bash boundary,
 * rather than exposed as native model tools. The planner gets one stable shell-shaped interface;
 * the operation names and structured payloads stay internal to the worker runtime.
 */
function plannerCoordinationCli(words: string[], rawCommand?: string): CliDispatch | null {
  if (words[0] !== "naelao") return null;
  if (words[1] === "tunnel") {
    const action = words[2] ?? "list";
    const { positional, body } = bodyAndFlags(words.slice(3));
    if (!["list", "inspect", "exec", "status", "cancel"].includes(action)) throw new Error("usage: naelao tunnel list|inspect|exec|status|cancel");
    if (action !== "list" && !positional[0]) throw new Error("tunnel requires an explicit machine name");
    if (action === "exec" && typeof body.command !== "string") throw new Error("usage: naelao tunnel exec <machine> --command <command> [--request-id <id>]");
    if (action === "cancel" && !body.request_id) throw new Error("cancel requires --request-id");
    return { operation: "tunnel." + action, params: { ...body, machine: positional[0] } };
  }

  if (words[1] === "project" && words[2] === "agents") {
    const action = words[3] ?? "list";
    if (action === "list") return { operation: "thread.list_project_agents", params: {} };
    const { body } = bodyAndFlags(words.slice(4));
    if (action === "consult") {
      if (typeof body.agent_id !== "string" || typeof body.message !== "string") {
        throw new Error("usage: naelao project agents consult --agent-id <id> --message <text>");
      }
      return { operation: "thread.consult", params: body };
    }
    if (action === "delegate") {
      if (typeof body.agent_id !== "string" || typeof body.task !== "string") {
        throw new Error("usage: naelao project agents delegate --agent-id <id> --task <text>");
      }
      return { operation: "thread.delegate", params: body };
    }
    throw new Error("usage: naelao project agents [list|consult|delegate] ...");
  }

  if (words[1] === "worker" && words[2]) {
    if (words[2] === "run" || words.includes("--task")) {
      const workerId = words[2] === "run" ? words[3] : words[2];
      const { body } = bodyAndFlags(words.slice(words[2] === "run" ? 4 : 3));
      if (!workerId || typeof body.task !== "string" || !body.task.trim()) throw new Error("usage: naelao worker run <worker_id> --task <objective>");
      return { operation: "delegate_to_space_worker", params: { worker_id: workerId, task: body.task } };
    }
    const workerId = words[2];
    const { positional, body } = bodyAndFlags(words.slice(3));
    const operation = typeof body.operation === "string" ? body.operation : positional[0];
    if (!operation) throw new Error("usage: naelao worker <worker_id> <operation> [--params <json>]");
    let params: Record<string, unknown> = {};
    if (body.params !== undefined) {
      try {
        const parsed = rawJsonFlag(rawCommand, "--params") ?? (typeof body.params === "string" ? JSON.parse(body.params) : body.params);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
        params = parsed as Record<string, unknown>;
      } catch {
        throw new Error("naelao worker --params must be a JSON object");
      }
    }
    return {
      operation: "delegate_to_space_worker",
      params: { worker_id: workerId, task: { operation, params } },
    };
  }

  throw new Error("usage: naelao project agents list|consult|delegate or naelao worker <worker_id> <operation>");
}

/** Recover JSON flags before shell tokenization removes JSON's inner quotes. */
function rawJsonFlag(command: string | undefined, flag: string): unknown {
  if (!command) return undefined;
  const marker = command.indexOf(flag);
  if (marker < 0) return undefined;
  let raw = command.slice(marker + flag.length).trim();
  if (!raw) return undefined;
  if (raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1);
  const candidates = [raw, raw.replace(/\\\\"/g, '"')];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const objectText = raw.slice(start, end + 1);
    candidates.push(objectText, objectText.replace(/\\\\"/g, '"'));
  }
  for (const candidate of candidates) {
    try {
      const first = JSON.parse(candidate);
      return typeof first === "string" ? JSON.parse(first) : first;
    } catch {
      // Try the next shell-quoting representation.
    }
  }
  return undefined;
}

/** Shell-word parser without eval, substitution, redirection, or expansion. */
export function parseCliWords(command: string): string[] {
  return shellWords(command);
}

/** Maps terminal-native platform commands to existing authorized production operations. */
export function interceptPlatformCli(command: string): CliDispatch | null {
  const tree = parseShell(command);
  if (tree.length !== 1 || tree[0]!.commands.length !== 1 || tree[0]!.commands[0]!.redirects.length) return null;
  const words = tree[0]!.commands[0]!.argv;
  return interceptPlatformWords(words, command);
}

export function interceptPlatformWords(words: string[], command?: string): CliDispatch | null {
  const plannerCommand = plannerCoordinationCli(words, command);
  if (plannerCommand) return plannerCommand;
  if (words[0] === "runtime") {
    if (words[1] === "list" && words.length === 2) return { operation: "runtime.list", params: {} };
    if (words[1] === "find" && words[2] && words.length === 3) return { operation: "runtime.find", params: { binary: words[2] } };
    throw new Error("usage: runtime list | runtime find <binary>");
  }
  if (words[0] === "lsp") {
    const action = words[1];
    if (!["index", "find-refs", "find-symbol", "get-signatures", "status"].includes(action ?? ""))
      throw new Error("usage: lsp index [path ...] | find-refs <name> | find-symbol <name> | get-signatures <path> | status");
    return { operation: "lsp.command", params: { argv: words.slice(1) } };
  }
  if (words[0] === "workflow" && words[1] === "run" && words[2]) {
    return { operation: "workflow.run", params: { name: words[2], params: {}, detach: words.includes("--detach") } };
  }
  if (words[0] === "schedule" && words[1] === "--cron" && words[2] && words[3]) {
    return { operation: "workflow.schedule", params: { cron: words[2], name: words[3] } };
  }
  if (words[0] === "browse" && words[1]) {
    return { operation: "browser.navigate", params: { url: words[1], save_screenshot: true, accessibility_text: true } };
  }
  if (words[0] === "see") {
    const cropAt = words.indexOf("--crop");
    const path = words[1] && words[1] !== "--crop" ? words[1] : "latest";
    if (path === "display" || path === "computer") return { operation: "computer.see", params: {} };
    return { operation: "browser.see", params: { path, ...(cropAt >= 0 && words[cropAt + 1] ? { crop: words[cropAt + 1] } : {}) } };
  }
  const scoped = words[0]?.match(/^(ext|auto):([a-z][a-z0-9_-]*)$/i);
  if (scoped) return { operation: `${scoped[1]!.toLowerCase()}:${scoped[2]!}`, params: { argv: words.slice(1) } };
  if (words[0] === "avos" && words[1] === "chore" && words[2]) {
    return { operation: "avos.chore", params: { name: words[2], argv: words.slice(3) } };
  }
  if (words[0] === "avos") throw new Error("usage: avos chore <name> [args]");
  return null;
}

export interface VirtualCliVault {
  fetchWithAuth(url: string, options: { credentialName: string; method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response>;
}
export interface SynthesizedCliStore { read(path: string): Promise<string | null>; write(path: string, source: string): Promise<void> }
export interface VirtualCliDaemonRegistry { execute(name: string, argv: string[]): Promise<unknown> }
export interface VirtualCliNamespaceRegistry { execute(name: string, argv: string[]): Promise<unknown> }
export interface MarkdownFetchResult { url: string; status: number; content: string; content_type?: string; format?: string; truncated?: boolean }
export interface VirtualCliContext { vault?: VirtualCliVault; tenantId: string; spaceId: string; projectId?: string; fetchMarkdown?: (url: string) => Promise<MarkdownFetchResult>; daemons?: VirtualCliDaemonRegistry; automations?: VirtualCliNamespaceRegistry; chores?: VirtualCliNamespaceRegistry }
export interface VirtualCliResult { exit_code: number; stdout: string; stderr?: string }

const API_COMMANDS = new Set(["stripe", "gh", "r2", "resend", "twilio"]);
export function isRegisteredVirtualCli(name: string): boolean { return API_COMMANDS.has(name) || name === "jq" || name === "fetch-md"; }

function bodyAndFlags(args: string[]): { positional: string[]; body: Record<string, unknown> } {
  const positional: string[] = [];
  const body: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [raw, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? (args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i] : true);
    body[raw!.replaceAll("-", "_")] = value;
  }
  return { positional, body };
}
async function responseText(response: Response): Promise<string> {
  const text = await response.text();
  if (!response.ok) throw new Error(`virtual_cli_http_${response.status}:${text.slice(0, 300)}`);
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
function jqValue(filter: string, input: string): string {
  let value: unknown = JSON.parse(input);
  if (filter !== ".") {
    if (!/^\.(?:[A-Za-z_$][\w$]*|\d+)(?:\.(?:[A-Za-z_$][\w$]*|\d+))*$/.test(filter)) throw new Error("jq: unsupported deterministic filter");
    for (const key of filter.slice(1).split(".")) value = (value as Record<string, unknown> | undefined)?.[key];
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** Credential-safe V8 dispatcher: only logical vault names cross this boundary. */
export class VirtualCliDispatcher {
  constructor(private readonly ctx: VirtualCliContext, private readonly store?: SynthesizedCliStore) {
    if (!ctx.tenantId || !ctx.spaceId) throw new Error("virtual_cli_scope_required");
  }
  async execute(words: string[], stdin = ""): Promise<VirtualCliResult | null> {
    const [command, ...args] = words;
    if (!command) return null;
    const daemon = command.match(/^ext:([a-z][a-z0-9_-]*)$/i)?.[1];
    if (daemon) {
      if (!this.ctx.daemons) throw new Error("daemon_registry_unavailable");
      const result = await this.ctx.daemons.execute(daemon, args);
      return { exit_code: 0, stdout: JSON.stringify(result, null, 2) };
    }
    const automation = command.match(/^auto:([a-z][a-z0-9_-]*)$/i)?.[1];
    if (automation) {
      if (!this.ctx.automations) throw new Error("automation_registry_unavailable");
      if (!/^(?:trigger|status|pause)$/.test(args[0] ?? "")) throw new Error("usage: auto:<automation> [trigger|status|pause]");
      return { exit_code: 0, stdout: JSON.stringify(await this.ctx.automations.execute(automation, args), null, 2) };
    }
    if (command === "avos") {
      if (args[0] !== "chore" || !args[1]) throw new Error("usage: avos chore <name> [args]");
      if (!this.ctx.chores) throw new Error("chore_registry_unavailable");
      return { exit_code: 0, stdout: JSON.stringify(await this.ctx.chores.execute(args[1], args.slice(2)), null, 2) };
    }
    if (command === "jq") return { exit_code: 0, stdout: jqValue(args[0] ?? ".", stdin) };
    if (command === "fetch-md") {
      if (args.length !== 1 || !/^https?:\/\//i.test(args[0]!)) throw new Error("usage: fetch-md <http(s)-url>");
      if (!this.ctx.fetchMarkdown) throw new Error("fetch-md unavailable: knowledge worker is not configured");
      const result = await this.ctx.fetchMarkdown(args[0]!);
      if (result.status < 200 || result.status >= 300) {
        return { exit_code: 1, stdout: "", stderr: `fetch-md failed (HTTP ${result.status})${result.content ? `: ${result.content.slice(0, 300)}` : ""}` };
      }
      const notes = [
        result.format === "markdown" ? undefined : `Server returned ${result.content_type || "an unspecified content type"}; content is unconverted source, not Markdown-for-agents.`,
        result.truncated ? "Response was truncated at the platform content limit." : undefined,
      ].filter(Boolean).join(" ");
      return { exit_code: 0, stdout: result.content, ...(notes ? { stderr: notes } : {}) };
    }
    if (!API_COMMANDS.has(command)) return null;
    const { positional, body } = bodyAndFlags(args);
    let url: string; let credentialName: string; let method = "GET";
    if (command === "stripe") {
      const [resource, action = "list"] = positional;
      if (!resource) throw new Error("usage: stripe <resource> <action>");
      url = `https://api.stripe.com/v1/${encodeURIComponent(resource)}${action === "list" ? "" : `/${encodeURIComponent(action!)}`}`;
      credentialName = "STRIPE_KEY"; method = action === "list" || action === "retrieve" ? "GET" : "POST";
    } else if (command === "gh") {
      const [resource, action, id] = positional;
      if (!resource) throw new Error("usage: gh <resource> <action>");
      url = `https://api.github.com/${encodeURIComponent(resource)}${id ? `/${encodeURIComponent(id)}` : ""}`;
      credentialName = "GITHUB_TOKEN"; method = action === "list" || action === "get" ? "GET" : action === "delete" ? "DELETE" : "POST";
    } else if (command === "resend") {
      if (positional[0] !== "emails" || positional[1] !== "send") throw new Error("usage: resend emails send [--field value]");
      url = "https://api.resend.com/emails"; credentialName = "RESEND_API_KEY"; method = "POST";
    } else if (command === "r2") {
      const [bucket, action = "list"] = positional;
      if (!bucket) throw new Error("usage: r2 <bucket> <action>");
      url = `https://api.cloudflare.com/client/v4/r2/buckets/${encodeURIComponent(bucket)}/${encodeURIComponent(action!)}`;
      credentialName = "CLOUDFLARE_API_TOKEN"; method = action === "list" || action === "get" ? "GET" : "POST";
    } else {
      const [resource, action] = positional;
      if (!resource || !action) throw new Error("usage: twilio <resource> <action> [--field value]");
      url = `https://api.twilio.com/2010-04-01/${encodeURIComponent(resource)}/${encodeURIComponent(action)}.json`;
      credentialName = "TWILIO_AUTH_TOKEN"; method = action === "list" || action === "get" ? "GET" : "POST";
    }
    if (!this.ctx.vault) throw new Error("virtual_cli_credentials_unavailable");
    const response = await this.ctx.vault.fetchWithAuth(url, { credentialName, method, ...(method !== "GET" ? { body } : {}), headers: { "content-type": "application/json" } });
    return { exit_code: 0, stdout: await responseText(response) };
  }
  static validateSynthesized(name: string, source: string): void {
    if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(name)) throw new Error("invalid_command_name");
    // Persisted commands created before the TypeScript annotation requirement used the same
    // two-argument ABI as plain JavaScript. Accept both spellings while still rejecting any
    // different export/signature.
    if (source.length > 16_384 || !/export\s+async\s+function\s+run\s*\(\s*args(?:\s*:\s*string\[\])?\s*,\s*ctx(?:\s*:\s*RuntimeContext)?\s*\)/.test(source)) throw new Error("invalid_synthesized_command_schema");
    if (/\b(?:eval|Function)\s*\(|\bimport\s*\(|\b(?:WebSocket|connect|createConnection|Deno)\b|\b(?:process\.env|ctx\.vault\.(?:get|read)|STRIPE_KEY|GITHUB_TOKEN|RESEND_API_KEY)\b/.test(source)) throw new Error("unsafe_synthesized_command");
    if (/\$\{[^}]+\}/.test(source)) throw new Error("unsafe_string_interpolation");
  }
  async registerSynthesized(name: string, source: string): Promise<string> {
    VirtualCliDispatcher.validateSynthesized(name, source);
    if (!this.store) throw new Error("virtual_cli_store_unavailable");
    const path = `/.avos/bin/${name}.ts`;
    await this.store.write(path, source);
    return path;
  }
}
