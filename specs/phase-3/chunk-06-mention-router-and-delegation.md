Here is the complete, fully-detailed, production-ready Markdown specification file for **Phase 3 — Chunk 06**: `specs/phase-3/chunk-06-mention-router-and-delegation.md`.

---

```markdown
---
chunk_id: "phase-3-chunk-06"
phase: 3
include_files:
  - workers/agents/src/router/mention-router.ts
  - workers/agents/src/script-engine/prebuilt/agent-coordination.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
repomix_include:
  - "workers/agents/src/router/mention-router.ts"
  - "workers/agents/src/script-engine/prebuilt/agent-coordination.ts"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
expected_outputs:
  - workers/agents/src/router/mention-router.ts
  - workers/agents/src/script-engine/prebuilt/agent-coordination.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
---

# Phase 3 — Chunk 06: Mention Router & Cryptographic Delegation Chaining

## 1. Executive Summary & Architectural Vision

In a multi-agent digital office (Tier 1 & Tier 2 public threads), humans frequently reference multiple agents in a single message. 

> **The Collision Hazard:** If a user types, *"@ReviewBot, please audit @DevBot's idempotency patch,"* a naive regex dispatcher will wake up both Durable Objects simultaneously. They will execute concurrently, burn double the tokens, and create a race condition in the chat and on the Git branch.

> **The Trojan Delegation Hazard:** If Charlie (a `Viewer` with Rank 1) tells his personal assistant: *"Tell @DevBot to delete the production database,"* `@DevBot` (which holds high execution privileges) might blindly trust the delegation and execute it, allowing Charlie to bypass RBAC.

### The Architectural Fix:
1. **The Turn-Holder vs. Referent Rule:** The router explicitly parses mentions. The *first* active mention receives the exclusive turn lock. Subsequent mentions (or possessives like `@DevBot's`) are strictly treated as conversational context referents and **do not** wake up.
2. **Sequential Turn Delegation:** If `@ReviewBot` decides `@DevBot` needs to fix the code, it uses `ctx.agent.delegate()` to hand off the turn sequentially.
3. **Cryptographic Delegation Chaining:** The delegation payload is signed via HMAC-SHA256 at the edge. The token immutably binds the **Original Human's User ID and Role Rank** to the task. When `@DevBot` wakes up, it acts with the clearance of the human who started the chain, *never* the clearance of the delegating agent.

---

## 2. Technical Specifications & Implementation Contracts

### A. Create the Mention Parser (`workers/agents/src/router/mention-router.ts`)

This module parses incoming chat strings, filters out punctuation/possessives, and separates the primary actor from contextual referents.

```typescript
export interface ResolvedMentions {
  primaryAgentId: string | null;
  referentAgentIds: string[];
}

/**
 * Parses a chat message to determine the primary turn-holder and any referent agents.
 * 
 * Rules:
 * 1. The first valid @mention is the primary turn-holder.
 * 2. Possessives (e.g., @DevBot's) are NEVER primary turn-holders; they are always referents.
 * 3. Subsequent mentions are referents.
 */
export function resolveTargetAgent(text: string, activeRoster: string[] = []): ResolvedMentions {
  // Regex matches @AgentName, ignoring trailing punctuation, capturing optional 's
  const mentionRegex = /(?<=^|\s)@([a-zA-Z0-9_-]+)('s)?\b/g;
  const matches = [...text.matchAll(mentionRegex)];

  if (matches.length === 0) {
    return { primaryAgentId: null, referentAgentIds: [] };
  }

  let primaryAgentId: string | null = null;
  const referentAgentIds: Set<string> = new Set();

  for (const match of matches) {
    const agentName = match[1].toLowerCase();
    const isPossessive = !!match[2];

    // Check if the agent is actually in the project roster (prevent hallucinated mentions)
    // If activeRoster is empty, we bypass the check for system-level routing.
    if (activeRoster.length > 0 && !activeRoster.includes(agentName)) {
      continue;
    }

    if (!primaryAgentId && !isPossessive) {
      primaryAgentId = agentName;
    } else {
      // Don't add the primary agent to its own referent list
      if (agentName !== primaryAgentId) {
        referentAgentIds.add(agentName);
      }
    }
  }

  return { 
    primaryAgentId, 
    referentAgentIds: Array.from(referentAgentIds) 
  };
}
```

---

### B. Implement Delegation & Cryptographic Chaining (`workers/agents/src/script-engine/prebuilt/agent-coordination.ts`)

