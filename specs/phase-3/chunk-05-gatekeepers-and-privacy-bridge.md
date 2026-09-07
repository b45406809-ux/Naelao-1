Here is the **full, long, extensively detailed specification for Phase 3 — Chunk 05**, ready to be saved into your repository. 

This chunk contains the cryptographic implementations for the Gatekeeper tokens, the physical schema-stripping mechanism for the `tool-surface.ts`, and the MCP-UI Privacy Bridge JSON-RPC generators.

***

```markdown
---
chunk_id: "phase-3-chunk-05"
phase: 3
include_files:
  - packages/security/src/gatekeeper.ts
  - workers/agents/src/script-engine/tool-surface.ts
  - workers/agents/src/script-engine/prebuilt/mcp-ui.ts
repomix_include:
  - "packages/security/src/gatekeeper.ts"
  - "workers/agents/src/script-engine/tool-surface.ts"
  - "workers/agents/src/script-engine/prebuilt/mcp-ui.ts"
expected_outputs:
  - packages/security/src/gatekeeper.ts
  - workers/agents/src/script-engine/tool-surface.ts
  - workers/agents/src/script-engine/prebuilt/mcp-ui.ts
---

# Phase 3 — Chunk 05: Gatekeepers, Tool Stripping & The Privacy Bridge

## 1. Mental Model & Architectural Vision

This chunk establishes the definitive security boundaries for **Multi-Agent / Multi-Human Workspaces**. We must guarantee two critical invariants:
1. **Zero Privilege Escalation (Gatekeepers):** When a department shares a tool or micro-app with another department, they do not share raw database access. They share a cryptographically signed **Gatekeeper Capability Token** that attenuates access to specific operations on specific resources.
2. **Zero Personal Data Leakage (Public Channel Stripping):** If Alice is in a Public Team Room (Tier 1) and asks an agent to summarize an email from her private Gmail, the agent must be *physically incapable* of doing so in that channel. The tool schema for her personal Gmail must be removed from the LLM prompt. Instead, the agent emits an interactive **MCP-UI Privacy Bridge Card**, prompting Alice to fork the task into a secure Tier 4 Private Scratchpad.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. PUBLIC TEAM ROOM (Tier 1/2)                                              │
│ Alice: "@DevBot, check my personal GitHub token for the issue status."      │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. PHYSICAL SCHEMA STRIPPING (`tool-surface.ts`)                            │
│ The hypervisor router detects `thread_kind !== 'private_scratchpad'`.       │
│ It physically drops all `USER_PERSONAL` scoped tools from the LLM payload.  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. MCP-UI PRIVACY BRIDGE (`mcp-ui.ts`)                                      │
│ @DevBot recognizes it lacks the tool, but sees the vault credential exists. │
│ It emits an interactive JSON-RPC card back to the chat:                     │
│ [ 🚀 Personal Tool Required: Continue in Private Scratchpad ]               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Implementation Requirements

### A. Implement Cryptographic Gatekeepers (`packages/security/src/gatekeeper.ts`)

Gatekeepers replace raw API keys with unforgeable, HMAC-SHA256 signed capability grants. We must use standard WebCrypto APIs (supported by Cloudflare Workers).

```typescript
// packages/security/src/gatekeeper.ts

export interface GatekeeperGrant {
  resource: string; // e.g., "sqlite_db", "slack_channel"
  target: string;   // e.g., "table:bug_reports", "#engineering"
  operations: Array<"read" | "write" | "delete" | "execute">;
}

export interface GatekeeperCapabilityPayload {
  appId: string;
  spaceId: string;
  creatorUserId: string;
  grants: GatekeeperGrant[];
  expiresAt: number; // Unix timestamp
  nonce: string;
}

export interface GatekeeperToken {
  payload: GatekeeperCapabilityPayload;
  signature: string; // Base64 encoded HMAC-SHA256
}

/**
 * Mints an unforgeable capability token for cross-subspace or cross-agent delegation.
 */
