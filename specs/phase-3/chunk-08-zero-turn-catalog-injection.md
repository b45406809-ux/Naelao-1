Here is the complete, fully detailed, and production-ready Markdown specification file for **Phase 3 — Chunk 08**: `specs/phase-3/chunk-08-zero-turn-catalog-injection.md`. 

This file explains the "Catalog-in-Prompt, Code-on-Disk" architecture thoroughly so the AI generating the code understands exactly how to eliminate the "Tool Discovery Token Tax."

---

```markdown
---
chunk_id: "phase-3-chunk-08"
phase: 3
include_files:
  - workers/agents/src/script-engine/tool-surface.ts
  - workers/agents/src/script-engine/profiles.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
repomix_include:
  - "workers/agents/src/script-engine/tool-surface.ts"
  - "workers/agents/src/script-engine/profiles.ts"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
expected_outputs:
  - workers/agents/src/script-engine/tool-surface.ts
  - workers/agents/src/script-engine/profiles.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
---

# Phase 3 — Chunk 08: Zero-Turn Catalog Injection

## 1. Mental Model & Architectural Vision

**The "Tool Discovery Token Tax" Hazard:**
When an agent spawns into a project, it doesn't automatically know what custom JIT Virtual CLIs (e.g., `shopify`, `linear`) or distilled TypeScript skills (e.g., `audit-contracts.ts`) have been previously built and registered by itself or its sibling agents. If left blind, the agent will waste precious reasoning turns and tokens running `ls /.avos/shared/skills/` or attempting commands blindly to see if they exist.

**The Solution: Catalog-in-Prompt, Code-on-Disk**
To solve this, we implement **Zero-Turn Catalog Injection**. Before the first LLM turn executes, the `NaelaoAgentDO` gathers a lightweight manifest of all dynamically registered commands from SQLite and all distilled skills from the internal `/.avos/` filesystem. 

This manifest is appended directly into the agent's system prompt. 
* **Result:** The AI instantly knows its exact capabilities on Turn 1. 
* **Efficiency:** We only inject the *signatures and descriptions* (the catalog), while the actual execution code remains on disk or in SQLite, keeping the context window incredibly lean.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       ZERO-TURN CATALOG COMPILATION                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Read SQLite: `SELECT command_name, description FROM virtual_cli_commands`│
│ 2. Read VFS: `glob /.avos/shared/skills/*.ts`                               │
│ 3. Format as Markdown.                                                      │
│ 4. Inject into `DECISION_INSTRUCTIONS` before LLM API Call.                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Implementation Requirements

### A. Update `workers/agents/src/script-engine/tool-surface.ts`

Add a static helper method to generate the formatted catalog markdown. It must safely query the Durable Object's SQLite storage and the Virtual Filesystem without throwing errors if tables or directories don't exist yet (graceful degradation for greenfield projects).

```typescript
import { getAvosInternalPath } from "./types";

export class ScriptToolSurface {
  // ... existing methods (getMinimalistToolDeclarations, handleToolCall)

  /**
   * Generates a markdown-formatted catalog of all JIT-synthesized Virtual CLIs
   * and distilled skills available in the current workspace.
   * Fails gracefully if tables or directories do not exist yet.
   */
  static async generateZeroTurnCatalog(
    doStorage: DurableObjectStorage, 
    workspaceFs: any, // Reference to the project's virtual file system
    spaceId: string, 
    projectId?: string
  ): Promise<string> {
    let catalog = "\n# INSTALLED WORKSPACE COMMANDS & SKILLS\n";
    catalog += "The following custom commands and scripts have been synthesized and are available via the `Bash` tool:\n\n";
    
    let hasItems = false;

    // 1. Fetch JIT Virtual CLIs from SQLite
    try {
      // Note: Use '?' for parameter binding in DO SQLite, NEVER named parameters.
      const virtualClis = doStorage.sql.exec(
        "SELECT command_name, description FROM virtual_cli_commands WHERE space_id = ?", 
        spaceId
      ).toArray();

      if (virtualClis.length > 0) {
        hasItems = true;
        catalog += "## Virtual CLIs\n";
        virtualClis.forEach((cli: any) => {
          catalog += `- \`${cli.command_name}\`: ${cli.description}\n`;
        });
        catalog += "\n";
      }
    } catch (err) {
      // Table might not exist yet if no CLI has been registered. Ignore.
    }

    // 2. Fetch Distilled Skills from Workspace (.avos/shared/skills/)
    try {
      const skillsPath = `${getAvosInternalPath(spaceId, projectId)}shared/skills/`;
      // Use the workspaceFs glob/readdir equivalent here
      const skills = await workspaceFs.listFiles(skillsPath); 
      
      const tsFiles = skills.filter((f: string) => f.endsWith(".ts"));
      
      if (tsFiles.length > 0) {
        hasItems = true;
        catalog += "## Distilled Skills\n";
        tsFiles.forEach((file: string) => {
          const skillName = file.split('/').pop()?.replace('.ts', '');
          // Inform the agent it can execute this via standard Node/Bash
          catalog += `- \`Bash("node ${file}")\`: Executable shared skill module.\n`;
        });
        catalog += "\n";
      }
    } catch (err) {
      // Directory might not exist yet. Ignore.
    }

    // If nothing is installed yet, return an empty string to save prompt tokens
    return hasItems ? catalog : "";
  }
}
```

### B. Update `workers/agents/src/script-engine/profiles.ts`

Ensure the profile compiler function accepts the dynamic catalog string and safely appends it to the base `DECISION_INSTRUCTIONS` or `systemPrompt`.

```typescript
export function composeSystemPrompt(
  baseIdentity: string, 
  businessContext: string, 
  zeroTurnCatalog: string
): string {
  return `
${baseIdentity}

# BUSINESS CONTEXT
${businessContext}

${zeroTurnCatalog}

# OPERATING RULES
You have access to a high-speed development environment. 
Use the 'Bash' tool to execute any installed workspace commands or scripts listed above.
Do not attempt to reinstall or recreate them if they are already listed.
`.trim();
}
```

### C. Update `workers/agents/src/do/NaelaoAgentDO.ts`

Inside the `NaelaoAgentDO` reasoning loop setup (e.g., inside `handleScriptRun` or `handleRun` before the `GatewayReasoner` is initialized), compile the catalog and inject it into the prompt assembly.

```typescript
// Inside NaelaoAgentDO.ts