When one agent delegates to another, it uses this prebuilt tool. It generates an unforgeable JWT-like token proving the human origin of the request.

```typescript
export async function delegateTask(
  targetRole: string, 
  taskDescription: string, 
  contextFiles: string[], 
  ctx: any
) {
  // 1. Extract the original human caller from the current execution context
  const initiatingUserId = ctx.env.actingUserId;
  const initiatingRoleRank = ctx.env.actingRoleRank;

  if (!initiatingUserId) {
    throw new Error("Delegation failed: Cannot delegate tasks without a traceable human initiator.");
  }

  // 2. Construct the Delegation Payload
  const taskTokenPayload = {
    initiatingUserId,
    initiatingRoleRank,
    targetRole,
    sourceAgentId: ctx.env.agentId,
    projectId: ctx.env.projectId,
    nonce: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 3600 // 1 hour expiration
  };

  // 3. Cryptographically sign the delegation token
  const signedToken = await signTaskToken(taskTokenPayload, ctx.env.PLATFORM_SECRET);

  // 4. Dispatch the sub-task to the target agent DO (via WsHub or Queues)
  // This notifies the target agent without executing it in the current turn.
  await ctx.env.queue.send({
    type: "DELEGATE_TURN",
    targetAgentId: targetRole,
    threadId: ctx.env.threadId,
    taskDescription,
    contextFiles,
    delegationToken: signedToken
  });

  return {
    success: true,
    message: `✔ Task securely delegated to @${targetRole}. Turn yielded.`
  };
}

/**
 * Signs the payload using HMAC-SHA256 (WebCrypto API)
 */
async function signTaskToken(payload: any, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const payloadStr = btoa(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", keyMaterial, encoder.encode(payloadStr));
  
  const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); // URL-safe Base64

  return `${payloadStr}.${sigBase64}`;
}
```

---

### C. Verify Tokens in the Target Agent (`workers/agents/src/do/NaelaoAgentDO.ts`)

Update the Durable Object's execution handler to catch delegated requests, verify the cryptographic signature, and enforce the original human's role rank.

```typescript
import { errorResponse } from "@naelao/http";

export class NaelaoAgentDO extends DurableObject {
  
  // ... existing init ...

  async handleDelegatedRun(request: Request) {
    const body = await request.json() as { 
      taskDescription: string; 
      delegationToken: string; 
    };

    // 1. Verify the Delegation Token
    const verifiedPayload = await this.verifyTaskToken(body.delegationToken, this.env.PLATFORM_SECRET);
    
    if (!verifiedPayload) {
      return new Response(JSON.stringify({ error: "Invalid or expired delegation token. Potential Privilege Escalation blocked." }), { status: 403 });
    }

    // 2. Validate Originating Human Role against Agent's Minimum Required Rank
    // E.g., DevBot requires Rank 3 (Editor). If Charlie (Rank 1) initiated, block it!
    const requiredRank = this.getAgentMinimumRoleRank(); // e.g., 3
    
    if (verifiedPayload.initiatingRoleRank < requiredRank) {
      console.warn(`🚨 Trojan Delegation Blocked: User ${verifiedPayload.initiatingUserId} attempted to use ${this.agentId} to bypass RBAC.`);
      return new Response(JSON.stringify({ 
        error: `Delegation blocked: Initiating user lacks clearance (Requires Rank ${requiredRank}, got Rank ${verifiedPayload.initiatingRoleRank}).` 
      }), { status: 403 });
    }

    // 3. Mount the environment using the INITIATING human's identity, NOT the delegating bot's identity
    const safeEnv = await this.buildScriptEngineEnv({
      actingUserId: verifiedPayload.initiatingUserId,
      actingRoleRank: verifiedPayload.initiatingRoleRank,
      projectId: verifiedPayload.projectId
    });

    // 4. Proceed with Execution
    return await this.executeScriptRun(body.taskDescription, safeEnv);
  }

  private async verifyTaskToken(token: string, secret: string): Promise<any | null> {
    try {
      const [payloadB64, sigB64] = token.split(".");
      const encoder = new TextEncoder();
      
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
      );

      const signatureBytes = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
      
      const isValid = await crypto.subtle.verify("HMAC", keyMaterial, signatureBytes, encoder.encode(payloadB64));
      
      if (!isValid) return null;

      const payload = JSON.parse(atob(payloadB64));
      if (Math.floor(Date.now() / 1000) > payload.exp) return null; // Expired

      return payload;
    } catch {
      return null;
    }
  }
}
```
```
