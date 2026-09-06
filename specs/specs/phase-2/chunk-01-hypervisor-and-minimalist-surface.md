Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 2 — Chunk 01**: `specs/phase-2/chunk-01-hypervisor-and-minimalist-surface.md`.

---

```markdown
---
chunk_id: "phase-2-chunk-01"
phase: 2
include_files:
  - workers/agents/src/script-engine/execution-ladder.ts
  - workers/agents/src/script-engine/tool-surface.ts
  - workers/agents/src/script-engine/types.ts
repomix_include:
  - "workers/agents/src/script-engine/execution-ladder.ts"
  - "workers/agents/src/script-engine/tool-surface.ts"
  - "workers/agents/src/script-engine/types.ts"
expected_outputs:
  - workers/agents/src/script-engine/execution-ladder.ts
  - workers/agents/src/script-engine/tool-surface.ts
  - workers/agents/src/script-engine/types.ts
---

# Phase 2 — Chunk 01: Invisible Runtime Hypervisor & Minimalist Tool Surface

## 1. Executive Summary & Architectural Vision

To eliminate **prompt paralysis** and context token bloat, AVOS **does not expose 6 separate tier-execution tools** (e.g. `exec_sqlite_fs`, `exec_isolate_codemode`, `exec_container_bash`) to the AI model. Exposing tier-level tools forces the LLM to spend valuable reasoning tokens acting as an infrastructure manager rather than focusing on task outcomes.

Instead, the model receives a **minimalist 3+2 tool surface** (`Bash`, `Read`, `Edit` + `Browser`, `Delegate`) that mimics a standard high-speed developer workstation. The model writes standard terminal commands and scripts that it was pre-trained on during foundation training. 

Underneath the `Bash` primitive, the **Invisible Runtime Hypervisor** intercepts, parses, and dynamically routes every command to the fastest, cheapest, and most secure compute tier on Cloudflare's edge network.

```
[ AI Model calls `Bash({ command: "..." })` ]
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 CLOUDFLARE RUNTIME HYPERVISOR ROUTER                        │
├──────────────┬──────────────┬──────────────┬──────────────┬─────────────────┤
│ Tier 1 & 2   │ Tier 3       │ Tier 4       │ Tier 5       │ Tier 6          │
│ V8 Isolate   │ Workflows    │ Kitesurf     │ Chromium     │ Container       │
├──────────────┼──────────────┼──────────────┼──────────────┼─────────────────┤
│ `grep`, `cat`│ `schedule`   │ `browse`     │ Screenshots /│ `npm run build` │
│ `stripe` CLI │ cron helper  │ DOM text     │ WebGL canvas │ `cargo`, `gcc`  │
│ `python3` Wasm│ (Dormant $0) │ (<50ms, 30MB)│ snapshots    │ (Micro-sleep)   │
└──────────────┴──────────────┴──────────────┴──────────────┴─────────────────┘
```

---

## 2. The Minimalist Tool Surface Definition

The tool surface exposed to the LLM must be strictly limited to these 5 primitives in `workers/agents/src/script-engine/tool-surface.ts`.

### Tool Breakdown & Roles:
1. **`Bash` (Hands / Action):** Universal command-line execution interface. Used for virtual CLIs, script execution, file utilities, package installation, and build dispatches.
2. **`Read` (Hands / File Inspection):** Line-numbered windowed file inspection. Supports offsets and line-limit pagination to protect context windows.
3. **`Edit` (Hands / Code Modification):** Exact AST search-and-replace block edits. Forces surgical patching and prevents full-file rewrites.
4. **`Browser` (Senses / Web Perception):** Web navigation, DOM accessibility tree (AXTree) extraction, form interactions, and visual screenshot capture.
5. **`Delegate` (Senses / Task Orchestration):** Structured JSON-RPC task delegation to subagents or sibling specialists.

---

## 3. The Execution Ladder Tier Mapping

The Runtime Hypervisor inspects every incoming command string and resolves the minimum required execution tier:

```
┌──────┬────────────────────────────────┬─────────────────────────────┬────────────────────────────────┐
│ Tier │ Compute Primitive              │ Target Commands / Utilities │ Execution Cost & Speed         │
├──────┼────────────────────────────────┼─────────────────────────────┼────────────────────────────────┤
│ **1**│ In-Memory DO SQLite Virtual FS │ `Read`, `Edit`, `Grep`,     │ Sub-1ms / $0.00 compute cost   │
│      │ (@cloudflare/computer)         │ `Glob`, `cat`, `ls`, `diff` │ (Direct in V8 DO memory)       │
├──────┼────────────────────────────────┼─────────────────────────────┼────────────────────────────────┤
│ **2**│ V8 Isolate Shell & Pyodide     │ `just-bash` utilities,      │ Sub-5ms / $0.0001 per run      │
│      │ (Dynamic Worker Loaders)       │ `python3` (Wasm), Virtual   │ (Pure Isolate, no container)   │
│      │                                │ CLIs (`stripe`, `gh`, `jq`) │                                │
├──────┼────────────────────────────────┼─────────────────────────────┼────────────────────────────────┤
│ **3**│ Cloudflare Workflows           │ `schedule`, `workflow`,     │ $0.00 idle compute cost        │
│      │ (Durable Execution)            │ recurring cron dispatches   │ (Dormant step sleeping)        │
├──────┼────────────────────────────────┼─────────────────────────────┼────────────────────────────────┤
│ **4**│ Cloudflare Kitesurf Browser    │ `browse`, `scrape`, DOM text│ Sub-50ms / 30MB RAM footprint  │
│      │ (Lightweight Agent Browser)    │ extraction, form fills      │ (3–7x faster than Puppeteer)   │
├──────┼────────────────────────────────┼─────────────────────────────┼────────────────────────────────┤
│ **5**│ Headless Chromium              │ `browse --screenshot`,      │ Sub-200ms / 200MB RAM          │
│      │ (Browser Rendering Engine)     │ WebGL canvas rendering      │ (Visual QA & canvas snapshots) │
├──────┼────────────────────────────────┼─────────────────────────────┼────────────────────────────────┤
│ **6**│ Linux Container Sandbox        │ `npm run build`, `cargo`,   │ $0.05 / active compute hour    │
│      │ (`ToolSandboxDO` / Docker)     │ `gcc`, `pip install -e .`,  │ (60-second scale-to-zero)      │
│      │                                │ GUI desktop (Xvfb + noVNC)  │                                │
└──────┴────────────────────────────────┴─────────────────────────────┴────────────────────────────────┘
```

---

## 4. Technical Specifications & File Implementation Contracts

### A. `workers/agents/src/script-engine/types.ts`

Extend `types.ts` to export the execution tier and hypervisor routing structures:

```typescript
export type ExecutionTier = 1 | 2 | 3 | 4 | 5 | 6;

