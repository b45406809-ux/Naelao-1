Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 2 — Remediation Chunk 08**: `specs/phase-2/chunk-08-agent-environment-injection.md`.

---

```markdown
---
chunk_id: "phase-2-chunk-08"
phase: 2
include_files:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/script-engine/code-runner.ts
  - workers/agents/src/script-engine/types.ts
repomix_include:
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "workers/agents/src/script-engine/code-runner.ts"
  - "workers/agents/src/script-engine/types.ts"
expected_outputs:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/script-engine/code-runner.ts
  - workers/agents/src/script-engine/types.ts
---

# Phase 2 — Remediation Chunk 08: Agent Environment & Runtime SDK Injection

## 1. Executive Summary & Architectural Vision

To achieve a true **Self-Tooling, Script-Native Operating System**, we must provide a unified, sandboxed **AVOS Runtime SDK (`ctx`)** injected into every isolate and container execution.

The AI is not treated as an external user poking at black-box APIs. Instead, the Parent Agent (`NaelaoAgentDO`) acts as a **Conductor**. When given any high-level objective, it constructs a lightweight, secure `ctx` object, injects it into the V8 Isolate execution block (`code-runner.ts`), and runs the code natively in Tier 2 CodeMode in **under 8 milliseconds**.

```
   ┌─────────────────────────────────────────────────────────────┐
   │             PARENT AGENT CONDUCTOR (NaelaoAgentDO)          │
   ├──────────────────────────────┬──────────────────────────────┤
   │ Instantiates:                │ Resolves:                    │
   │ • `VirtualPosixShell`        │ • Scoped `SpaceDO` SQLite    │
   │ • `ArtifactsGitService`      │ • Vaulted credentials        │
   └──────────────────────────────┼──────────────────────────────┘
                                  │
                                  ▼ (Assembles `ctx` Runtime Slices)
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              THE INJECTED AVOS RUNTIME SDK (`ctx`)                                     │
├───────────────────┬────────────────────────────────────────────────────────────────────────────────────┤
│ SDK Subsystem     │ Capabilities & Methods Exposed to the Script                                       │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 📁 `ctx.fs`       │ `read(path)`, `edit(path, old, new)`, `write(path, content)`, `grep()`, `glob()`   │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 🏢 `ctx.space`    │ *(Assistant Only)* `createProject()`, `listProjects()`, `getWalletBalance()`       │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 📋 `ctx.project`  │ `getJournal()`, `updateJournal()`, `listThreads()`, `postMessage()`                │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 🌐 `ctx.browser`  │ `navigate(url)`, `click(selector)`, `type(selector, text)`, `extract(selector)`    │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ ⚡ `ctx.mcp`      │ `call(serverName, toolName, params)`, `listTools(serverName)`                      │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 🔒 `ctx.vault`    │ `fetchWithAuth(url, { credentialName: "KEY" })` (Zero-Leak credential proxy)       │
└───────────────────┴────────────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼ (Injected into Sandbox Runner)
   ┌─────────────────────────────────────────────────────────────┐
   │             TIER 2 SANDBOX RUNNER (code-runner.ts)          │
   │             Executes: `export async function run(args, ctx)`│
   └─────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Update `workers/agents/src/script-engine/types.ts`

Define the full types and interfaces for the injected `ctx` SDK context:

```typescript
export interface AvosFsRuntime {
  read: (filePath: string, opts?: { offset?: number; limit?: number }) => Promise<{ content: string; totalLines: number }>;
  edit: (filePath: string, oldString: string, newString: string) => Promise<{ ok: boolean; message: string }>;
  write: (filePath: string, content: string) => Promise<{ ok: boolean; bytesWritten: number }>;
  grep: (pattern: string, path?: string) => Promise<Array<{ file: string; line: number; text: string }>>;
  glob: (pattern: string) => Promise<string[]>;
}

export interface AvosProjectRuntime {
  id: string;
  getJournal: () => Promise<any>;
  updateJournal: (status: string) => Promise<{ ok: boolean }>;
  createTask: (title: string) => Promise<{ ok: boolean }>;
  listThreads: () => Promise<Array<{ id: string; title: string }>>;
  postMessage: (threadId: string, text: string) => Promise<{ ok: boolean }>;
}

export interface AvosSpaceRuntime {
  id: string;
  createProject: (name: string, kind: string, templateId?: string) => Promise<{ id: string; name: string }>;
  listProjects: () => Promise<Array<{ id: string; name: string; kind: string }>>;
  getWalletBalance: () => Promise<{ balance_cents: number; currency: string }>;
  sendNotification: (title: string, body: string) => Promise<{ ok: boolean }>;
}

export interface AvosVaultRuntime {
  fetchWithAuth: (url: string, opts: { credentialName: string; method?: string; body?: any; headers?: Record<string, string> }) => Promise<Response>;
}

export interface AvosMcpRuntime {
  call: (server: string, tool: string, params: Record<string, any>) => Promise<any>;
  listTools: (server: string) => Promise<Array<{ name: string; description: string }>>;
}

export interface AvosBrowserRuntime {
  navigate: (url: string) => Promise<{ title: string; textContent: string }>;
  click: (selector: string) => Promise<{ ok: boolean }>;
  type: (selector: string, text: string) => Promise<{ ok: boolean }>;
  extract: (selector: string) => Promise<string[]>;
}

export interface AvosRuntimeContext {
  fs: AvosFsRuntime;
  project?: AvosProjectRuntime;
  space?: AvosSpaceRuntime;
  vault: AvosVaultRuntime;
  mcp: AvosMcpRuntime;
  browser: AvosBrowserRuntime;
  runSkill: (skillName: string, args: Record<string, any>) => Promise<any>;
}
```

---

### B. Implement `ctx` Builder (`workers/agents/src/script-engine/code-runner.ts`)

Implement `buildRuntimeContext` to safely assemble the SDK based on the active agent's role, scope, and project:

