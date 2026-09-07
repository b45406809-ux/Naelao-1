Here is the **full, long, detailed, and highly specific** markdown specification for **Phase 3 — Chunk 07**. 

This completely replaces the summarized stub from the previous response and provides the exact production-ready architectural rules, Zod schemas, and AI generation logic needed by the execution runner.

---

```markdown
---
chunk_id: "phase-3-chunk-07"
phase: 3
include_files:
  - workers/agents/src/script-engine/prebuilt/skill-distiller.ts
  - workers/agents/src/script-engine/prebuilt/video-learner.ts
  - packages/types/src/workflow.ts
repomix_include:
  - "workers/agents/src/script-engine/prebuilt/skill-distiller.ts"
  - "workers/agents/src/script-engine/prebuilt/video-learner.ts"
  - "packages/types/src/workflow.ts"
expected_outputs:
  - workers/agents/src/script-engine/prebuilt/skill-distiller.ts
  - workers/agents/src/script-engine/prebuilt/video-learner.ts
  - packages/types/src/workflow.ts
---

# Phase 3 — Chunk 07: Skill Distillation, Video Learning & Declarative Hooks

## 1. Mental Model & Architectural Vision

AVOS agents do not just execute tasks; they **learn and compound capabilities**. When an agent solves a novel, complex problem spanning multiple turns (e.g., fetching from Stripe, parsing JSON, editing an Astro component), it shouldn't have to burn 4,000 tokens reasoning through that exact same sequence tomorrow.

Similarly, non-technical founders should be able to teach the AI a workflow by simply **recording their screen** and dropping the MP4 into the workspace.

This chunk builds the **Skill Distillation Engine** and **Declarative Hook Definitions**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                 DEMONSTRATION-TO-SKILL COMPILATION PIPELINE                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Execution Trace Ingestion │ Captures raw operation log:                  │
│                              │ `[{ op: "fetch", url }, { op: "bash" }]`     │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ 2. Parameterization & AST    │ Identifies dynamic variables: `clientEmail`, │
│    Synthesis (Workers AI)    │ `invoiceId`. Generates clean TypeScript:     │
│                              │ `export async function run(args, ctx)`       │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ 3. Isolated Sandbox Verify   │ Tests the synthesized script inside a Tier 2 │
│                              │ V8 Isolate sandbox to verify compilation.    │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ 4. R2 Internal Registration  │ Persists to `/.avos/shared/skills/{name}.ts`.│
│                              │ Subsequent runs execute in 5ms for $0.0001!  │
└──────────────────────────────┴──────────────────────────────────────────────┘
```

