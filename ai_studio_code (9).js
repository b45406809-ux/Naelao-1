#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = new URL(".", import.meta.url).pathname;
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv[i + 1];
};

const manifest = JSON.parse(await readFile(new URL("repomix/phases.json", import.meta.url), "utf8"));
const registry = JSON.parse(await readFile(new URL("repomix/provider-models.json", import.meta.url), "utf8"));

const start = Number(value("--start", process.env.PHASE_START ?? 1));
const end = Number(value("--end", process.env.PHASE_END ?? manifest.phases.length));
const maxTurns = Number(value("--max-turns", process.env.MAX_TURNS_PER_PHASE ?? 20));
const baseCompactThreshold = Number(value("--compact-tokens", process.env.COMPACT_TOKENS ?? 45000));
const verifyCommand = value("--verify", process.env.PHASE_VERIFY_COMMAND ?? "pnpm typecheck && pnpm test");
const dryRun = argv.includes("--dry-run");

const keys = {
  gemini: (process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY ?? "").split(",").filter(Boolean),
  groq: (process.env.GROQ_API_KEYS ?? process.env.GROQ_API_KEY ?? "").split(",").filter(Boolean),
  openrouter: (process.env.OPENROUTER_API_KEYS ?? process.env.OPENROUTER_API_KEY ?? "").split(",").filter(Boolean),
};

const requested = (value("--providers", process.env.AI_PROVIDERS ?? "gemini,openrouter,groq")).split(",");
let models = Object.entries(registry.providers)
  .flatMap(([provider, p]) => (requested.includes(provider) && keys[provider].length ? p.models.map((m) => ({ ...m, provider, endpoint: p.endpoint })) : []))
  .sort((a, b) => b.rank - a.rank);

if (!dryRun && !models.length) throw new Error("Configure at least one valid API key");

await mkdir(new URL(".phase-runs/", import.meta.url), { recursive: true });

async function runCmd(cmd, args = [], options = {}) {
  try {
    const res = await exec(cmd, args, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, ...options });
    return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message, exitCode: err.code ?? 1 };
  }
}

const tokenEstimate = (s) => Math.ceil((typeof s === "string" ? s.length : JSON.stringify(s).length) / 3.5);

// ============================================================================
// 1. REPO INDEXER
// ============================================================================
class RepoIndexer {
  constructor() {
    this.files = [];
    this.symbolIndex = new Map();
  }

  async index() {
    const res = await runCmd("git", ["ls-files"]);
    this.files = res.stdout.trim().split("\n").filter((f) => {
      return f && !/(^|\/)(pnpm-lock\.yaml|package-lock\.json|\.phase-runs|\.repomix-cache|dist|coverage)\//.test(f)
               && !/\.(png|jpg|jpeg|gif|svg|ico|pdf|woff2?|map|lock)$/.test(f);
    });
  }

  async buildSymbolIndex() {
    const targets = this.files.filter((f) => /\.(ts|tsx|js|mjs)$/.test(f)).slice(0, 400);
    for (const f of targets) {
      try {
        const text = await readFile(join(ROOT, f), "utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const m = line.match(/(?:export\s+)?(?:class|interface|type|function|const|enum)\s+([A-Za-z0-9_$]+)/);
          if (m) {
            const sym = m[1];
            if (!this.symbolIndex.has(sym)) this.symbolIndex.set(sym, []);
            this.symbolIndex.get(sym).push({ file: f, line: i + 1, snippet: line.trim() });
          }
        }
      } catch {}
    }
  }

  searchSymbols(query) {
    const results = [];
    const q = query.toLowerCase();
    for (const [sym, locs] of this.symbolIndex.entries()) {
      if (sym.toLowerCase().includes(q)) results.push(...locs);
    }
    return results.slice(0, 20);
  }

  async grep(regexStr, maxResults = 30) {
    const res = await runCmd("git", ["grep", "-n", "-I", "-E", "-e", regexStr]);
    if (res.exitCode !== 0 || !res.stdout) return "No matches found.";
    return res.stdout.split("\n").slice(0, maxResults).join("\n");
  }
}

const indexer = new RepoIndexer();
await indexer.index();
await indexer.buildSymbolIndex();

