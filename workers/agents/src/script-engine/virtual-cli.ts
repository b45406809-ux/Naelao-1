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