```typescript
import { AvosRuntimeContext } from "./types";
import { VirtualPosixShell } from "../workspace/virtual-shell";
import { ArtifactsGitService } from "../services/ArtifactsGitService";

export function buildRuntimeContext(
  env: any,
  scope: "SPACE_WIDE" | "PROJECT_BOUND",
  spaceId: string,
  projectId?: string,
  actingUserId?: string,
  virtualShell?: VirtualPosixShell,
  artifactsGit?: ArtifactsGitService
): AvosRuntimeContext {
  // 1. Filesystem Slice (Binds directly to virtual POSIX shell or standard storage)
  const fs = {
    read: async (filePath: string, opts?: { offset?: number; limit?: number }) => {
      const output = await virtualShell!.exec(`cat ${filePath}`, {}, "/workspace");
      const lines = output.stdout.split("\n");
      const offset = opts?.offset || 0;
      const limit = opts?.limit || lines.length;
      return {
        content: lines.slice(offset, offset + limit).join("\n"),
        totalLines: lines.length
      };
    },
    edit: async (filePath: string, oldString: string, newString: string) => {
      // Execute surgical replacement in SQLite VFS
      const ok = await virtualShell!.exec(`patch_file ${filePath}`, { oldString, newString }, "/workspace");
      return { ok: ok.exitCode === 0, message: ok.stderr || "Success" };
    },
    write: async (filePath: string, content: string) => {
      const ok = await virtualShell!.exec(`write_file ${filePath}`, { content }, "/workspace");
      return { ok: ok.exitCode === 0, bytesWritten: content.length };
    },
    grep: async (pattern: string, path?: string) => {
      const target = path || ".";
      const result = await virtualShell!.exec(`grep -rn "${pattern}" ${target}`, {}, "/workspace");
      return result.stdout.split("\n").map(line => {
        const [file, lineNum, ...text] = line.split(":");
        return { file, line: parseInt(lineNum) || 0, text: text.join(":") };
      }).filter(r => r.file);
    },
    glob: async (pattern: string) => {
      const result = await virtualShell!.exec(`find . -name "${pattern}"`, {}, "/workspace");
      return result.stdout.split("\n").map(f => f.trim()).filter(Boolean);
    }
  };

  // 2. Project Slice (Restricted to project-scoped or space-wide assistants)
  const project = projectId ? {
    id: projectId,
    getJournal: async () => {
      // Fetch journal state from SpaceDO
      const res = await env.SPACES_WORKER.fetch(`http://internal/spaces/${spaceId}/projects/${projectId}/journal`);
      return await res.json();
    },
    updateJournal: async (status: string) => {
      const res = await env.SPACES_WORKER.fetch(`http://internal/spaces/${spaceId}/projects/${projectId}/journal`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      return { ok: res.ok };
    },
    createTask: async (title: string) => {
      const res = await env.SPACES_WORKER.fetch(`http://internal/spaces/${spaceId}/projects/${projectId}/tasks`, {
        method: "POST",
        body: JSON.stringify({ title })
      });
      return { ok: res.ok };
    },
    listThreads: async () => {
      const res = await env.SPACES_WORKER.fetch(`http://internal/spaces/${spaceId}/projects/${projectId}/threads`);
      return await res.json();
    },
    postMessage: async (threadId: string, text: string) => {
      const res = await env.SPACES_WORKER.fetch(`http://internal/spaces/${spaceId}/projects/${projectId}/threads/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: text })
      });
      return { ok: res.ok };
    }
  } : undefined;

  // 3. Space Slice (STRICTLY RESTRICTED to Space Assistant)
  const space = (scope === "SPACE_WIDE") ? {
    id: spaceId,
    createProject: async (name: string, kind: string, templateId?: string) => {
      const res = await env.SPACES_WORKER.fetch(`http://internal/spaces/${spaceId}/projects`, {
        method: "POST",
        body: JSON.stringify({ name, kind, templateId })
      });
      return await res.json();
    },
    listProjects: async () => {
      const res = await env.SPACES_WORKER.fetch(`http://internal/spaces/${spaceId}/projects`);
      return await res.json();
    },
    getWalletBalance: async () => {
      const res = await env.BILLING_WORKER.fetch(`http://internal/spaces/${spaceId}/wallet-balance`);
      return await res.json();
    },
    sendNotification: async (title: string, body: string) => {
      const res = await env.NOTIFICATIONS_WORKER.fetch(`http://internal/notify`, {
        method: "POST",
        body: JSON.stringify({ title, body, userId: actingUserId })
      });
      return { ok: res.ok };
    }
  } : undefined; // Project agents receive undefined for space-wide operations!

  // 4. Zero-Leak Vault Slice
  const vault = {
    fetchWithAuth: async (url: string, opts: { credentialName: string; method?: string; body?: any; headers?: Record<string, string> }) => {
      return await env.CREDENTIALS_WORKER.fetch(`http://internal/vault/proxy`, {
        method: "POST",
        body: JSON.stringify({
          url,
          spaceId,
          actingUserId,
          credentialName: opts.credentialName,
          method: opts.method || "GET",
          body: opts.body,
          headers: opts.headers
        })
      });
    }
  };

  // 5. MCP Connector Slice
  const mcp = {
    call: async (server: string, tool: string, params: Record<string, any>) => {
      const res = await env.MCP_HUB_WORKER.fetch(`http://internal/mcp/call`, {
        method: "POST",
        body: JSON.stringify({ server, tool, params, spaceId, actingUserId })
      });
      return await res.json();
    },
    listTools: async (server: string) => {
      const res = await env.MCP_HUB_WORKER.fetch(`http://internal/mcp/list-tools?server=${server}`);
      return await res.json();
    }
  };

  // 6. Browser Slice (Tier 4/5 Routing)
  const browser = {
    navigate: async (url: string) => {
      const res = await env.BROWSER_WORKER.fetch(`http://internal/browser/navigate`, {
        method: "POST",
        body: JSON.stringify({ url, action: "navigate" })
      });
      return await res.json();
    },
    click: async (selector: string) => {
      const res = await env.BROWSER_WORKER.fetch(`http://internal/browser/action`, {
        method: "POST",
        body: JSON.stringify({ action: "click", selector })
      });
      return { ok: res.ok };
    },
    type: async (selector: string, text: string) => {
      const res = await env.BROWSER_WORKER.fetch(`http://internal/browser/action`, {
        method: "POST",
        body: JSON.stringify({ action: "type", selector, text })
      });
      return { ok: res.ok };
    },
    extract: async (selector: string) => {
      const res = await env.BROWSER_WORKER.fetch(`http://internal/browser/extract`, {
        method: "POST",
        body: JSON.stringify({ selector })
      });
      return await res.json();
    }
  };

  const runSkill = async (skillName: string, args: Record<string, any>) => {
    // Run pre-distilled skill from R2 Skill Library
    const res = await env.codeRunner.run({
      name: skillName,
      tier: 2,
      args,
      spaceId,
      projectId
    });
    return res;
  };

  return { fs, project, space, vault, mcp, browser, runSkill };
}
```

---

### C. Update `workers/agents/src/do/NaelaoAgentDO.ts`

In `NaelaoAgentDO.ts`, wire the instantiation of `buildRuntimeContext` and pass it directly into the script execution call:

```typescript
// Inside NaelaoAgentDO.ts
import { buildRuntimeContext } from "../script-engine/code-runner";
import { VirtualPosixShell } from "../workspace/virtual-shell";
import { ArtifactsGitService } from "../services/ArtifactsGitService";