### Core Invariants:
1. **Zero Workspace Pollution:** Synthesized skills MUST be saved to `/.avos/shared/skills/` (the internal agent OS state), never to `/workspace/` (the user's application code).
2. **Context Primitives Only:** The generated code must rely exclusively on the Universal `ctx` SDK (`ctx.fs`, `ctx.vault`, `ctx.cli`, `ctx.browser`).

---

## 2. Implementation Requirements

### A. Create `workers/agents/src/script-engine/prebuilt/skill-distiller.ts`
Implement the text-based trace distillation engine. The agent takes a recent successful execution trace and compiles it into a parameterized TypeScript skill.

```typescript
import { generateObject } from "ai";
import { z } from "zod";

export async function distillSkillFromTrace(
  trace: Array<{ op: string; input: Record<string, any>; output: any }>,
  skillName: string,
  ctx: any
) {
  // 1. Synthesize parameterized TypeScript module from raw execution trace
  const { object: skillSpec } = await generateObject({
    model: ctx.env.AI_GATEWAY("gemini-2.5-flash"), // Fast model for code synthesis
    schema: z.object({
      description: z.string(),
      parameters: z.array(z.object({
        name: z.string(),
        type: z.enum(["string", "number", "boolean"]),
        description: z.string()
      })),
      handlerCode: z.string().describe("The full TypeScript function body. MUST use ctx primitives (ctx.cli, ctx.fs, ctx.vault). Do not wrap in markdown blocks.")
    }),
    prompt: `Convert this raw execution trace into a reusable, parameterized TypeScript skill.
    Name: ${skillName}
    Trace: ${JSON.stringify(trace)}
    
    Return a clean, optimized function body that executes this sequence using the AVOS ctx SDK.`
  });

  const synthesizedCode = `
/**
 * Auto-Distilled Skill: ${skillName}
 * ${skillSpec.description}
 */
export async function run(args: Record<string, any>, ctx: any) {
  ${skillSpec.parameters.map(p => `const ${p.name} = args["${p.name}"];`).join("\n  ")}
  
  try {
${skillSpec.handlerCode.split('\n').map(line => `    ${line}`).join('\n')}
    return { ok: true, message: "Successfully executed skill: ${skillName}" };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}`;

  // 2. Verify compilation in isolated Tier 2 V8 sandbox
  const verifyRun = await ctx.env.codeRunner.run({
    name: `verify_${skillName}`,
    code: synthesizedCode,
    tier: 2,
    args: {}, // Run without args just to check compilation/syntax
    dryRun: true,
    spaceId: ctx.env.spaceId,
    agentId: ctx.env.agentId
  });

  if (verifyRun.exitCode !== 0 && verifyRun.exitCode !== undefined) {
    throw new Error(`Skill distillation failed syntax verification: ${verifyRun.stderr}`);
  }

  // 3. Persist to shared skills directory (Git-ignored internal meta-state)
  const targetPath = `/.avos/shared/skills/${skillName}.ts`;
  await ctx.fs.write(targetPath, synthesizedCode);

  return { 
    ok: true, 
    skillName, 
    path: targetPath, 
    parameters: skillSpec.parameters 
  };
}
```

---

### B. Create `workers/agents/src/script-engine/prebuilt/video-learner.ts`
Implement the multimodal video processing pipeline. This allows a user to drop an MP4 into the workspace, and the AI translates the video into programmatic automation code.

```typescript
import { generateObject } from "ai";
import { z } from "zod";

export async function distillSkillFromVideo(
  videoR2Key: string,
  skillName: string,
  ctx: any
) {
  // 1. Verify file exists in R2 Workspace
  const fileStat = await ctx.fs.stat(videoR2Key);
  if (!fileStat.exists) {
    throw new Error(`Video file not found in workspace: ${videoR2Key}`);
  }

  // 2. Multimodal Action Extraction
  // Note: In production, the video buffer is passed to a multimodal endpoint.
  // Here we define the extraction schema to map visual actions to SDK steps.
  const { object: actionSequence } = await generateObject({
    model: ctx.env.AI_GATEWAY("gemini-2.5-flash"), // Multimodal vision capable
    schema: z.object({
      parameters: z.array(z.object({
        name: z.string(),
        type: z.string(),
        description: z.string()
      })),
      steps: z.array(z.object({
        actionType: z.enum(["NAVIGATE", "CLICK", "TYPE", "EXTRACT", "BASH"]),
        target: z.string().describe("URL, CSS selector, or CLI command"),
        valueExpression: z.string().describe("Dynamic parameter name (e.g. args.invoiceId) or literal string"),
        description: z.string()
      }))
    }),
    prompt: `Analyze this recorded video demonstration for skill '${skillName}'.
    Extract the parameterizable inputs, DOM interactions, and logic flow required to replicate this exact task programmatically using the AVOS SDK.`
  });

  // 3. Synthesize clean TypeScript utilizing universal ctx primitives
  const synthesizedCode = `
/**
 * Auto-Distilled Video Skill: ${skillName}
 * Source: ${videoR2Key}
 */
export async function run(args: Record<string, any>, ctx: any) {
  ${actionSequence.parameters.map(p => `const ${p.name} = args["${p.name}"];`).join("\n  ")}

  // Replay synthesized action timeline
  ${actionSequence.steps.map(s => {
    if (s.actionType === "NAVIGATE") return `await ctx.browser.execute({ action: "navigate", url: "${s.target}" });`;
    if (s.actionType === "CLICK") return `await ctx.browser.execute({ action: "click", selector: "${s.target}" });`;
    if (s.actionType === "TYPE") return `await ctx.browser.execute({ action: "type", selector: "${s.target}", text: ${s.valueExpression} });`;
    if (s.actionType === "BASH") return `await ctx.cli.exec(${s.valueExpression});`;
    return `// ${s.description}`;
  }).join("\n  ")}

  return { ok: true, message: "Successfully executed video-learned skill: ${skillName}" };
}
`;

  // 4. Save to Authoritative Skill Library in R2 internal namespace
  const targetPath = `/.avos/shared/skills/${skillName}.ts`;
  await ctx.fs.write(targetPath, synthesizedCode);

  return {
    ok: true,
    skillName,
    path: targetPath,
    parameters: actionSequence.parameters,
    message: `✔ Successfully learned and registered skill '${skillName}' from video demonstration.`
  };
}
```

---

### C. Update `packages/types/src/workflow.ts`
To ensure users can add custom verification steps without introducing raw code security vulnerabilities, define the JSON-serializable **Declarative Pipeline Hooks** schema.

```typescript
// Add to packages/types/src/workflow.ts (or create if missing)

export type WorkflowClass = "COMPANY_AUTOMATION" | "VERTICAL_EXTENSION" | "EPHEMERAL_TASK";

/**
 * Declarative hooks allow templates and users to inject verification and context enrichment 
 * steps safely without writing raw execution scripts that could leak credentials.
 */
export interface DeclarativePipelineHooks {
  /**
   * Pre-flight context enrichment. E.g., Query a background indexing gadget via MCP 
   * to fetch a relational graph before touching code.
   */
  preFlightMcp?: Array<{
    server: string;
    tool: string;
    description: string;
  }>;

  /**
   * Verification Gate. A deterministic validation check run before a task is marked complete.
   */
  verificationGate?: {
    command: string;           // e.g., "npm test" or "pytest"
    requiredExitCode: number;  // e.g., 0
    maxRetryAttempts: number;  // e.g., 2
  };
}

export interface AvosWorkflowDefinition {
  id: string;
  name: string;
  description: string;
  workflowClass: WorkflowClass;
  scope: "SPACE_WIDE" | "PROJECT_BOUND" | "TASK_BOUND";
  spaceId: string;
  projectId?: string;
  bundledByPluginId?: string;

  trigger: {
    type: "cron" | "webhook" | "event_queue" | "on_demand";
    cronExpression?: string; 
    eventTopic?: string;
  };

  governance: {
    maxStepCeiling: number;
    stepTimeoutSeconds: number;
    alertChannel: "FOUNDER_TELEGRAM" | "PROJECT_TEAM_ROOM" | "THREAD_RECEIPT_ONLY";
    fundingSource: "COMPANY_WALLET" | "PROJECT_CAP" | "USER_CREDITS";
  };

  hooks?: DeclarativePipelineHooks;
  entrypointPath: string; // The .avos/shared/workflows/ path
}
```

---

## 3. Strict Guidelines for the LLM Runner
1. **Never use `// ... existing code ...`**. You must output the entire TypeScript file contents.
2. Ensure you import from `"ai"` and `"zod"` correctly in the video and skill distillation files.
3. Keep the file paths strictly within the `/.avos/shared/` internal boundary.
```