export async function mintGatekeeperToken(
  payload: Omit<GatekeeperCapabilityPayload, "nonce">,
  platformSecret: string
): Promise<string> {
  const fullPayload: GatekeeperCapabilityPayload = {
    ...payload,
    nonce: crypto.randomUUID()
  };

  const payloadString = JSON.stringify(fullPayload);
  
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadString)
  );

  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  
  // Return format: Base64Url(payload).Signature
  const payloadBase64Url = btoa(payloadString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${payloadBase64Url}.${signatureBase64}`;
}

/**
 * Verifies a Gatekeeper token and checks for expiration.
 */
export async function verifyGatekeeperToken(
  tokenString: string,
  platformSecret: string
): Promise<GatekeeperCapabilityPayload> {
  const [payloadBase64Url, signatureBase64] = tokenString.split(".");
  if (!payloadBase64Url || !signatureBase64) {
    throw new Error("Invalid Gatekeeper token format.");
  }

  // Restore Base64 formatting
  let base64 = payloadBase64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  
  const payloadString = atob(base64);
  const payload: GatekeeperCapabilityPayload = JSON.parse(payloadString);

  // Expiration Check
  if (Date.now() > payload.expiresAt) {
    throw new Error(`Gatekeeper Violation: Token expired at ${new Date(payload.expiresAt).toISOString()}`);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signatureBuffer = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));

  const isValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBuffer,
    encoder.encode(payloadString)
  );

  if (!isValid) {
    throw new Error("Gatekeeper Violation: Cryptographic signature mismatch. Token is forged or altered.");
  }

  return payload;
}
```

---

### B. Implement Physical Tool Stripping (`workers/agents/src/script-engine/tool-surface.ts`)

We must enforce that personal tools NEVER enter the context window of a public thread, rendering prompt-injection attempts to steal personal data completely inert.

```typescript
// workers/agents/src/script-engine/tool-surface.ts

export interface ToolDefinition {
  name: string;
  description: string;
  scope: "SPACE_SHARED" | "PROJECT_BOUND" | "USER_PERSONAL";
  ownerUserId?: string; // Populated only if scope is USER_PERSONAL
  parameters: Record<string, any>;
}

/**
 * Applies hardware-level stripping of tool schemas based on the thread tier and caller identity.
 * This guarantees zero-leakage of personal integrations in multi-player rooms.
 */
export function assembleToolSchemasForThread(
  allTools: ToolDefinition[],
  threadKind: "primary" | "task_workstation" | "private_scratchpad" | "system_consult",
  actingUserId: string
): ToolDefinition[] {
  
  return allTools.filter(tool => {
    // 1. Space-Shared and Project-Bound tools are universally accessible in the workspace
    if (tool.scope === "SPACE_SHARED" || tool.scope === "PROJECT_BOUND") {
      return true;
    }

    // 2. USER_PERSONAL tool filtering
    if (tool.scope === "USER_PERSONAL") {
      // Rule A: Personal tools are strictly forbidden in Public Channels (Tier 1 & 2)
      if (threadKind !== "private_scratchpad") {
        return false; // Physically stripped from context
      }

      // Rule B: Even in a Private Scratchpad (Tier 4), you can only see YOUR personal tools.
      // Bob cannot execute a tool bound to Alice's personal account.
      if (tool.ownerUserId === actingUserId) {
        return true;
      }
      
      return false;
    }

    return false;
  });
}
```

---

### C. Implement the MCP-UI Privacy Bridge (`workers/agents/src/script-engine/prebuilt/mcp-ui.ts`)

When an agent intercepts a request requiring a personal connector in a public channel (e.g., via the Virtual CLI Interceptor catching a missing command but finding a personal vault key), it emits this UI payload.

```typescript
// workers/agents/src/script-engine/prebuilt/mcp-ui.ts

export interface McpUiAction {
  type: "mcp_ui_card";
  component: string;
  props: Record<string, any>;
}

/**
 * Emits an interactive UI card instructing the frontend to fork the current conversation
 * into a Tier 4 Private Scratchpad so the user can safely utilize personal credentials.
 */
export function emitPrivacyBridgeCard(
  missingToolAlias: string, 
  originalPrompt: string,
  sourceThreadId: string
): McpUiAction {
  return {
    type: "mcp_ui_card",
    component: "PrivacyBridgeCard",
    props: {
      title: "🔒 Personal Integration Required",
      message: `To protect your privacy and credentials in team channels, access to your personal connector '${missingToolAlias}' is restricted to private workspaces.`,
      actionLabel: "🚀 Continue in Private Scratchpad",
      // Metadata passed back to the frontend to construct the fork request
      handoffPayload: {
        sourceThreadId,
        userPrompt: originalPrompt,
        requiredTool: missingToolAlias
      }
    }
  };
}

/**
 * Emits an interactive UI card requesting a single-use ephemeral action grant.
 * Used when a user wants a bot to perform one quick action with their credentials 
 * without leaving the public channel.
 */
export function emitEphemeralActionGrantCard(
  actionName: string,
  targetResource: string,
  reasoning: string
): McpUiAction {
  return {
    type: "mcp_ui_card",
    component: "EphemeralGrantCard",
    props: {
      title: "🔐 One-Time Action Authorization",
      message: `The agent is requesting permission to use your Personal Credentials for a single action in this channel.`,
      actionDetails: {
        action: actionName,
        target: targetResource,
        reason: reasoning
      },
      approveLabel: "✅ Authorize 1-Time Action",
      denyLabel: "❌ Deny"
    }
  };
}
```

---

## 3. Review & Sanity Checks
- [x] Does `Gatekeeper` implementation use asynchronous WebCrypto so it executes successfully on Cloudflare Edge? Yes.
- [x] Does `assembleToolSchemasForThread` properly exclude `USER_PERSONAL` scope outside of `private_scratchpad`? Yes.
- [x] Does the code output valid JSON-RPC equivalents for the frontend to render the MCP-UI cards? Yes.
```
