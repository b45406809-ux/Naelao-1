export class VirtualPosixShell {
  private cwd: string = "/";

  constructor(
    private sql: any,
    private keyPrefix: string = ""
  ) {}

  getCwd(): string {
    return this.cwd;
  }

  setCwd(path: string) {
    this.cwd = path;
  }

  // helper to resolve absolute R2/SQLite key path
  private resolveToKey(relativePath: string): string {
    let absolutePath = relativePath;
    if (!relativePath.startsWith("/")) {
      absolutePath = this.cwd === "/" ? `/${relativePath}` : `${this.cwd}/${relativePath}`;
    }
    // Normalize dot segments
    const parts = absolutePath.split("/").filter(Boolean);
    const stack: string[] = [];
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") {
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    const cleanPath = stack.join("/");
    return `${this.keyPrefix}${cleanPath}`;
  }

  async readFile(path: string): Promise<string> {
    const rows = this.sql.exec(`SELECT content FROM workspace_files WHERE path = ?`, path).toArray();
    if (rows.length === 0) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return rows[0].content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const size = content.length;
    const now = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO workspace_files (path, content, size, updated_at) VALUES (?, ?, ?, ?)`,
      path, content, size, now
    );
  }

  async unlink(path: string): Promise<void> {
    this.sql.exec(`DELETE FROM workspace_files WHERE path = ?`, path);
  }

  async readdir(pathPrefix: string): Promise<string[]> {
    const prefix = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
    const rows = this.sql.exec(`SELECT path FROM workspace_files WHERE path LIKE ?`, `${prefix}%`).toArray();
    const entries = new Set<string>();
    for (const row of rows) {
      const relative = row.path.slice(prefix.length);
      if (!relative) continue;
      const firstSlash = relative.indexOf("/");
      if (firstSlash === -1) {
        entries.add(relative);
      } else {
        entries.add(relative.slice(0, firstSlash));
      }
    }
    return Array.from(entries);
  }

  // parse and execute a command
  async exec(command: string, envVars: Record<string, string> = {}, cwd: string = this.cwd): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
    const startTime = Date.now();
    this.cwd = cwd;

    // 1. Tokenize command
    const tokens = this.tokenizeCommand(command);
    if (tokens.length === 0) {
      return { stdout: "", stderr: "", exitCode: 0, durationMs: Date.now() - startTime };
    }

    // 2. Parse Pipeline
    const parsed = this.parsePipeline(tokens);
    if (parsed.error) {
      return { stdout: "", stderr: parsed.error, exitCode: 2, durationMs: Date.now() - startTime };
    }

    const pipeline = parsed.commands;
    let currentStdin = "";
    let finalStdout = "";
    let finalStderr = "";
    let exitCode = 0;

    for (let i = 0; i < pipeline.length; i++) {
      const stage = pipeline[i];
      const isLast = i === pipeline.length - 1;

      const result = await this.executeSingleCommand(stage.args, currentStdin, envVars);
      if (result.exitCode !== 0) {
        exitCode = result.exitCode;
      }
      finalStderr += result.stderr;

      if (isLast) {
        // Handle redirect for the last command in pipeline
        if (stage.redirectFile) {
          const key = this.resolveToKey(stage.redirectFile);
          let contentToWrite = result.stdout;
          if (stage.redirectAppend) {
            try {
              const existing = await this.readFile(key);
              contentToWrite = existing + contentToWrite;
            } catch {
              // file doesn't exist, behaves like >
            }
          }
          await this.writeFile(key, contentToWrite);
          finalStdout = ""; // redirected output doesn't print to screen
        } else {
          finalStdout = result.stdout;
        }
      } else {
        currentStdin = result.stdout;
      }
    }

    return {
      stdout: finalStdout,
      stderr: finalStderr,
      exitCode,
      durationMs: Date.now() - startTime
    };
  }

  private tokenizeCommand(cmdLine: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inDoubleQuotes = false;
    let inSingleQuotes = false;
    let i = 0;
    while (i < cmdLine.length) {
      const char = cmdLine[i];
      if (char === '"' && !inSingleQuotes) {
        inDoubleQuotes = !inDoubleQuotes;
      } else if (char === "'" && !inDoubleQuotes) {
        inSingleQuotes = !inSingleQuotes;
      } else if (!inDoubleQuotes && !inSingleQuotes && (char === " " || char === "\t")) {
        if (current) {
          tokens.push(current);
          current = "";
        }
      } else if (!inDoubleQuotes && !inSingleQuotes && (char === "|" || char === ">")) {
        if (current) {
          tokens.push(current);
          current = "";
        }
        if (char === ">" && cmdLine[i + 1] === ">") {
          tokens.push(">>");
          i++;
        } else {
          tokens.push(char);
        }
      } else {
        current += char;
      }
      i++;
    }
    if (current) {
      tokens.push(current);
    }
    return tokens;
  }

  private parsePipeline(tokens: string[]): { commands: ParsedCommand[]; error?: string } {
    const commands: ParsedCommand[] = [];
    let currentArgs: string[] = [];
    let redirectFile: string | undefined;
    let redirectAppend = false;

    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "|") {
        if (currentArgs.length === 0) {
          return { commands: [], error: "Syntax error near '|'" };
        }
        commands.push({ args: currentArgs, redirectFile, redirectAppend });
        currentArgs = [];
        redirectFile = undefined;
        redirectAppend = false;
      } else if (token === ">" || token === ">>") {
        const fileToken = tokens[i + 1];
        if (!fileToken) {
          return { commands: [], error: "Syntax error: missing file for redirection" };
        }
        redirectFile = fileToken;
        redirectAppend = token === ">>";
        i++; // skip file token
      } else {
        currentArgs.push(token);
      }
      i++;
    }

    if (currentArgs.length > 0 || redirectFile) {
      commands.push({ args: currentArgs, redirectFile, redirectAppend });
    }

    return { commands };
  }

  private async executeSingleCommand(args: string[], stdin: string, envVars: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // expand env variables in args
    const expandedArgs = args.map(arg => {
      return arg.replace(/\$([a-zA-Z0-9_]+)/g, (_, name) => {
        return envVars[name] ?? "";
      });
    });

    const cmd = expandedArgs[0];
    if (!cmd) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    switch (cmd) {
      case "cat":
        return this.cmdCat(expandedArgs.slice(1), stdin);
      case "grep":
        return this.cmdGrep(expandedArgs.slice(1), stdin);
      case "sed":
        return this.cmdSed(expandedArgs.slice(1), stdin);
      case "awk":
        return this.cmdAwk(expandedArgs.slice(1), stdin);
      case "jq":
        return this.cmdJq(expandedArgs.slice(1), stdin);
      case "wc":
        return this.cmdWc(expandedArgs.slice(1), stdin);
      case "diff":
        return this.cmdDiff(expandedArgs.slice(1), stdin);
      case "echo":
        return this.cmdEcho(expandedArgs.slice(1));
      case "ls":
        return this.cmdLs(expandedArgs.slice(1));
      case "pwd":
        return { stdout: `${this.cwd}\n`, stderr: "", exitCode: 0 };
      case "cd":
        return this.cmdCd(expandedArgs.slice(1));
      case "touch":
        return this.cmdTouch(expandedArgs.slice(1));
      case "rm":
        return this.cmdRm(expandedArgs.slice(1));
      case "mv":
        return this.cmdMv(expandedArgs.slice(1));
      case "cp":
        return this.cmdCp(expandedArgs.slice(1));
      case "mkdir":
        return this.cmdMkdir(expandedArgs.slice(1));
      case "head":
        return this.cmdHeadTail(expandedArgs.slice(1), stdin, true);
      case "tail":
        return this.cmdHeadTail(expandedArgs.slice(1), stdin, false);
      default:
        return { stdout: "", stderr: `bash: ${cmd}: command not found\n`, exitCode: 127 };
    }
  }

  // command implementations
  private async cmdCat(args: string[], stdin: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (args.length === 0 || (args.length === 1 && args[0] === "-")) {
      return { stdout: stdin, stderr: "", exitCode: 0 };
    }
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for (const arg of args) {
      const key = this.resolveToKey(arg);
      try {
        const content = await this.readFile(key);
        stdout += content;
      } catch {
        stderr += `cat: ${arg}: No such file or directory\n`;
        exitCode = 1;
      }
    }
    return { stdout, stderr, exitCode };
  }

  private async cmdGrep(args: string[], stdin: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let caseInsensitive = false;
    let invertMatch = false;
    let showLineNumbers = false;
    let useRegex = false;
    let pattern = "";
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith("-")) {
        if (arg.includes("i")) caseInsensitive = true;
        if (arg.includes("v")) invertMatch = true;
        if (arg.includes("n")) showLineNumbers = true;
        if (arg.includes("E")) useRegex = true;
      } else if (!pattern) {
        pattern = arg;
      } else {
        files.push(arg);
      }
    }

    if (!pattern) {
      return { stdout: "", stderr: "grep: pattern required\n", exitCode: 2 };
    }

    let linesToSearch: { text: string; file?: string }[] = [];
    if (files.length === 0) {
      linesToSearch = stdin.split(/\r?\n/).map(line => ({ text: line }));
    } else {
      for (const file of files) {
        const key = this.resolveToKey(file);
        try {
          const content = await this.readFile(key);
          const fileLines = content.split(/\r?\n/);
          // Remove the very last empty line if Split generated it from trailing newline
          if (fileLines.length > 1 && fileLines[fileLines.length - 1] === "") {
            fileLines.pop();
          }
          linesToSearch.push(...fileLines.map(line => ({ text: line, file })));
        } catch {
          return { stdout: "", stderr: `grep: ${file}: No such file or directory\n`, exitCode: 2 };
        }
      }
    }

    let regex: RegExp;
    if (useRegex) {
      regex = new RegExp(pattern, caseInsensitive ? "i" : "");
    } else {
      // Escape regex chars for literal match
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      regex = new RegExp(escaped, caseInsensitive ? "i" : "");
    }

    const matches: string[] = [];
    for (let idx = 0; idx < linesToSearch.length; idx++) {
      const lineObj = linesToSearch[idx];
      const matchesPattern = regex.test(lineObj.text);
      const isMatch = invertMatch ? !matchesPattern : matchesPattern;

      if (isMatch) {
        let matchedLine = "";
        if (files.length > 1 && lineObj.file) {
          matchedLine += `${lineObj.file}:`;
        }
        if (showLineNumbers) {
          matchedLine += `${idx + 1}:`;
        }
        matchedLine += lineObj.text;
        matches.push(matchedLine);
      }
    }

    const stdout = matches.join("\n") + (matches.length > 0 ? "\n" : "");
    return { stdout, stderr: "", exitCode: matches.length > 0 ? 0 : 1 };
  }

  private async cmdSed(args: string[], stdin: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (args.length === 0) {
      return { stdout: "", stderr: "sed: missing expression\n", exitCode: 1 };
    }
    const expr = args[0];
    const file = args[1];

    // Parse sed expression like s/foo/bar/g or s|foo|bar|g
    const match = expr.match(/^s(.)(.*)\1(.*)\1([g]*)$/);
    if (!match) {
      return { stdout: "", stderr: `sed: invalid expression '${expr}'\n`, exitCode: 1 };
    }
    const search = match[2];
    const replace = match[3];
    const global = match[4].includes("g");

    let content = stdin;
    if (file) {
      try {
        content = await this.readFile(this.resolveToKey(file));
      } catch {
        return { stdout: "", stderr: `sed: ${file}: No such file or directory\n`, exitCode: 1 };
      }
    }

    const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), global ? "g" : "");
    const lines = content.split(/\r?\n/);
    const replacedLines = lines.map(line => line.replace(regex, replace));
    const stdout = replacedLines.join("\n");

    return { stdout, stderr: "", exitCode: 0 };
  }

  private async cmdAwk(args: string[], stdin: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (args.length === 0) {
      return { stdout: "", stderr: "awk: missing expression\n", exitCode: 1 };
    }
    const expr = args[0];
    const file = args[1];

    // Simple print support: {print $1, $2}
    const printMatch = expr.match(/\{print\s+(.*)\}/);
    if (!printMatch) {
      return { stdout: "", stderr: `awk: expression format not fully supported. Use '{print $1, $2}'\n`, exitCode: 1 };
    }

    const fieldsToPrint = printMatch[1].split(/[\s,]+/).map(f => f.trim());

    let content = stdin;
    if (file) {
      try {
        content = await this.readFile(this.resolveToKey(file));
      } catch {
        return { stdout: "", stderr: `awk: ${file}: No such file or directory\n`, exitCode: 1 };
      }
    }

    const lines = content.split(/\r?\n/);
    const outputLines: string[] = [];
    for (const line of lines) {
      if (line.trim() === "") continue;
      const columns = line.trim().split(/\s+/);
      const lineOutput = fieldsToPrint.map(field => {
        if (field === "$0") return line;
        if (field.startsWith("$")) {
          const idx = parseInt(field.slice(1), 10);
          if (idx > 0 && idx <= columns.length) {
            return columns[idx - 1];
          }
        }
        return "";
      }).join(" ");
      outputLines.push(lineOutput);
    }

    return { stdout: outputLines.join("\n") + (outputLines.length > 0 ? "\n" : ""), stderr: "", exitCode: 0 };
  }

  private async cmdJq(args: string[], stdin: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const query = args[0] ?? ".";
    const file = args[1];

    let content = stdin;
    if (file) {
      try {
        content = await this.readFile(this.resolveToKey(file));
      } catch {
        return { stdout: "", stderr: `jq: ${file}: No such file or directory\n`, exitCode: 1 };
      }
    }

    let parsedJson: any;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      return { stdout: "", stderr: "jq: invalid JSON input\n", exitCode: 1 };
    }

    if (query === "." || query === "'.'") {
      return { stdout: JSON.stringify(parsedJson, null, 2) + "\n", stderr: "", exitCode: 0 };
    }

    // Simple key path extraction like .foo.bar
    const cleanQuery = query.replace(/^'|'$/g, "").trim();
    if (cleanQuery.startsWith(".")) {
      const keys = cleanQuery.split(".").filter(Boolean);
      let current = parsedJson;
      for (const k of keys) {
        if (current && typeof current === "object" && k in current) {
          current = current[k];
        } else {
          current = null;
          break;
        }
      }
      const stdout = (typeof current === "string" ? current : JSON.stringify(current, null, 2)) + "\n";
      return { stdout, stderr: "", exitCode: 0 };
    }

    return { stdout: JSON.stringify(parsedJson, null, 2) + "\n", stderr: "", exitCode: 0 };
  }

  private async cmdWc(args: string[], stdin: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let countLines = false;
    let countWords = false;
    let countChars = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg.startsWith("-")) {
        if (arg.includes("l")) countLines = true;
        if (arg.includes("w")) countWords = true;
        if (arg.includes("c") || arg.includes("m")) countChars = true;
      } else {
        files.push(arg);
      }
    }

    // default is to count all
    if (!countLines && !countWords && !countChars) {
      countLines = true;
      countWords = true;
      countChars = true;
    }

    const getStats = (text: string) => {
      const lines = text.split(/\r?\n/).length - 1; // standard POSIX lines end with \n
      const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
      const chars = text.length;
      return { lines, words, chars };
    };

    if (files.length === 0) {
      const { lines, words, chars } = getStats(stdin);
      let out = "";
      if (countLines) out += `${lines} `;
      if (countWords) out += `${words} `;
      if (countChars) out += `${chars} `;
      return { stdout: out.trim() + "\n", stderr: "", exitCode: 0 };
    }

    let totalLines = 0;
    let totalWords = 0;
    let totalChars = 0;
    let out = "";

    for (const file of files) {
      const key = this.resolveToKey(file);
      try {
        const content = await this.readFile(key);
        const { lines, words, chars } = getStats(content);
        totalLines += lines;
        totalWords += words;
        totalChars += chars;

        let fileOut = "";
        if (countLines) fileOut += `${lines} `;
        if (countWords) fileOut += `${words} `;
        if (countChars) fileOut += `${chars} `;
        out += `${fileOut.trim()} ${file}\n`;
      } catch {
        return { stdout: "", stderr: `wc: ${file}: No such file or directory\n`, exitCode: 1 };
      }
    }

    if (files.length > 1) {
      let totalOut = "";
      if (countLines) totalOut += `${totalLines} `;
      if (countWords) totalOut += `${totalWords} `;
      if (countChars) totalOut += `${totalChars} `;
      out += `${totalOut.trim()} total\n`;
    }

    return { stdout: out, stderr: "", exitCode: 0 };
  }

  private async cmdDiff(args: string[], stdin: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (args.length < 2) {
      return { stdout: "", stderr: "diff: missing operand\n", exitCode: 2 };
    }
    const f1 = args[0];
    const f2 = args[1];

    let content1 = "";
    let content2 = "";

    try {
      content1 = await this.readFile(this.resolveToKey(f1));
    } catch {
      return { stdout: "", stderr: `diff: ${f1}: No such file or directory\n`, exitCode: 2 };
    }

    try {
      content2 = await this.readFile(this.resolveToKey(f2));
    } catch {
      return { stdout: "", stderr: `diff: ${f2}: No such file or directory\n`, exitCode: 2 };
    }

    const l1 = content1.split(/\r?\n/);
    const l2 = content2.split(/\r?\n/);

    const diffLines: string[] = [];
    const max = Math.max(l1.length, l2.length);
    for (let i = 0; i < max; i++) {
      const line1 = l1[i];
      const line2 = l2[i];
      if (line1 !== line2) {
        if (line1 !== undefined) diffLines.push(`< ${line1}`);
        if (line2 !== undefined) diffLines.push(`> ${line2}`);
      }
    }

    const stdout = diffLines.join("\n") + (diffLines.length > 0 ? "\n" : "");
    return { stdout, stderr: "", exitCode: diffLines.length > 0 ? 1 : 0 };
  }

  private cmdEcho(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    let noNewline = false;
    let actualArgs = args;
    if (args[0] === "-n") {
      noNewline = true;
      actualArgs = args.slice(1);
    }
    const out = actualArgs.join(" ") + (noNewline ? "" : "\n");
    return { stdout: out, stderr: "", exitCode: 0 };
  }

  private async cmdLs(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let target = ".";
    for (const arg of args) {
      if (!arg.startsWith("-")) {
        target = arg;
      }
    }

    const key = this.resolveToKey(target);
    try {
      // Is it a file?
      try {
        await this.readFile(key);
        return { stdout: `${target}\n`, stderr: "", exitCode: 0 };
      } catch {
        // If not a file, it must be a directory prefix
        const prefix = key.endsWith("/") ? key : `${key}/`;
        const entries = await this.readdir(prefix);
        if (entries.length === 0) {
          // Check if directory exists at all (is there any file matching paths under key)
          const rows = this.sql.exec(`SELECT count(*) as cnt FROM workspace_files WHERE path LIKE ?`, `${prefix}%`).toArray();
          if (rows[0].cnt === 0 && target !== "." && target !== "/") {
            return { stdout: "", stderr: `ls: cannot access '${target}': No such file or directory\n`, exitCode: 2 };
          }
        }
        const stdout = entries.join("\n") + (entries.length > 0 ? "\n" : "");
        return { stdout, stderr: "", exitCode: 0 };
      }
    } catch (err) {
      return { stdout: "", stderr: `ls: cannot access '${target}': No such file or directory\n`, exitCode: 2 };
    }
  }

  private cmdCd(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    let target = args[0] ?? "/";
    if (target === "/") {
      this.cwd = "/";
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    // Resolve CD target
    let absolutePath = target;
    if (!target.startsWith("/")) {
      absolutePath = this.cwd === "/" ? `/${target}` : `${this.cwd}/${target}`;
    }
    const parts = absolutePath.split("/").filter(Boolean);
    const stack: string[] = [];
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") {
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    this.cwd = "/" + stack.join("/");
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  private async cmdTouch(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    for (const arg of args) {
      const key = this.resolveToKey(arg);
      try {
        await this.readFile(key);
        // already exists, just update timestamp (no-op in SQLite size, just update updated_at)
        this.sql.exec(`UPDATE workspace_files SET updated_at = ? WHERE path = ?`, Date.now(), key);
      } catch {
        await this.writeFile(key, "");
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  private async cmdRm(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let recursive = false;
    const files: string[] = [];
    for (const arg of args) {
      if (arg.startsWith("-") && arg.includes("r")) {
        recursive = true;
      } else {
        files.push(arg);
      }
    }

    for (const file of files) {
      const key = this.resolveToKey(file);
      if (recursive) {
        // Delete directories recursively too
        this.sql.exec(`DELETE FROM workspace_files WHERE path = ? OR path LIKE ?`, key, `${key}/%`);
      } else {
        this.sql.exec(`DELETE FROM workspace_files WHERE path = ?`, key);
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  private async cmdMv(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (args.length < 2) {
      return { stdout: "", stderr: "mv: missing destination file operand\n", exitCode: 1 };
    }
    const src = args[0];
    const dest = args[1];

    const srcKey = this.resolveToKey(src);
    const destKey = this.resolveToKey(dest);

    try {
      const content = await this.readFile(srcKey);
      await this.writeFile(destKey, content);
      await this.unlink(srcKey);
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch {
      return { stdout: "", stderr: `mv: cannot stat '${src}': No such file or directory\n`, exitCode: 1 };
    }
  }

  private async cmdCp(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (args.length < 2) {
      return { stdout: "", stderr: "cp: missing destination file operand\n", exitCode: 1 };
    }
    const src = args[0];
    const dest = args[1];

    const srcKey = this.resolveToKey(src);
    const destKey = this.resolveToKey(dest);

    try {
      const content = await this.readFile(srcKey);
      await this.writeFile(destKey, content);
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch {
      return { stdout: "", stderr: `cp: cannot stat '${src}': No such file or directory\n`, exitCode: 1 };
    }
  }

  private cmdMkdir(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    // Since SQLite does not have real directory entries, mkdir is a virtual operation (no-op)
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  private async cmdHeadTail(args: string[], stdin: string, isHead: boolean): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let linesCount = 10;
    let file: string | undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-n" && args[i + 1]) {
        linesCount = parseInt(args[i + 1], 10);
        i++;
      } else if (arg.startsWith("-") && /^\d+$/.test(arg.slice(1))) {
        linesCount = parseInt(arg.slice(1), 10);
      } else {
        file = arg;
      }
    }

    let content = stdin;
    if (file) {
      try {
        content = await this.readFile(this.resolveToKey(file));
      } catch {
        return { stdout: "", stderr: `head: ${file}: No such file or directory\n`, exitCode: 1 };
      }
    }

    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    const selectedLines = isHead ? lines.slice(0, linesCount) : lines.slice(-linesCount);
    const stdout = selectedLines.join("\n") + (selectedLines.length > 0 ? "\n" : "");
    return { stdout, stderr: "", exitCode: 0 };
  }
}

interface ParsedCommand {
  args: string[];
  redirectFile?: string;
  redirectAppend?: boolean;
}