export interface HypervisorRouteResult {
  tier: ExecutionTier;
  binary: string;
  args: string[];
  requiresContainer: boolean;
  requiresBrowser: boolean;
  requiresWorkflow: boolean;
  suggestedBackend: "v8_isolate" | "kitesurf" | "chromium" | "workflow" | "container";
}

export interface MinimalistToolParams {
  command?: string;
  filePath?: string;
  offset?: number;
  limit?: number;
  oldString?: string;
  newString?: string;
  action?: "navigate" | "click" | "type" | "screenshot";
  url?: string;
  selector?: string;
  text?: string;
  targetRole?: string;
  taskDescription?: string;
  contextFiles?: string[];
}
```

---

### B. `workers/agents/src/script-engine/execution-ladder.ts`

Implement the `ExecutionLadderRouter` class and the `resolveExecutionTier` helper:

```typescript
import { ExecutionTier, HypervisorRouteResult } from "./types";

/**
 * List of heavy native build, compilation, and system binaries that
 * MUST run inside a Tier 6 Linux Container sandbox.
 */
const TIER_6_CONTAINER_BINARIES = new Set([
  "npm",
  "pnpm",
  "yarn",
  "cargo",
  "rustc",
  "gcc",
  "g++",
  "make",
  "cmake",
  "docker",
  "pip",
  "python",
  "python3",
  "go",
  "go run",
  "swift",
  "javac",
  "java",
  "dotnet"
]);

/**
 * Inspects a terminal command string and resolves the optimal execution tier,
 * targeting the cheapest and fastest compute primitive on Cloudflare.
 */
export function resolveExecutionTier(command: string): HypervisorRouteResult {
  const trimmed = command.trim();
  const parts = trimmed.split(/\s+/);
  const binary = parts[0] || "";
  const subCommand = parts[1] || "";
  const fullCommandPrefix = `${binary} ${subCommand}`.trim();

  // 1. Check for Heavy Tier 6 Container Compilation / Native Commands
  if (
    TIER_6_CONTAINER_BINARIES.has(binary) ||
    trimmed.startsWith("npm run") ||
    trimmed.startsWith("npm install") ||
    trimmed.startsWith("pip install") ||
    trimmed.startsWith("cargo build") ||
    trimmed.startsWith("go build")
  ) {
    // Exception: Lightweight in-isolate Pyodide python executions without native C-extensions
    if ((binary === "python" || binary === "python3") && !requiresNativeCExtensions(trimmed)) {
      return {
        tier: 2,
        binary,
        args: parts.slice(1),
        requiresContainer: false,
        requiresBrowser: false,
        requiresWorkflow: false,
        suggestedBackend: "v8_isolate"
      };
    }

    return {
      tier: 6,
      binary,
      args: parts.slice(1),
      requiresContainer: true,
      requiresBrowser: false,
      requiresWorkflow: false,
      suggestedBackend: "container"
    };
  }

  // 2. Check for Tier 4 & Tier 5 Browser Navigation Commands
  if (binary === "browse" || binary === "scrape" || binary === "kitesurf" || binary === "puppeteer") {
    const isVisualQa = trimmed.includes("--screenshot") || trimmed.includes("--webgl") || trimmed.includes("--canvas");
    const tier: ExecutionTier = isVisualQa ? 5 : 4;
    return {
      tier,
      binary,
      args: parts.slice(1),
      requiresContainer: false,
      requiresBrowser: true,
      requiresWorkflow: false,
      suggestedBackend: isVisualQa ? "chromium" : "kitesurf"
    };
  }

  // 3. Check for Tier 3 Dynamic Workflows & Cron Schedulers
  if (binary === "schedule" || binary === "workflow" || binary === "cron") {
    return {
      tier: 3,
      binary,
      args: parts.slice(1),
      requiresContainer: false,
      requiresBrowser: false,
      requiresWorkflow: true,
      suggestedBackend: "workflow"
    };
  }

  // 4. Default: Tier 1/2 In-Memory V8 Isolate / Virtual POSIX Shell (just-bash)
  return {
    tier: 2,
    binary,
    args: parts.slice(1),
    requiresContainer: false,
    requiresBrowser: false,
    requiresWorkflow: false,
    suggestedBackend: "v8_isolate"
  };
}

