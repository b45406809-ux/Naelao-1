Here is the complete, deeply detailed, production-ready Markdown specification for **Phase 3 — Chunk 10**. 

This file implements the cryptographic logic for 15-second Ephemeral Action Grants and the resilient "Silent Auth Rot" recovery loop for background dynamic workflows.

***

```markdown
---
chunk_id: "phase-3-chunk-10"
phase: 3
include_files:
  - workers/credentials/src/index.ts
  - workers/agents/src/script-engine/prebuilt/mcp-ui.ts
  - packages/security/src/crypto.ts
repomix_include:
  - "workers/credentials/src/index.ts"
  - "workers/agents/src/script-engine/prebuilt/mcp-ui.ts"
  - "packages/security/src/crypto.ts"
expected_outputs:
  - workers/credentials/src/index.ts
  - workers/agents/src/script-engine/prebuilt/mcp-ui.ts
---

# Phase 3 — Chunk 10: Ephemeral Grants & Proactive Auth Refresh

## 1. Mental Model & Architectural Vision

This chunk solves two distinct security and reliability hazards at the edge:

### A. The "Silent Auth Rot" Hazard (Background Task Resiliency)
**The Problem:** OAuth tokens (like Google Workspace, Shopify, or GitHub) typically expire after 1 hour. If a Tier 3 Dynamic Workflow wakes up at 2:00 AM on a cron schedule, the access token stored in the `space_credentials` vault will likely be expired. If the outbound `fetch` fails with a `401 Unauthorized`, the workflow crashes, and the business automation fails.
**The Solution:** The Outbound Worker acts as an intelligent proxy. When `ctx.vault.fetchWithAuth()` encounters a `401`, it intercepts the failure, pulls the `refresh_token` from the vault, negotiates a fresh `access_token` from the provider (or Composio broker), saves the new token to the database, and **transparently retries the original HTTP request**. The agent script never even knows the token expired.

### B. The Ephemeral Action Grant (Public Channel Privacy)
**The Problem:** In a Tier 1 Public Team Room, personal tools (like Alice's Private Gmail) are stripped from the LLM. But what if Alice just wants to say, *"@DevBot, create a GitHub issue for this bug on my behalf"*? Forcing her to leave the chat to open a Tier 4 Private Scratchpad for a 2-second command is terrible UX.
**The Solution:** The agent uses **MCP v2 Elicitation**. It pauses and emits an interactive UI card visible *only* to Alice. When Alice taps **[ ✅ Authorize 1-Time Action ]**, the UI mints a cryptographic **Ephemeral Grant Token** with a strict **15-second TTL**. The agent resumes, passes the token to the Credentials Worker, which validates the 15-second window, decrypts the personal key for exactly one outbound request, and completes the task. Bob never sees the key, and the agent loses access 15 seconds later.

---

## 2. Implementation Requirements

### A. Ephemeral Token Cryptography (`packages/security/src/crypto.ts`)

First, ensure we have the cryptographic primitives to mint and verify short-lived HMAC tokens.

```typescript
// packages/security/src/crypto.ts

/**
 * Mints an unforgeable, time-bound ephemeral grant token.
 */
export async function mintEphemeralGrant(
  userId: string,
  spaceId: string,
  credentialName: string,
  actionName: string,
  platformSecret: string
): Promise<string> {
  const payload = {
    sub: userId,
    spc: spaceId,
    crd: credentialName,
    act: actionName,
    iat: Date.now()
  };
  
  const dataString = JSON.stringify(payload);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(dataString));
  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  return `${btoa(dataString)}.${signatureBase64}`;
}

/**
 * Verifies the ephemeral grant and enforces the 15-second (15000ms) Time-To-Live.
 */
export async function verifyEphemeralGrant(
  token: string, 
  platformSecret: string
): Promise<{ valid: boolean; payload?: any; reason?: string }> {
  try {
    const [encodedPayload, signatureBase64] = token.split(".");
    if (!encodedPayload || !signatureBase64) return { valid: false, reason: "Malformed token" };

    const payload = JSON.parse(atob(encodedPayload));
    
    // 1. Check TTL: Reject if older than 15,000 milliseconds (15 seconds)
    const now = Date.now();
    if (now - payload.iat > 15000) {
      return { valid: false, reason: "Ephemeral grant expired (TTL > 15s)." };
    }

    // 2. Verify Cryptographic Signature
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(platformSecret),
      { name: "HMAC", hash: "SHA-256" },
      false, ["verify"]
    );
    
    const signatureBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(atob(encodedPayload)));

    if (!isValid) return { valid: false, reason: "Invalid HMAC signature" };

    return { valid: true, payload };
  } catch (err) {
    return { valid: false, reason: "Cryptographic verification failed" };
  }
}
```

---

### B. Egress Proxy & Silent Auth Rot (`workers/credentials/src/index.ts`)

Update the Credentials Worker to handle both the `fetchWithAuth` retry logic and the Ephemeral Token bypass.

```typescript
// workers/credentials/src/index.ts
import { verifyEphemeralGrant } from "@naelao/security";

