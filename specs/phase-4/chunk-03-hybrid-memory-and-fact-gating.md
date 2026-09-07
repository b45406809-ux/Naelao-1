Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 4 — Chunk 03**: `specs/phase-4/chunk-03-hybrid-memory-and-fact-gating.md`.

---

```markdown
---
chunk_id: "phase-4-chunk-03"
phase: 4
include_files:
  - workers/agents/src/script-engine/memory-os.ts
  - workers/agents/src/script-engine/project-journal.ts
  - packages/rag/src/index.ts
repomix_include:
  - "workers/agents/src/script-engine/memory-os.ts"
  - "workers/agents/src/script-engine/project-journal.ts"
  - "packages/rag/src/index.ts"
expected_outputs:
  - packages/rag/src/memory-gating.ts
  - packages/rag/src/index.ts
  - workers/agents/src/script-engine/memory-os.ts
---

# Phase 4 — Chunk 03: 3-Layer Hybrid Memory, Cross-Thread Isolation & Semantic Fact Gating

## 1. Executive Summary & Architectural Vision

Carrying raw conversational transcripts across threads causes **contextual drift, token bloat, and prompt pollution** (e.g. 50 turns of past Stripe debugging noise leaking into a brand-new CSV export script thread).

AVOS enforces a strict separation between **Conversational State** (which is ephemeral to a thread) and **Semantic Knowledge** (which is distilled and persistent). Every new thread starts with a clean `0-turn` context window. What an agent learns in Thread 1 is distilled into **atomic technical rules** and stored in Cloudflare Vectorize. In Thread 2, those rules are retrieved **only if their cosine similarity exceeds 0.80** against the new prompt.

```
                                  ┌──────────────────────────────────────────────┐
                                  │           PROJECT: "Core SaaS App"           │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                         ┌───────────────────────────────┴───────────────────────────────┐
                         ▼                                                               ▼
┌─────────────────────────────────────────────────────────────┐   ┌─────────────────────────────────────────────────────────────┐
│ 💬 THREAD #1: "Stripe Webhook Bug" (50 Messages Long)        │   │ 💬 THREAD #2: "Write CSV Export Script" (Brand New Thread)  │
├─────────────────────────────────────────────────────────────┤   ├─────────────────────────────────────────────────────────────┤
│ User and @DevAgent debug Stripe signatures.                 │   │ User opens a fresh thread with @DevAgent:                   │
│ Raw transcript full of compiler errors and stack traces.    │   │ "Write a script to export customer emails to CSV."          │
└──────────────────────────────┬──────────────────────────────┘   └──────────────────────────────┬──────────────────────────────┘
                               │                                                                 │
                               ▼ (Task Concludes)                                                │
┌─────────────────────────────────────────────────────────────┐                                 │
│ BACKGROUND DISTILLATION HOOK (Workers AI in V8 Isolate)     │                                 │
│ Distills atomic rule into Vectorize (`BOT_SKILL` scope):    │                                 │
│ "Rule #42: Always use crypto.subtle for webhook signatures."│                                 │
└──────────────────────────────┬──────────────────────────────┘                                 │
                               │                                                                 │
                               ▼                                                                 │
┌─────────────────────────────────────────────────────────────┐                                 │
│ 🧠 PERSISTENT BOT MEMORY BANK (Cloudflare Vectorize)         │                                 │
│ Contains learned technical rules scoped to `bot_id`.        │                                 │
└──────────────────────────────┬──────────────────────────────┘                                 │
                               │                                                                 │
                               │                                     (Query: "Export to CSV")    │
                               │                                                                 ▼
                               │                                  ┌─────────────────────────────────────────────────────────────┐
                               └─────────────────────────────────►│ SEMANTIC RELEVANCE FILTER (Cosine Similarity > 0.80)        │
                                                                  ├─────────────────────────────────────────────────────────────┤
                                                                  │ • Stripe rule: Cosine 0.18 ──► DISCARDED!                   │
                                                                  │ • CSV rule:    Cosine 0.89 ──► INJECTED!                    │
                                                                  ├─────────────────────────────────────────────────────────────┤
                                                                  │ 🚀 Thread #2 stays 100% clean of Stripe pollution!          │
                                                                  │ Agent only receives rules relevant to the current task!     │
                                                                  └─────────────────────────────────────────────────────────────┘
```

---

## 2. The 3-Layer Hybrid Memory Model

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     THE 3-LAYER HYBRID MEMORY HIERARCHY                                   │
├────────────────────┬─────────────────────────┬────────────────────────────┬───────────────────────────────┤
│ Memory Layer       │ Storage Medium          │ Durability & Scoping       │ Content & Structure           │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Layer 1: Working │ In-Memory DO RAM +      │ Ephemeral to Thread        │ Active turn messages, current │
│ **Context**        │ `messages` table        │ (Auto-compacted at 30k tok)│ tool observation buffers.     │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Layer 2: Project │ Virtual SQLite FS       │ Persistent to Project      │ Authoritative architecture,   │
│ **Ground Truth**   │ (`PROJECT.md`)          │ (Shared by all agents)     │ active Task DAGs, rules.      │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Layer 3: Semantic│ Cloudflare Vectorize +  │ Persistent across Threads  │ Distilled atomic rules,       │
│ **Fact Bank**      │ D1 Fact Store           │ (Gated at Cosine > 0.80)   │ preferences, bug lessons.     │
└────────────────────┴─────────────────────────┴────────────────────────────┴───────────────────────────────┘
```