export class NaelaoAgentDO extends DurableObject {
  private virtualShell!: VirtualPosixShell;
  private artifactsGit!: ArtifactsGitService;

  async ensureInit() {
    this.virtualShell = new VirtualPosixShell(this.getVirtualFsStorage());
    this.artifactsGit = new ArtifactsGitService(this.env);
  }

  async runAgentCodeMode(scriptCode: string, args: Record<string, any>, options: { spaceId: string; projectId?: string; actingUserId?: string; scope: "SPACE_WIDE" | "PROJECT_BOUND" }) {
    await this.ensureInit();

    // 1. Build the isolated, scoped, and credential-shielded `ctx` object
    const ctx = buildRuntimeContext(
      this.env,
      options.scope,
      options.spaceId,
      options.projectId,
      options.actingUserId,
      this.virtualShell,
      this.artifactsGit
    );

    // 2. Execute the CodeMode module, passing `args` and `ctx`
    return await this.env.codeRunner.run({
      name: "agent_codemode_run",
      code: scriptCode,
      tier: 2,
      args,
      ctx // Injected as the second argument: `run(args, ctx)`
    });
  }

  private getVirtualFsStorage() {
    return {
      readFile: async (p: string) => {
        const row = this.ctx.storage.sql.exec("SELECT content FROM workspace_files WHERE path = ?", p).toArray() as any[];
        return row[0]?.content || null;
      },
      writeFile: async (p: string, data: string) => {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO workspace_files (path, content, hash, size_bytes) VALUES (?, ?, ?, ?)",
          p, data, "sha256_placeholder", data.length
        );
      },
      listFiles: async (prefix?: string) => {
        const rows = this.ctx.storage.sql.exec("SELECT path FROM workspace_files").toArray() as any[];
        return rows.map(r => r.path);
      },
      deleteFile: async (p: string) => {
        const result = this.ctx.storage.sql.exec("DELETE FROM workspace_files WHERE path = ?", p);
        return result.meta.changes > 0;
      }
    };
  }
}
```

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Update `workers/agents/src/script-engine/types.ts` to include all runtime types and interfaces (`AvosFsRuntime`, `AvosProjectRuntime`, `AvosSpaceRuntime`, `AvosVaultRuntime`, `AvosMcpRuntime`, `AvosBrowserRuntime`, `AvosRuntimeContext`).
2. Update `workers/agents/src/script-engine/code-runner.ts`:
   - Import `buildRuntimeContext` and implement its complete logic.
   - Guard `space` and `project` assignments strictly using `scope` and `projectId` parameters (Physical RBAC Firewall).
3. Update `workers/agents/src/do/NaelaoAgentDO.ts`:
   - Initialize `VirtualPosixShell` and `ArtifactsGitService` during `ensureInit()`.
   - Implement `runAgentCodeMode` to build the `ctx` object on every execution turn and pass it into the runner.
4. Run `node --check` syntax validation on the modified files to verify no TypeScript compilation or module dependency failures exist.
```
