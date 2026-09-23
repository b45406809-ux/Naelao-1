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
  if (words[0] === "see" && words[1]) {
    return { operation: "browser.screenshot", params: { url: words[1], ...(words[2] === "--crop" && words[3] ? { crop: words[3] } : {}) } };
  }
  const scoped = words[0]?.match(/^(?:ext|auto):([a-z][a-z0-9_-]*)$/i);
  if (scoped) return { operation: scoped[1]!, params: { argv: words.slice(1) } };
  if (words[0] === "avos" && words[1]) return { operation: `avos-${words[1]}`, params: { argv: words.slice(2) } };
  return null;
}
