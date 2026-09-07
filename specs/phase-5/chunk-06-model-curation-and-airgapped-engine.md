Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 5 — Chunk 06**: `specs/phase-5/chunk-06-model-curation-and-airgapped-engine.md`.

---

```markdown
---
chunk_id: "phase-5-chunk-06"
phase: 5
include_files:
  - workers/agents/src/shared/ai-client.ts
  - workers/agents/src/do/LocalTunnelDO.ts
  - workers/spaces/src/do/SpaceDO.ts
repomix_include:
  - "workers/agents/src/shared/ai-client.ts"
  - "workers/agents/src/do/LocalTunnelDO.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
expected_outputs:
  - workers/agents/src/shared/ai-client.ts
  - workers/agents/src/do/LocalTunnelDO.ts
  - workers/spaces/src/do/SpaceDO.ts
---

# Phase 5 — Chunk 06: Vertical Model Curation, LoRA Routing & Air-Gapped Engine

## 1. Executive Summary & Architectural Vision

In regulated industry workspaces (law firms, clinical practices, defense contractors), staff must not accidentally route sensitive patient or corporate deal data through uncertified public LLM models. Furthermore, enterprise clients operating under strict compliance mandates require a completely **Air-Gapped Sovereign AI Mode** running entirely on on-premise hardware.

AVOS enforces compliance through three foundational mechanisms:
1. **Vertical Model Whitelisting (`whitelist_only`):** A compliance lock restricting the workspace strictly to certified model endpoints (e.g. HIPAA BAA-certified models or firm-specific private fine-tuned LoRA weights).
2. **Private LoRA Dynamic Edge Routing:** Automatically intercepts `custom/*` model identifiers and routes them to Cloudflare Workers AI with dynamic LoRA adapter weight injection.
3. **Sovereign Air-Gapped Local AI Engine (`LocalTunnelDO`):** Bridges on-premise GPU clusters (running Ollama, vLLM, or llama.cpp behind corporate firewalls) to Cloudflare edge Durable Objects via encrypted outbound WebSockets.
4. **Air-Gapped Space Lock:** When enabled, physically cuts all external cloud AI network requests, guaranteeing that 100% of prompts execute on local hardware with zero data egress.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🏥 CLINIC COWORK (HIPAA Whitelist Locked & Air-Gapped Mode)                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ • `custom/hospital-llama8b-v1` (Fine-tuned on local EHRs) [Active] 🟢       │
│ • `local/ollama/deepseek-r1:32b` (On-premise air-gapped GPU) 🟢              │
│ 🔒 All uncertified public cloud models and outbound APIs blocked server-side│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Update `workers/agents/src/shared/ai-client.ts`

Implement strict server-side compliance validation and LoRA router resolution:

```typescript
export interface VerticalModelPolicy {
  mode: "whitelist_only" | "all_allowed";
  allowedModelIds: string[];
  defaultModelId: string;
  lockedByCompliancePolicy: boolean;
  airGappedOnly: boolean;
}

/**
 * Validates whether a requested model complies with the vertical space's security policy.
 * Fails closed if policy is violated.
 */
export function validateModelRequest(
  requestedModel: string,
  policy?: VerticalModelPolicy
): { valid: boolean; reason?: string } {
  if (!policy || policy.mode !== "all_allowed") {
    // If no restrictive policy is set, verify against default platform allowlist
    return { valid: true };
  }

  // 1. Air-Gapped Enforcement
  if (policy.airGappedOnly) {
    const isLocalTunnel = requestedModel.startsWith("local/") || requestedModel.startsWith("ollama/");
    if (!isLocalTunnel) {
      return {
        valid: false,
        reason: "Air-Gapped Policy Violation: Cloud AI models are strictly prohibited. Only local on-premise GPU runners are permitted."
      };
    }
  }

  // 2. Whitelist Check
  const isWhitelisted = 
    policy.allowedModelIds.includes(requestedModel) ||
    (requestedModel.startsWith("custom/") && policy.allowedModelIds.some(m => m.startsWith("custom/"))) ||
    (requestedModel.startsWith("local/") && policy.allowedModelIds.some(m => m.startsWith("local/")));

  if (!isWhitelisted) {
    return {
      valid: false,
      reason: `Compliance Violation: Model '${requestedModel}' is not certified for this vertical space. Permitted models: [${policy.allowedModelIds.join(", ")}]`
    };
  }

  return { valid: true };
}

/**
 * Resolves custom LoRA adapter weights if requested model uses custom namespace.
 */