async handleScriptRun(body: any) {
  // ... existing setup (auth gates, role resolution, etc.)

  // 1. Generate the Zero-Turn Catalog
  const zeroTurnCatalog = await ScriptToolSurface.generateZeroTurnCatalog(
    this.ctx.storage,
    this.workspaceFs, // Your instantiated Virtual FS from Phase 1
    this.env.spaceId,
    this.env.projectId
  );

  // 2. Compose the final system prompt
  const systemPrompt = composeSystemPrompt(
    agentProfile.soulMarkdown,
    businessContext,
    zeroTurnCatalog
  );

  // 3. Initialize Reasoner with the enriched prompt
  // ... proceed to execute the reasoning loop
}
```

## 3. Strict Execution Guidelines
1. **Never use `PRAGMA` statements** or `BEGIN/COMMIT` strings inside Durable Object SQLite. It will cause `not authorized: SQLITE_AUTH` errors in production.
2. **Handle empty states cleanly.** If a project was just created and has no skills or virtual CLIs, `generateZeroTurnCatalog` MUST return an empty string rather than throwing an error or injecting a noisy header with no items. 
3. **Emit Complete Files:** Ensure that the generated code output applies these additions comprehensively using the `apply_chunk_code` tool. Do not use placeholders like `// ... rest of file`.
```
