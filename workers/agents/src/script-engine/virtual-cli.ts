export interface CliDispatch {
  operation: string;
  params: Record<string, unknown>;
}

/** Shell-word parser without eval, substitution, redirection, or expansion. */
export function parseCliWords(command: string): string[] {
  if (/[`;]|\$\(|\n|\r/.test(command)) throw new Error("unsafe_cli_syntax");
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { words.push(current); current = ""; } continue; }
    current += char;
  }
  if (escaped || quote) throw new Error("unterminated_cli_token");
  if (current) words.push(current);
  return words;
}

/** Maps terminal-native platform commands to existing authorized production operations. */
export function interceptPlatformCli(command: string): CliDispatch | null {
  const words = parseCliWords(command);
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
  const scoped = words[0]?.match(/^(?:ext|auto):([a-z][a-z0-9_-]*)$/i);
  if (scoped) return { operation: scoped[1]!, params: { argv: words.slice(1) } };
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
export interface VirtualCliContext { vault: VirtualCliVault; tenantId: string; spaceId: string; projectId?: string }
export interface VirtualCliResult { exit_code: number; stdout: string; stderr?: string }

const API_COMMANDS = new Set(["stripe", "gh", "r2", "resend"]);
export function isRegisteredVirtualCli(name: string): boolean { return API_COMMANDS.has(name) || name === "jq"; }

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
    if (command === "jq") return { exit_code: 0, stdout: jqValue(args[0] ?? ".", stdin) };
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
    } else {
      const [bucket, action = "list"] = positional;
      if (!bucket) throw new Error("usage: r2 <bucket> <action>");
      url = `https://api.cloudflare.com/client/v4/r2/buckets/${encodeURIComponent(bucket)}/${encodeURIComponent(action!)}`;
      credentialName = "CLOUDFLARE_API_TOKEN"; method = action === "list" || action === "get" ? "GET" : "POST";
    }
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