/**
 * Core outbound proxy method.
 * Injects secrets at the edge and handles silent OAuth refresh if a 401 occurs.
 */
export async function executeOutboundWithRefresh(
  url: string, 
  opts: any, 
  credentialRecord: any, 
  env: any
): Promise<Response> {
  const headers = new Headers(opts.headers || {});
  headers.set("Authorization", `Bearer ${credentialRecord.accessToken}`);

  let response = await fetch(url, { ...opts, headers });

  // 1. Silent Auth Rot Recovery
  if (response.status === 401 && credentialRecord.refreshToken) {
    console.warn(`[Vault] 401 Unauthorized caught for ${credentialRecord.name}. Attempting proactive refresh...`);
    
    try {
      // Execute provider-specific refresh (or hit Composio broker)
      const newTokens = await refreshOAuthToken(credentialRecord.provider, credentialRecord.refreshToken, env);
      
      // Update the vault securely
      await updateVaultCredential(credentialRecord.id, newTokens, env);
      
      // Retry the original request transparently
      headers.set("Authorization", `Bearer ${newTokens.accessToken}`);
      response = await fetch(url, { ...opts, headers });
      
      console.log(`[Vault] Successfully refreshed token and retried request for ${credentialRecord.name}.`);
    } catch (refreshErr) {
      console.error(`[Vault] Token refresh failed for ${credentialRecord.name}:`, refreshErr);
      // Fall through and return the original 401 if refresh fails
    }
  }

  return response;
}

/**
 * Gates access to credentials. Supports standard resolution AND 15-second ephemeral grants.
 */
export async function authorizeConnectorCall(
  requestedConnectorId: string,
  botConfig: any,
  callingUserId: string,
  ephemeralGrantToken?: string
) {
  const connector = await fetchConnector(requestedConnectorId);

  // If Space-Shared or Bot-Owned, authorize immediately
  if (connector.scope === "SPACE_SHARED" || connector.boundBotId === botConfig.id) {
    return { authorized: true, credential: decrypt(connector.encryptedKey) };
  }

  // User-Personal Scope
  if (connector.scope === "USER_PERSONAL") {
    // Standard Path: Caller is the owner
    if (callingUserId === connector.ownerUserId) {
      return { authorized: true, credential: decrypt(connector.encryptedKey) };
    }

    // Ephemeral Path: Agent is acting on behalf of the owner via a 15-second UI grant
    if (ephemeralGrantToken) {
      const grant = await verifyEphemeralGrant(ephemeralGrantToken, process.env.PLATFORM_SECRET);
      if (grant.valid && grant.payload.crd === requestedConnectorId && grant.payload.sub === connector.ownerUserId) {
        console.log(`[Vault] Ephemeral grant accepted for ${connector.ownerName}'s personal credential.`);
        return { authorized: true, credential: decrypt(connector.encryptedKey) };
      } else {
        throw new Error(`Invalid or expired ephemeral grant: ${grant.reason}`);
      }
    }

    // Blocked
    throw new Error(`Security Violation: User '${callingUserId}' cannot invoke actions using ${connector.ownerName}'s personal connection without an ephemeral grant.`);
  }

  throw new Error("Unauthorized connector access.");
}
```

---

### C. MCP-UI Elicitation Card (`workers/agents/src/script-engine/prebuilt/mcp-ui.ts`)

When the agent intercepts a `Security Violation` because it needs a personal credential in a public channel, it yields its run and emits this UI card.

```typescript
// workers/agents/src/script-engine/prebuilt/mcp-ui.ts

export interface McpUiCard {
  type: "mcp_ui_card";
  component: string;
  props: Record<string, any>;
}

/**
 * Emits an interactive card requesting a 15-second ephemeral grant from the credential owner.
 * Only the owner specified in `ownerUserId` will see the 'Authorize' button in the frontend.
 */
export function emitEphemeralGrantCard(
  actionName: string, 
  credentialName: string, 
  ownerUserId: string
): McpUiCard {
  return {
    type: "mcp_ui_card",
    component: "EphemeralGrantCard",
    props: {
      ownerUserId: ownerUserId,
      credentialName: credentialName,
      actionName: actionName,
      title: "🔒 Personal Integration Required",
      message: `The agent is requesting 1-time permission to use your Personal ${credentialName} to perform: ${actionName}.`,
      actionLabel: "Authorize 1-Time Action (15s Window)",
      fallbackLabel: "Continue in Private Scratchpad"
    }
  };
}
```

---

## 3. Workflow Implementation Steps for GitHub Actions

When running this chunk via the mobile Actions runner:
1. Ensure the `crypto.ts` functions are implemented using WebCrypto API (standard in Cloudflare Workers).
2. Verify that `fetchWithAuth` in `CodeRunner` correctly wraps the `executeOutboundWithRefresh` method.
3. Ensure typecheck passes for the `McpUiCard` interface, as it will be relied upon by the frontend `Chat.tsx` component in Phase 8.
```