/**
 * Detects if a Python script imports native C-extensions that require
 * a full Linux kernel / Docker container.
 */
function requiresNativeCExtensions(script: string): boolean {
  const nativeLibs = ["torch", "cv2", "tensorflow", "scipy_c", "libraw", "cuda", "pyautogui"];
  return nativeLibs.some(lib => script.includes(`import ${lib}`) || script.includes(`from ${lib}`));
}
```

---

### C. `workers/agents/src/script-engine/tool-surface.ts`

Export the `MINIMALIST_AGENT_TOOLS` surface and implement the tool compilation handler:

```typescript
import { MINIMALIST_AGENT_TOOLS } from "./types";
import { resolveExecutionTier } from "./execution-ladder";

export class ScriptToolSurface {
  /**
   * Compiles the minimalist tool surface exposed to the LLM context window.
   * Strips bloated MCP schemas and heavy tier definitions.
   */
  static getMinimalistToolDeclarations() {
    return [
      {
        name: "Bash",
        description: MINIMALIST_AGENT_TOOLS.Bash.description,
        parameters: MINIMALIST_AGENT_TOOLS.Bash.parameters
      },
      {
        name: "Read",
        description: MINIMALIST_AGENT_TOOLS.Read.description,
        parameters: MINIMALIST_AGENT_TOOLS.Read.parameters
      },
      {
        name: "Edit",
        description: MINIMALIST_AGENT_TOOLS.Edit.description,
        parameters: MINIMALIST_AGENT_TOOLS.Edit.parameters
      },
      {
        name: "Browser",
        description: MINIMALIST_AGENT_TOOLS.Browser.description,
        parameters: MINIMALIST_AGENT_TOOLS.Browser.parameters
      },
      {
        name: "Delegate",
        description: MINIMALIST_AGENT_TOOLS.Delegate.description,
        parameters: MINIMALIST_AGENT_TOOLS.Delegate.parameters
      }
    ];
  }

  /**
   * Route tool execution based on the Hypervisor decision.
   */
  async handleToolCall(toolName: string, params: Record<string, any>, ctx: any) {
    if (toolName === "Bash") {
      const route = resolveExecutionTier(params.command);
      
      // Dispatch based on solved hypervisor route
      if (route.tier === 6) {
        return await ctx.container.exec(params.command);
      }
      if (route.tier === 4 || route.tier === 5) {
        return await ctx.browser.exec(params.command, { engine: route.suggestedBackend });
      }
      if (route.tier === 3) {
        return await ctx.workflows.scheduleFromCommand(params.command);
      }
      
      // Tier 1 & 2: In-Isolate Virtual POSIX Shell (just-bash)
      return await ctx.virtualShell.exec(params.command);
    }

    if (toolName === "Read") {
      return await ctx.fs.read(params.filePath, { offset: params.offset, limit: params.limit });
    }

    if (toolName === "Edit") {
      return await ctx.fs.edit(params.filePath, params.oldString, params.newString);
    }

    if (toolName === "Browser") {
      return await ctx.browser.executeAction(params);
    }

    if (toolName === "Delegate") {
      return await ctx.agent.delegateTask(params.targetRole, params.taskDescription, params.contextFiles);
    }

    throw new Error(`Unknown tool primitive: ${toolName}`);
  }
}
```

---

## 5. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Update `workers/agents/src/script-engine/types.ts`:
   - Export `ExecutionTier` and `HypervisorRouteResult`.
   - Re-export `MINIMALIST_AGENT_TOOLS`.
2. Create/Update `workers/agents/src/script-engine/execution-ladder.ts`:
   - Implement `resolveExecutionTier` and `requiresNativeCExtensions`.
   - Ensure all heavy compilers (`npm run build`, `cargo`, `gcc`) correctly evaluate to `tier: 6`.
   - Ensure `browse --screenshot` evaluates to `tier: 5` and standard `browse` evaluates to `tier: 4`.
3. Update `workers/agents/src/script-engine/tool-surface.ts`:
   - Export `ScriptToolSurface.getMinimalistToolDeclarations()`.
   - Implement `handleToolCall` routing dispatches according to the `HypervisorRouteResult`.
4. Run `node --check` syntax validation on the modified files.
```
