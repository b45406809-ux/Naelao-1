Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 2 — Chunk 07**: `specs/phase-2/chunk-07-execution-ladder-browser-bridge.md`.

---

```markdown
---
chunk_id: "phase-2-chunk-07"
phase: 2
include_files:
  - workers/agents/src/script-engine/execution-ladder.ts
  - workers/agents/src/script-engine/tool-surface.ts
  - workers/browser/src/index.ts
  - workers/agents/src/script-engine/prebuilt/browser-use.ts
repomix_include:
  - "workers/agents/src/script-engine/execution-ladder.ts"
  - "workers/agents/src/script-engine/tool-surface.ts"
  - "workers/browser/src/index.ts"
  - "workers/agents/src/script-engine/prebuilt/browser-use.ts"
expected_outputs:
  - workers/agents/src/script-engine/execution-ladder.ts
  - workers/agents/src/script-engine/tool-surface.ts
  - workers/agents/src/script-engine/prebuilt/browser-use.ts
---

# Phase 2 — Remediation Chunk 07: Execution Ladder & Browser Bridge

## 1. Executive Summary & Architectural Vision

This remediation chunk wires the integration glue between the **Invisible Runtime Hypervisor** (`execution-ladder.ts`), the **Minimalist Tool Surface** (`tool-surface.ts`), the **Browser Prebuilt Wrapper** (`browser-use.ts`), and the Cloudflare **Browser Rendering Worker** (`workers/browser/src/index.ts`).

When an agent invokes the `Browser` tool primitive or runs a terminal command like `browse https://example.com`, the execution pipeline must seamlessly pass through the ladder router, select Tier 4 Kitesurf (or auto-elevate to Tier 5 Chromium if visual QA is requested), execute the action via service bindings, and return structured accessibility trees or screenshots back to the LLM.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       BROWSER EXECUTION BRIDGING PIPELINE                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. LLM Tool Call: `Browser({ action: "navigate", url: "..." })`             │
│ 2. Tool Surface (`tool-surface.ts`): Intercepts call and invokes ladder.    │
│ 3. Ladder Router (`execution-ladder.ts`): Resolves Tier 4 (Kitesurf) or     │
│    Tier 5 (Chromium) based on visual flags (`--screenshot`, `--webgl`).     │
│ 4. Browser Wrapper (`browser-use.ts`): Dispatches payload to browser worker.│
│ 5. Browser Worker (`workers/browser/src/index.ts`): Executes rendering.     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Update `workers/agents/src/script-engine/execution-ladder.ts`

Ensure `resolveExecutionTier()` explicitly matches browser binaries and flags:

```typescript
import { ExecutionTier, HypervisorRouteResult } from "./types";

export function resolveExecutionTier(command: string): HypervisorRouteResult {
  const trimmed = command.trim();
  const firstWord = trimmed.split(/\s+/)[0];

  // Browser Commands Routing (Tier 4 Kitesurf vs Tier 5 Chromium)
  if (firstWord === "browse" || firstWord === "scrape" || firstWord === "kitesurf" || firstWord === "puppeteer") {
    const isVisualQa = trimmed.includes("--screenshot") || trimmed.includes("--webgl") || trimmed.includes("--canvas") || trimmed.includes("--visual");
    const tier: ExecutionTier = isVisualQa ? 5 : 4;
    return {
      tier,
      binary: firstWord,
      args: trimmed.split(/\s+/).slice(1),
      requiresContainer: false,
      requiresBrowser: true,
      requiresWorkflow: false,
      suggestedBackend: isVisualQa ? "chromium" : "kitesurf"
    };
  }

  // Default Isolate fallback
  return {
    tier: 2,
    binary: firstWord,
    args: trimmed.split(/\s+/).slice(1),
    requiresContainer: false,
    requiresBrowser: false,
    requiresWorkflow: false,
    suggestedBackend: "v8_isolate"
  };
}
```

---

### B. Update `workers/agents/src/script-engine/prebuilt/browser-use.ts`

Implement the prebuilt browser execution wrapper that communicates with the browser worker:

```typescript
import { processBrowserTask } from "../../../browser/src/index";

export interface BrowserToolParams {
  action: "navigate" | "click" | "type" | "screenshot";
  url?: string;
  selector?: string;
  text?: string;
  takeScreenshot?: boolean;
  requiresWebGL?: boolean;
}

export async function executeBrowserTool(params: BrowserToolParams, ctx: { env: any; spaceId: string }) {
  try {
    const result = await processBrowserTask({
      url: params.url || "",
      action: params.action || "navigate",
      selector: params.selector,
      text: params.text,
      takeScreenshot: params.takeScreenshot || params.action === "screenshot",
      requiresWebGL: params.requiresWebGL
    }, ctx.env);

    return {
      success: true,
      data: result,
      message: `✔ Browser action '${params.action}' executed successfully via ${result.backend}.`
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "Browser execution failed",
      message: `✖ Browser action failed: ${err.message}`
    };
  }
}
```

---

### C. Update `workers/agents/src/script-engine/tool-surface.ts`

Ensure `ScriptToolSurface` correctly delegates `Browser` tool calls to `executeBrowserTool`:

```typescript
import { executeBrowserTool } from "./prebuilt/browser-use";
import { resolveExecutionTier } from "./execution-ladder";

export class ScriptToolSurface {
  async handleToolCall(toolName: string, params: Record<string, any>, ctx: any) {
    if (toolName === "Browser") {
      return await executeBrowserTool(params, ctx);
    }

    if (toolName === "Bash") {
      const route = resolveExecutionTier(params.command);
      if (route.requiresBrowser) {
        // Translate bash browse command into structured browser task
        const action = route.args.includes("--screenshot") ? "screenshot" : "navigate";
        const url = route.args.find(arg => arg.startsWith("http")) || "";
        return await executeBrowserTool({ action, url }, ctx);
      }
      
      if (route.tier === 6) {
        return await ctx.container.exec(params.command);
      }
      
      return await ctx.virtualShell.exec(params.command);
    }

    if (toolName === "Read") {
      return await ctx.fs.read(params.filePath, { offset: params.offset, limit: params.limit });
    }

    if (toolName === "Edit") {
      return await ctx.fs.edit(params.filePath, params.oldString, params.newString);
    }

    if (toolName === "Delegate") {
      return await ctx.agent.delegateTask(params.targetRole, params.taskDescription, params.contextFiles);
    }

    throw new Error(`Unknown tool primitive: ${toolName}`);
  }
}
```

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

1. Update `workers/agents/src/script-engine/execution-ladder.ts` with browser route matching.
2. Update `workers/agents/src/script-engine/prebuilt/browser-use.ts` to call `processBrowserTask`.
3. Update `workers/agents/src/script-engine/tool-surface.ts` to invoke `executeBrowserTool` and handle browser-routed bash commands.
4. Run `node --check` syntax validation to ensure zero compilation errors.
```