// ============================================================================
// 2. TOOL DEFINITIONS
// ============================================================================
const TOOL_DEFINITIONS = [
  {
    name: "read_file",
    description: "Read file contents with line numbers. Use start_line and line_count for slices.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to file" },
        start_line: { type: "number", description: "Line number to start from (1-based)" },
        line_count: { type: "number", description: "Number of lines to read (max 250)" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_file",
    description: "Replace target string with replacement text in a file. Must be exact and unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to file" },
        old_str: { type: "string", description: "Exact text to find and replace" },
        new_str: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file (creates parent directories automatically).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to file" },
        content: { type: "string", description: "Full content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "bash_execute",
    description: "Run shell commands, targeted tests (e.g. pnpm --filter @naelao/tests test), mkdir, etc.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command" },
      },
      required: ["command"],
    },
  },
  {
    name: "list_dir",
    description: "List directory contents.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to directory" },
      },
      required: ["path"],
    },
  },
  {
    name: "grep_search",
    description: "Search for regex or pattern across repository files.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search pattern" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_symbol",
    description: "Search symbol index for classes, interfaces, and functions.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "complete_phase",
    description: "Declare the micro-phase goal fully implemented and verified.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Executive completion summary" },
      },
      required: ["summary"],
    },
  },
];

// ============================================================================
// 3. TOOL EXECUTION
// ============================================================================
async function executeTool(name, args, state) {
  state.toolCallCount++;
  try {
    switch (name) {
      case "read_file": {
        const fullPath = join(ROOT, args.path);
        const content = await readFile(fullPath, "utf8");
        const lines = content.split("\n");
        const startLine = Math.max(1, args.start_line ?? 1);
        const count = Math.min(250, args.line_count ?? lines.length);
        const slice = lines.slice(startLine - 1, startLine - 1 + count);
        return slice.map((l, i) => `${startLine + i} | ${l}`).join("\n");
      }

      case "edit_file": {
        const fullPath = join(ROOT, args.path);
        let content = await readFile(fullPath, "utf8");
        const hasCRLF = content.includes("\r\n");
        if (hasCRLF) content = content.replace(/\r\n/g, "\n");
        const oldStr = args.old_str.replace(/\r\n/g, "\n");
        const newStr = args.new_str.replace(/\r\n/g, "\n");

        const count = content.split(oldStr).length - 1;
        if (count === 0) {
          const contentTrimmed = content.split("\n").map((l) => l.trimEnd()).join("\n");
          const oldTrimmed = oldStr.split("\n").map((l) => l.trimEnd()).join("\n");
          if (contentTrimmed.includes(oldTrimmed)) {
            content = contentTrimmed.replace(oldTrimmed, newStr);
          } else {
            return `ERROR: old_str not found in ${args.path}. Inspect with read_file for exact lines.`;
          }
        } else if (count > 1) {
          return `ERROR: old_str matched ${count} times in ${args.path}. Include more surrounding context lines.`;
        } else {
          content = content.replace(oldStr, newStr);
        }

        if (hasCRLF) content = content.replace(/\n/g, "\r\n");
        await writeFile(fullPath, content, "utf8");
        state.modifiedFiles.add(args.path);
        return `Successfully edited ${args.path}.`;
      }

      case "write_file": {
        const fullPath = join(ROOT, args.path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, args.content, "utf8");
        state.modifiedFiles.add(args.path);
        return `Successfully wrote ${args.path} (${args.content.length} bytes).`;
      }

      case "bash_execute": {
        const res = await runCmd("bash", ["-lc", args.command]);
        const stdout = res.stdout.slice(-3000);
        const stderr = res.stderr.slice(-2000);
        if (res.exitCode !== 0) {
          state.lastError = `Command '${args.command}' failed (${res.exitCode}):\n${stderr || stdout}`;
        }
        return `Exit code: ${res.exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
      }

      case "list_dir": {
        const fullPath = join(ROOT, args.path ?? ".");
        const entries = await readdir(fullPath, { withFileTypes: true });
        return entries
          .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join("\n") || "(empty directory)";
      }

      case "grep_search": {
        return await indexer.grep(args.query);
      }

      case "search_symbol": {
        const hits = indexer.searchSymbols(args.symbol);
        if (!hits.length) return `No symbols matching "${args.symbol}" found.`;
        return hits.map((h) => `${h.file}:${h.line} -> ${h.snippet}`).join("\n");
      }

      case "complete_phase": {
        state.completed = true;
        return `Phase marked COMPLETE: ${args.summary}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool Error (${name}): ${err.message}`;
  }
}

// ============================================================================
// 4. DYNAMIC ADAPTIVE CONTEXT HANDOFF ENGINE
// ============================================================================
class AdaptiveCompactor {
  static prepareForModel(messages, state, targetModel) {
    // 1. Calculate budget specific to this candidate model
    const maxAllowedTokens = Math.min(
      (targetModel.context ?? 128000) - 8192,
      targetModel.input_tpm_guard ?? 1000000,
      baseCompactThreshold
    );

    let currentTokens = tokenEstimate(messages);
    if (currentTokens <= maxAllowedTokens) {
      return messages; // Fits naturally into the target model
    }

    console.log(`[handoff] Adapting context for ${targetModel.provider}/${targetModel.id}: ${currentTokens} tokens -> budget of ${maxAllowedTokens}`);

    // Clone array to avoid mutating global message history
    let adapted = JSON.parse(JSON.stringify(messages));

    // Phase 1: Aggressively evict older tool outputs (keep only the 2 most recent)
    for (let i = 1; i < adapted.length - 2; i++) {
      const msg = adapted[i];
      if (msg.role === "tool" && typeof msg.content === "string") {
        if (msg.content.length > 200) {
          msg.content = `[Historical Tool Output for ${msg.name || "call"} truncated for model rotation handoff]`;
        }
      }
    }

    currentTokens = tokenEstimate(adapted);
    if (currentTokens <= maxAllowedTokens) return adapted;

    // Phase 2: State Ledger Re-anchoring (Full Context Handoff)
    console.log(`[handoff] Applying State Ledger Re-anchoring for small context window...`);
    const systemMsg = adapted[0];
    const recentActiveTurns = adapted.slice(-4);

    const ledgerMsg = {
      role: "user",
      content: `[EXECUTIVE STATE LEDGER FOR MODEL ROTATION HANDOFF]
Target Phase: Items ${state.phase.from}-${state.phase.to}
Files Modified So Far: ${[...state.modifiedFiles].join(", ") || "None"}
Last Working State / Blocker: ${state.lastError || "Implementation in progress."}
Notice: Prior verbose tool outputs were pruned to fit your context budget.
Proceed with next direct action (read file, edit file, run targeted test, or complete_phase).`,
    };

    return [systemMsg, ledgerMsg, ...recentActiveTurns];
  }
}

// ============================================================================
// 5. UNIFIED MODEL ADAPTER (Gemini, Groq, OpenRouter)
// ============================================================================
async function callAgent(model, key, messages) {
  let url, headers = { "content-type": "application/json" }, body;

  if (model.provider === "gemini") {
    url = `${model.endpoint}/models/${encodeURIComponent(model.id)}:generateContent?key=${encodeURIComponent(key)}`;
    const geminiTools = [{
      functionDeclarations: TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    }];

    const contents = [];
    let systemInstruction = undefined;

    for (const m of messages) {
      if (m.role === "system") {
        systemInstruction = { parts: [{ text: m.content }] };
        continue;
      }
      if (m.role === "user") {
        contents.push({ role: "user", parts: [{ text: m.content }] });
      } else if (m.role === "assistant") {
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments || "{}"),
              },
            });
          }
        }
        contents.push({ role: "model", parts });
      } else if (m.role === "tool") {
        contents.push({
          role: "user",
          parts: [{ text: `Tool Output (${m.name}):\n${m.content}` }],
        });
      }
    }

    body = {
      contents,
      systemInstruction,
      tools: geminiTools,
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
    };
  } else {
    url = `${model.endpoint}/chat/completions`;
    headers.authorization = `Bearer ${key}`;
    if (model.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://github.com/naelao";
      headers["X-Title"] = "Naelao Autonomous Goal Agent";
    }

    body = {
      model: model.id,
      messages,
      tools: TOOL_DEFINITIONS.map((t) => ({ type: "function", function: t })),
      tool_choice: "auto",
      temperature: 0.1,
      max_tokens: 4096,
    };
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await res.text();
    throw Object.assign(new Error(`${model.provider}/${model.id}: ${res.status} ${errText.slice(0, 800)}`), {
      retryable: [408, 429, 500, 502, 503, 504].includes(res.status),
    });
  }

  const data = await res.json();

  if (model.provider === "gemini") {
    const candidate = data.candidates?.[0]?.content?.parts ?? [];
    let text = "";
    const toolCalls = [];
    for (const part of candidate) {
      if (part.text) text += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        });
      }
    }
    return { content: text || null, tool_calls: toolCalls.length ? toolCalls : null };
  } else {
    const msg = data.choices?.[0]?.message;
    return { content: msg?.content ?? null, tool_calls: msg?.tool_calls ?? null };
  }
}

// ============================================================================
// 6. MAIN GOAL-MODE LOOP
// ============================================================================
for (const phase of manifest.phases.slice(start - 1, end)) {
  console.log(`\n================================================================================`);
  console.log(`🎯 GOAL MODE: Micro-Phase ${phase.phase}/${manifest.phases.length} (Items ${phase.from}-${phase.to})`);
  console.log(`================================================================================\n`);

  const spec = await readFile(new URL(phase.prompt, import.meta.url), "utf8");
  const state = {
    phase,
    completed: false,
    modifiedFiles: new Set(),
    toolCallCount: 0,
    lastError: null,
  };

  const systemPrompt = `You are an elite Staff Software Engineer operating in autonomous GOAL MODE.
Goal: Implement and verify Micro-Phase ${phase.phase} (items ${phase.from} through ${phase.to}).

EXECUTION PRINCIPLES:
1. INSPECT FIRST: Use list_dir, search_symbol, grep_search, and read_file before writing code.
2. SURGICAL EDITS: Use edit_file (exact string replacement) or write_file. Do not emit git diffs.
3. PREVENT ENOENT: If a test looks for directories (like tests/workers), create them with bash_execute: "mkdir -p ...".
4. FAST SUB-SUITE TESTS: Use bash_execute: "pnpm --filter @naelao/tests test" to test iteratively in seconds.
5. COMPLETE ON VERIFICATION: When tests pass and requirements matrix (docs/requirements-trace-matrix.md) is updated, call complete_phase.`;

  let messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `PHASE SPECIFICATION:
${spec}

MANDATORY WORKSPACE FILES:
- Matrix: docs/requirements-trace-matrix.md
- Root: package.json, pnpm-workspace.yaml

Begin execution. Search symbols, read relevant files, apply code modifications, and run fast package tests.`,
    },
  ];

  for (let turn = 1; turn <= maxTurns && !state.completed; turn++) {
    console.log(`\n[turn ${turn}/${maxTurns}] Evaluating models in rotation...`);

    let response;
    let chosenModel;

    // Iterate through configured models in rotation order
    for (const m of models) {
      // Adapt context specifically for this model's budget
      const modelMessages = AdaptiveCompactor.prepareForModel(messages, state, m);
      const promptTokens = tokenEstimate(modelMessages);

      if (promptTokens + 4096 > (m.context ?? 128000)) {
        console.warn(`[skip] Model ${m.id} context window (${m.context}) too small for adapted prompt (${promptTokens})`);
        continue;
      }

      for (const key of keys[m.provider]) {
        try {
          console.log(`Attempting turn with ${m.provider}/${m.id} (~${promptTokens} tokens)...`);
          response = await callAgent(m, key, modelMessages);
          chosenModel = `${m.provider}-${m.id}`;
          break;
        } catch (e) {
          console.warn(`[${m.id} failed]: ${e.message}`);
          if (!e.retryable) break; // Don't retry non-transient errors on same model
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (response) break;
    }

    if (!response) throw new Error(`All rotated models failed on turn ${turn}`);

    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.tool_calls,
    });

    if (response.content) {
      console.log(`\n🤖 [${chosenModel}]:\n${response.content.trim()}\n`);
    }

    if (response.tool_calls && response.tool_calls.length) {
      for (const tc of response.tool_calls) {
        const fnName = tc.function.name;
        const fnArgs = JSON.parse(tc.function.arguments || "{}");
        console.log(`  🔧 Executing: ${fnName}(${JSON.stringify(fnArgs).slice(0, 100)}...)`);

        const toolResult = await executeTool(fnName, fnArgs, state);

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: fnName,
          content: String(toolResult),
        });

        if (state.completed) break;
      }
    } else if (!state.completed) {
      messages.push({
        role: "user",
        content: `Phase is not finished. Continue by reading files, editing files, running targeted tests via bash_execute, or calling complete_phase if verified.`,
      });
    }
  }

  if (!state.completed) {
    throw new Error(`Micro-phase ${phase.phase} did not finish within ${maxTurns} turns`);
  }

  // Final Verification Gate
  console.log(`\n[gate] Running final monorepo verification: ${verifyCommand}...`);
  const vRes = await runCmd("bash", ["-lc", verifyCommand]);
  if (vRes.exitCode !== 0) {
    console.error(`[final verification failure]:\n${vRes.stderr.slice(-2000) || vRes.stdout.slice(-2000)}`);
    throw new Error(`Phase ${phase.phase} failed final global verification: ${verifyCommand}`);
  }

  console.log(`✅ Micro-Phase ${phase.phase} passed verification!`);

  // Git Commit
  const statusRes = await runCmd("git", ["status", "--porcelain"]);
  if (statusRes.stdout.trim()) {
    await runCmd("git", ["add", "-A"]);
    await runCmd("git", ["commit", "-m", `feat(plan): complete micro-phase ${phase.phase} items ${phase.from}-${phase.to}`]);
    console.log(`📦 Committed changes for phase ${phase.phase}.`);
  }
}

console.log(`\n🎉 All selected micro-phases successfully implemented and verified!`);