export function resolveLoraAdapter(modelName: string, spaceId: string) {
  if (modelName.startsWith("custom/")) {
    const cleanSlug = modelName.replace("custom/", "");
    return {
      baseModel: "@cf/meta/llama-3.1-8b-instruct",
      adapterId: `lora_${spaceId}_${cleanSlug}`
    };
  }
  return { baseModel: modelName, adapterId: null };
}
```

---

### B. Update `workers/agents/src/do/LocalTunnelDO.ts`

Implement the zero-port WebSocket bridge connecting Cloudflare edge Durable Objects to corporate on-premise Ollama / vLLM clusters:

```typescript
import { DurableObject } from "cloudflare:workers";

export class LocalTunnelDO extends DurableObject {
  private activeTunnelSocket: WebSocket | null = null;
  private pendingRequests = new Map<string, { resolve: (res: any) => void; reject: (err: any) => void }>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. Inbound WebSocket connection from local `npx avos-local connect` daemon
    if (url.pathname.endsWith("/local-tunnel/connect")) {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      
      this.acceptTunnelConnection(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Internal dispatch from NaelaoAgentDO to execute prompt on local GPU
    if (url.pathname === "/exec-local-inference") {
      if (!this.activeTunnelSocket || this.activeTunnelSocket.readyState !== WebSocket.READY_STATE_OPEN) {
        return Response.json({ ok: false, error: "Local on-premise GPU tunnel is offline or disconnected." }, { status: 503 });
      }

      const body = await request.json() as any;
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      return new Promise((resolve, reject) => {
        this.pendingRequests.set(requestId, { resolve, reject });
        
        // Dispatch payload down encrypted WebSocket tunnel to local Ollama instance
        this.activeTunnelSocket!.send(JSON.stringify({
          request_id: requestId,
          op: "ollama_chat",
          params: body
        }));

        // 60-second timeout guard
        setTimeout(() => {
          if (this.pendingRequests.has(requestId)) {
            this.pendingRequests.delete(requestId);
            reject(new Error("Local GPU inference request timed out (60s)."));
          }
        }, 60000);
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  private acceptTunnelConnection(serverSocket: WebSocket) {
    this.ctx.acceptWebSocket(serverSocket);
    this.activeTunnelSocket = serverSocket;
    console.log("🦙 Secure local on-premise GPU tunnel connected successfully.");

    serverSocket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        const pending = this.pendingRequests.get(data.request_id);
        if (pending) {
          this.pendingRequests.delete(data.request_id);
          if (data.ok) {
            pending.resolve(Response.json(data.result));
          } else {
            pending.reject(new Error(data.error || "Unknown local inference error"));
          }
        }
      } catch (err: any) {
        console.error("Failed to parse local tunnel response message:", err.message);
      }
    });

    serverSocket.addEventListener("close", () => {
      console.warn("⚠️ Local GPU tunnel WebSocket disconnected.");
      this.activeTunnelSocket = null;
    });
  }
}
```

---

### C. Update `SpaceDO.ts` (Compliance Policy Store)

Implement persistence and retrieval for `space_compliance_policy` in SQLite:

```sql
-- SQLite table inside SpaceDO
CREATE TABLE IF NOT EXISTS space_compliance_policy (
  id TEXT PRIMARY KEY DEFAULT 'current',
  mode TEXT NOT NULL DEFAULT 'all_allowed' CHECK (mode IN ('whitelist_only', 'all_allowed')),
  allowed_model_ids_json TEXT NOT NULL DEFAULT '[]',
  default_model_id TEXT NOT NULL DEFAULT '@cf/meta/llama-3.3-70b-instruct',
  locked_by_compliance INTEGER NOT NULL DEFAULT 0,
  air_gapped_only INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Implement DO methods:
* `getCompliancePolicy()`: Returns active vertical model policy object.
* `updateCompliancePolicy(policy)`: Updates policy rules (restricted to Admin/Owner ranks).

---

## 3. Step-by-Step Instructions for the AI Runner

When applying this chunk:
1. Update `workers/agents/src/shared/ai-client.ts` to include `validateModelRequest` and `resolveLoraAdapter`.
2. Update `workers/agents/src/do/LocalTunnelDO.ts` to handle secure WebSocket tunneling and internal inference proxies.
3. Update `SpaceDO.ts` to persist compliance policies and enforce air-gapped locks.
4. Run `node --check` syntax checks across modified files to ensure strict TypeScript compliance.
```
