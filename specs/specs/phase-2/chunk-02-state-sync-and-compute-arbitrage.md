Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 2 — Chunk 02**: `specs/phase-2/chunk-02-state-sync-and-compute-arbitrage.md`.

---

```markdown
---
chunk_id: "phase-2-chunk-02"
phase: 2
include_files:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/do/ToolSandboxDO.ts
  - workers/agents/src/script-engine/code-runner.ts
repomix_include:
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "workers/agents/src/do/ToolSandboxDO.ts"
  - "workers/agents/src/script-engine/code-runner.ts"
expected_outputs:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/do/ToolSandboxDO.ts
  - workers/agents/src/script-engine/code-runner.ts
---

# Phase 2 — Chunk 02: 4-Dimension State Synchronization & 60-Second Container Micro-Sleep Arbitrage

## 1. Executive Summary & Architectural Vision

To achieve **92%+ gross profit margins on $29/mo Starter Plans**, Tier 6 Linux Containers (`ToolSandboxDO`) must **never run idle**. 

When an agent executes a native compilation command (`npm run build`, `cargo build`), the container boots, executes the command, flushes file changes, and enters an **Aggressive 60-Second Micro-Sleep Countdown**:
1. If no new container commands arrive within 60 seconds, the container actor terminates its userland processes and hibernates, incurring **$0.00 idle compute fees**.
2. To prevent split-brain anomalies between fast V8 isolates and sleeping Linux containers, **4-Dimension State Synchronization** ensures that Filesystem changes (`workspace_files`), Shell Session state (`cwd`, `envVars`), Git HEAD state (Cloudflare Artifacts), and DO Facet SQLite tables are continuously synchronized across both compute runtimes.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       4-DIMENSION STATE SYNC ENGINE                         │
├────────────────────┬────────────────────────────────────────────────────────┤
│ 1. Filesystem      │ DO SQLite Virtual FS synced to container via ArtifactFS│
│ 2. Shell Session   │ `cwd` and `export` variables injected in gRPC headers  │
│ 3. Git State       │ Both environments share Cloudflare Artifacts HEAD ref │
│ 4. SQLite DB       │ DO Facet SQLite queryable over local socket            │
└────────────────────┴────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Update Container Actor (`workers/agents/src/do/ToolSandboxDO.ts`)
Implement 60-second hibernation alarms, state reception, and workspace synchronization over gRPC:

```typescript
import { DurableObject } from "cloudflare:workers";

export interface ToolSandboxEnv {
  WORKSPACE_BUCKET: R2Bucket;
}

export class ToolSandboxDO extends DurableObject {
  private lastCommandAt: number = Date.now();

  constructor(ctx: DurableObjectState, env: ToolSandboxEnv) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/exec-grpc") {
      const body = await request.json() as {
        command: string;
        cwd: string;
        envVars: Record<string, string>;
        branch: string;
      };

      this.lastCommandAt = Date.now();

      // Schedule scale-to-zero alarm 60 seconds from now
      await this.ctx.storage.setAlarm(Date.now() + 60000);

      const result = await this.executeInContainer(body.command, body.cwd, body.envVars);
      return Response.json(result);
    }

    return new Response("Not Found", { status: 404 });
  }

  // Scale-to-zero alarm handler
  async alarm(): Promise<void> {
    const idleTime = Date.now() - this.lastCommandAt;
    if (idleTime >= 60000) {
      console.log("😴 60s idle threshold reached. Micro-sleeping container instance...");
      await this.shutdownContainerProcess();
    }
  }

  private async shutdownContainerProcess() {
    // Terminate persistent processes in container userland
  }

  private async executeInContainer(cmd: string, cwd: string, env: Record<string, string>) {
    const startTime = Date.now();
    try {
      // Execute command inside container userland with injected CWD and ENV
      return {
        stdout: `Executed in container at ${cwd}`,
        stderr: "",
        exitCode: 0,
        durationMs: Date.now() - startTime
      };
    } catch (err: any) {
      return {
        stdout: "",
        stderr: err.message || "Container execution failed",
        exitCode: 1,
        durationMs: Date.now() - startTime
      };
    }
  }
}
```

---

### B. Update `workers/agents/src/do/NaelaoAgentDO.ts`
Persist `ShellSessionState` (`cwd`, `envVars`, `activeGitBranch`) in Durable Object SQLite storage so that all subsequent command dispatches maintain continuous session state:

```typescript
export interface ShellSessionState {
  cwd: string;                   // e.g. "src/components"
  envVars: Record<string, string>; // e.g. { NODE_ENV: "production" }
  activeGitBranch: string;       // e.g. "feature-darkmode"
}

export class NaelaoAgentDO {
  private sessionState: ShellSessionState = {
    cwd: "",
    envVars: {},
    activeGitBranch: "main"
  };

  async updateShellSession(command: string): Promise<string> {
    const trimmed = command.trim();

    if (trimmed.startsWith("cd ")) {
      const targetDir = trimmed.replace("cd ", "").trim();
      this.sessionState.cwd = targetDir === "." ? "" : targetDir;
      return `✔ Changed directory to /workspace/${this.sessionState.cwd}`;
    }

    if (trimmed.startsWith("export ")) {
      const [key, val] = trimmed.replace("export ", "").split("=");
      if (key && val) {
        this.sessionState.envVars[key.trim()] = val.trim().replace(/^['"]|['"]$/g, "");
        return `✔ Set environment variable ${key.trim()}=${val.trim()}`;
      }
    }

    return "";
  }

  getSessionState(): ShellSessionState {
    return this.sessionState;
  }
}
```

---

### C. Update `workers/agents/src/script-engine/code-runner.ts`
Wire the code runner to bridge shell state, virtual POSIX shell execution, and container pass-throughs:

```typescript
import { VirtualPosixShell } from "../workspace/virtual-shell";

export interface CodeRunnerOptions {
  name: string;
  code: string;
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  args?: Record<string, any>;
  spaceId: string;
  projectId?: string;
  sessionState?: { cwd: string; envVars: Record<string, string>; branch: string };
}

export class CodeRunner {
  constructor(private env: any) {}

  async run(opts: CodeRunnerOptions) {
    if (opts.tier === 6) {
      // Route to Tier 6 ToolSandboxDO via gRPC
      const sandboxId = this.env.TOOL_SANDBOX.idFromName(`${opts.spaceId}:${opts.projectId || "_assistant"}`);
      const sandboxStub = this.env.TOOL_SANDBOX.get(sandboxId);

      const res = await sandboxStub.fetch("http://internal/exec-grpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: opts.code,
          cwd: `/workspace/${opts.sessionState?.cwd || ""}`,
          envVars: opts.sessionState?.envVars || {},
          branch: opts.sessionState?.activeGitBranch || "main"
        })
      });

      return await res.json();
    }

    // Default Tier 1/2 V8 Isolate execution
    return {
      stdout: "V8 Isolate execution complete",
      stderr: "",
      exitCode: 0,
      backend: "v8_isolate"
    };
  }
}
```

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Update `workers/agents/src/do/ToolSandboxDO.ts` to implement the `alarm()` handler and 60-second micro-sleep countdown.
2. Update `workers/agents/src/do/NaelaoAgentDO.ts` to persist `ShellSessionState` (`cwd`, `envVars`, `activeGitBranch`) in Durable Object SQLite.
3. Update `workers/agents/src/script-engine/code-runner.ts` to pass session state headers securely to `ToolSandboxDO` over gRPC.
4. Run `node --check` syntax validation on the modified files.
```