### The 3 Golden Rules of Memory Isolation:
1. **Zero Raw Transcript Bleed:** Message records from Thread 1 are **never** queried or injected into Thread 2. Thread 2 starts with a clean `0-turn` working memory.
2. **Atomic Rule Distillation:** Raw conversation history is never saved as long-term memory. Completed tasks pass through a background Workers AI distillation pass that extracts concise, generalized engineering rules.
3. **Relevance Gating:** Distilled rules are queried via dense embeddings (`bge-small-en-v1.5`). If a rule scores below **0.80 cosine similarity**, it is discarded and never touches the prompt.

---

## 3. Mathematical Formulation of Semantic Fact Gating

Let a user query in a new thread $q$ have dense embedding vector $\mathbf{q} \in \mathbb{R}^d$. Let the persistent fact bank for an agent contain candidate rules $\mathcal{R} = \{r_1, r_2, \dots, r_n\}$ with embedding vectors $\mathbf{v}_i \in \mathbb{R}^d$ and metadata tags $\mathbf{m}_i$.

The semantic relevance scoring function is defined as:
$$\text{Sim}(q, r_i) = \frac{\mathbf{q} \cdot \mathbf{v}_i}{\|\mathbf{q}\| \|\mathbf{v}_i\|}$$

The gated memory subset $\mathcal{R}_{\text{injected}}$ injected into the system prompt is computed via the threshold indicator:
$$\mathcal{R}_{\text{injected}} = \left\{ r_i \in \mathcal{R} \;\middle|\; \text{Sim}(q, r_i) \ge 0.80 \;\land\; \mathbf{m}_i.\text{bot\_id} = \text{CurrentBotId} \;\land\; \mathbf{m}_i.\text{space\_id} = \text{CurrentSpaceId} \right\}$$

Any candidate rule with $\text{Sim}(q, r_i) < 0.80$ is physically excluded from context, guaranteeing that unrelated domain facts cannot pollute the active context window.

---

## 4. Technical Specifications & File Implementation Contracts

### A. Create `packages/rag/src/memory-gating.ts`

Create the gating logic, interfaces, and relevance filters:

```typescript
export interface DistilledRuleMetadata {
  ruleId: string;
  ruleText: string;
  scope: "BOT_SKILL" | "PROJECT_SHARED" | "USER_PRIVATE";
  botId: string;
  spaceId: string;
  projectId?: string;
  derivedFromTaskId?: string;
  createdAt: string;
}

export interface GatedFactMatch {
  rule: DistilledRuleMetadata;
  similarity: number;
}

/**
 * Calculates cosine similarity between two normalized vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Filters candidate vector matches against a strict relevance floor.
 * Discards low-similarity chunks to prevent context pollution.
 */
export function filterFactsByRelevance(
  candidateMatches: Array<{ id: string; score: number; metadata: any }>,
  similarityThreshold: number = 0.80
): GatedFactMatch[] {
  return candidateMatches
    .filter(match => match.score >= similarityThreshold)
    .map(match => ({
      rule: {
        ruleId: match.id,
        ruleText: match.metadata.rule_text || "",
        scope: match.metadata.scope || "BOT_SKILL",
        botId: match.metadata.bot_id || "",
        spaceId: match.metadata.space_id || "",
        projectId: match.metadata.project_id,
        derivedFromTaskId: match.metadata.derived_from_task_id,
        createdAt: match.metadata.created_at || new Date().toISOString()
      },
      similarity: match.score
    }))
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * Formats gated facts into a clean XML block for prompt insertion.
 */
export function formatGatedFactsForPrompt(facts: GatedFactMatch[]): string {
  if (facts.length === 0) return "";

  const items = facts.map(f => 
    `  <learned_rule id="${f.rule.ruleId}" confidence="${f.similarity.toFixed(2)}">\n    ${f.rule.ruleText}\n  </learned_rule>`
  ).join("\n");

  return `<recalled_rules count="${facts.length}">\n${items}\n</recalled_rules>`;
}
```

Re-export `memory-gating.ts` from `packages/rag/src/index.ts`.

---

### B. Update `workers/agents/src/script-engine/memory-os.ts`

Integrate distillation and clean-thread context hydration into `MemoryOS`:

```typescript
import { filterFactsByRelevance, formatGatedFactsForPrompt, GatedFactMatch } from "@naelao/rag";

export interface DistillOptions {
  turnMessages: Array<{ role: string; content: string }>;
  botId: string;
  spaceId: string;
  projectId?: string;
  taskId?: string;
}

export class MemoryOS {
  constructor(private env: any) {}

  /**
   * Post-Task Distillation Hook: Extracts permanent architectural rules from completed turns.
   * Runs asynchronously in a V8 isolate without blocking user response.
   */
  async distillAndPersistLearnings(opts: DistillOptions): Promise<{ rulesExtracted: number }> {
    if (opts.turnMessages.length < 2) return { rulesExtracted: 0 };

    // Format recent dialog for extraction prompt
    const conversationSummary = opts.turnMessages
      .slice(-6)
      .map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 300)}`)
      .join("\n");

    const extractionPrompt = `Analyze this completed task conversation. Extract 1 to 3 permanent, reusable technical rules or architectural patterns learned.
Do NOT record conversational small talk, temporary bug locations, or pleasantries.
Format your output as a JSON array of strings. Example: ["Always verify webhook signatures with crypto.subtle", "Use Tailwind dark: prefix for theme variants"]

DIALOG:
${conversationSummary}`;

    try {
      const response = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct", {
        messages: [{ role: "user", content: extractionPrompt }]
      });

      const rawJson = response.response || "[]";
      const jsonMatch = rawJson.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return { rulesExtracted: 0 };

      const extractedRules: string[] = JSON.parse(jsonMatch[0]);

      for (const rule of extractedRules) {
        if (!rule || rule.length < 10) continue;

        // Generate dense embedding vector using Workers AI
        const embeddingRes = await this.env.AI.run("@cf/baai/bge-small-en-v1.5", {
          text: [rule]
        });
        const vector = embeddingRes.data[0];

        const ruleId = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        // Upsert into Vectorize with strict scoping metadata
        await this.env.MEMORY_VECTORIZE.upsert([
          {
            id: ruleId,
            values: vector,
            metadata: {
              rule_text: rule,
              scope: "BOT_SKILL",
              bot_id: opts.botId,
              space_id: opts.spaceId,
              project_id: opts.projectId || "",
              derived_from_task_id: opts.taskId || "",
              created_at: new Date().toISOString()
            }
          }
        ]);
      }

      return { rulesExtracted: extractedRules.length };
    } catch (err: any) {
      console.warn(`Memory distillation hook encountered an error: ${err.message}`);
      return { rulesExtracted: 0 };
    }
  }

  /**
   * Thread Hydration Hook: Queries Vectorize for relevant rules with a strict 0.80 cosine floor.
   * Ensures new threads start clean with zero previous conversational transcripts.
   */
  async retrieveGatedMemoriesForPrompt(
    userQuery: string,
    botId: string,
    spaceId: string,
    projectId?: string
  ): Promise<string> {
    try {
      const embeddingRes = await this.env.AI.run("@cf/baai/bge-small-en-v1.5", {
        text: [userQuery]
      });
      const queryVector = embeddingRes.data[0];

      // Query Vectorize scoped to this bot and space
      const matches = await this.env.MEMORY_VECTORIZE.query(queryVector, {
        topK: 5,
        filter: {
          space_id: spaceId,
          bot_id: botId,
          scope: "BOT_SKILL"
        },
        returnMetadata: "all"
      });

      // Filter against strict 0.80 relevance floor
      const gatedFacts = filterFactsByRelevance(matches.matches, 0.80);
      return formatGatedFactsForPrompt(gatedFacts);
    } catch (err: any) {
      console.warn(`Memory recall error: ${err.message}`);
      return "";
    }
  }
}
```

---

### C. Update `workers/agents/src/script-engine/project-journal.ts`

Ensure Layer 2 Deterministic Truth (`PROJECT.md`) is maintained as the authoritative anchor across threads:
* `readProjectJournal()`: Reads `/workspace/PROJECT.md` directly from the SQLite virtual filesystem.
* `appendJournalMilestone()`: Records completed Task DAG checkpoints and current active goals.
* Thread contexts include Layer 2 (`PROJECT.md`) + Layer 3 (gated facts via `retrieveGatedMemoriesForPrompt`), while raw chat histories remain strictly isolated.

---

## 5. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. **Create `packages/rag/src/memory-gating.ts`:**
   - Implement `cosineSimilarity`, `filterFactsByRelevance`, and `formatGatedFactsForPrompt`.
   - Ensure the similarity threshold defaults strictly to `0.80`.
2. **Update `packages/rag/src/index.ts`:**
   - Re-export all types and functions from `memory-gating.ts`.
3. **Update `workers/agents/src/script-engine/memory-os.ts`:**
   - Add `distillAndPersistLearnings` using `@cf/meta/llama-3.3-70b-instruct` and `@cf/baai/bge-small-en-v1.5`.
   - Add `retrieveGatedMemoriesForPrompt` enforcing the `BOT_SKILL` scope and 0.80 relevance filter.
   - Verify that thread initialization never imports or reads prior thread conversation transcripts.
4. **Syntax Check:** Run `node --check` across modified files to guarantee zero syntax or import errors.
```
