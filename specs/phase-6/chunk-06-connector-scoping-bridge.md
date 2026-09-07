This is the detailed specification for **Phase 6 — Chunk 06: 3-Tier Connector Scoping Bridge**.

This chunk is critical because it builds the **Credential Security Firewall**. It ensures that an agent never accidentally uses a founder's personal Gmail to reply to a public customer, and it prevents unauthorized users from "borrowing" the company's Stripe credentials through an agent.

---

### `specs/phase-6/chunk-06-connector-scoping-bridge.md`

```markdown
---
chunk_id: "phase-6-chunk-06"
phase: 6
include_files:
  - workers/credentials/src/index.ts
  - workers/agents/src/script-engine/tool-surface.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
  - packages/security/src/gatekeeper.ts
repomix_include:
  - "workers/credentials/src/index.ts"
  - "workers/agents/src/script-engine/tool-surface.ts"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "packages/security/src/gatekeeper.ts"
expected_outputs:
  - workers/credentials/src/index.ts
  - workers/agents/src/script-engine/tool-surface.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
---

# Phase 6 — Chunk 06: 3-Tier Connector Scoping Bridge

## 1. Mental Model & Architectural Vision

In a multi-user enterprise environment, agents interact with external APIs (Gmail, Stripe, GitHub) using credentials that belong to different organizational tiers. To prevent **Privilege Escalation** and **Identity Hijacking**, AVOS implements a **3-Tier Connector Scope Model**.

### The 3 Connector Tiers:
1.  **🏢 Tier 1: Space-Shared (Company Level)**
    *   *Owner:* The Organization (e.g., the official `support@firm.com` Gmail).
    *   *Access:* Any authorized agent in any project within the space.
2.  **📁 Tier 2: Project-Bound (Project Level)**
    *   *Owner:* A specific Project (e.g., the WhatsApp number for the `customer_bot` project).
    *   *Access:* Only agents and threads executing within that specific project.
3.  **👤 Tier 3: User-Personal (Individual Level)**
    *   *Owner:* An individual user (e.g., Alice's private `alice@gmail.com`).
    *   *Access:* **STRICTLY RESTRICTED** to private Tier 4 Scratchpad threads where Alice is the sole human.

```
                                  ┌──────────────────────────────────────────────┐
                                  │         CREDENTIAL RESOLUTION ENGINE         │
                                  └──────────────────────┬───────────────────────┘
                                                         │
         ┌───────────────────────────────────────────────┼───────────────────────────────────────────────┐
         ▼                                               ▼                                               ▼
┌─────────────────────────────────┐             ┌─────────────────────────────────┐             ┌─────────────────────────────────┐
│ 🏢 1. SPACE-SHARED              │             │ 📁 2. PROJECT-BOUND             │             │ 👤 3. USER-PERSONAL             │
├─────────────────────────────────┤             ├─────────────────────────────────┤             ├─────────────────────────────────┤
│ Matches `space_id` only.        │             │ Matches `space_id` + `project_id`.│             │ Matches `space_id` + `user_id`. │
│ Global company tools.           │             │ Scoped to a single project.     │             │ Private user-only tools.        │
└─────────────────────────────────┘             └─────────────────────────────────┘             └─────────────────────────────────┘
```

---

## 2. Implementation Requirements

### A. Update Credentials Worker (`workers/credentials/src/index.ts`)
Implement the hierarchical resolution logic. When an agent requests a credential for a tool (e.g., `gmail.send`), the worker must find the most specific credential available to that caller.

```typescript
// Resolution logic inside Credentials Worker
export async function resolveCredential(params: {
  spaceId: string;
  name: string;
  actingUserId?: string;
  projectId?: string;
}) {
  const { spaceId, name, actingUserId, projectId } = params;

  // 1. Check Tier 3: User-Personal (Highest Priority)
  if (actingUserId) {
    const personal = await db.query(
      "SELECT * FROM space_credentials WHERE space_id = ? AND name = ? AND user_id = ? AND scope = 'user'",
      [spaceId, name, actingUserId]
    );
    if (personal) return decrypt(personal.value);
  }

  // 2. Check Tier 2: Project-Bound
  if (projectId) {
    const projectBound = await db.query(
      "SELECT * FROM space_credentials WHERE space_id = ? AND name = ? AND project_id = ? AND scope = 'project'",
      [spaceId, name, projectId]
    );
    if (projectBound) return decrypt(projectBound.value);
  }

  // 3. Check Tier 1: Space-Shared (Fallback)
  const shared = await db.query(
    "SELECT * FROM space_credentials WHERE space_id = ? AND name = ? AND scope = 'space'",
    [spaceId, name]
  );
  return shared ? decrypt(shared.value) : null;
}
```

---

### B. Update Agent Tool Surface (`workers/agents/src/script-engine/tool-surface.ts`)
Implement **Physical Tool Schema Stripping**. If an agent is executing in a **Public Team Channel** (Tier 1 or 2), the runtime must physically remove Tier 3 (User-Personal) tools from the prompt so the LLM cannot even attempt to use them.

```typescript
export function filterToolsByThreadScope(
  allTools: Tool[], 
  threadKind: ThreadKind, 
  actingUserId: string
) {
  if (threadKind !== "private_scratchpad") {
    // PUBLIC ROOM: Physically strip all tools marked as USER_PERSONAL
    return allTools.filter(tool => tool.scope !== "USER_PERSONAL");
  }
  
  // PRIVATE SCRATCHPAD: Only Alice's personal tools are allowed
  return allTools.filter(tool => 
    tool.scope !== "USER_PERSONAL" || tool.ownerUserId === actingUserId
  );
}
```

---

### C. Update `NaelaoAgentDO.ts`
When the agent loop starts, it must identify the "Invoker" (the human user who sent the message). Every tool call dispatched to the `mcp-hub` must be signed with this `actingUserId` so the Credentials worker can enforce Tier 3 isolation.

---

## 3. The Privacy Forking Bridge (UI Interaction)

If a user in a **Public Team Room** asks: *"@DevBot, check my personal Gmail for the Acme NDA"*, the agent must respond with an interactive **MCP-UI card** instead of failing:

1.  **Detection:** Agent sees `gmail.search` in `steps_so_far` but the tool is missing from its schema.
2.  **Elicitation:** Agent emits an interactive card via `ctx.mcp.emitUiAction`.
3.  **UI Component:** `InlinePrivacyBridge.tsx` renders in the chat:
    > *"🔒 **Personal Integration Required.** To protect your privacy, @DevBot cannot access your personal Gmail in this public channel. [ 🚀 Continue in Private Scratchpad ]"*
4.  **Action:** Clicking the button forks the current thread state into a new **Tier 4 Private Scratchpad** where the personal connector is active.

---

## 4. Implementation Instructions for the AI Runner

1.  **Database Update:** Ensure the `space_credentials` table has `scope` (`user`, `project`, `space`) and `project_id` columns.
2.  **Worker Resolution:** Implement the `resolveCredential` hierarchy in the credentials worker.
3.  **Agent Logic:**
    *   Update `buildScriptEngineEnv` in `NaelaoAgentDO.ts` to capture and pass `actingUserId`.
    *   Update `ToolSurface` to run `filterToolsByThreadScope` before every LLM turn.
4.  **Security Gate:** Add a check in `mcp-hub` to ensure that if a tool is called on behalf of `user_A`, it cannot access `user_B`'s credentials even if the `space_id` matches.
```

---

### Sync Note for `run-phase.mjs`

Ensure you have added the credentials worker to the includes for this chunk:

```javascript
  "chunk-06-connector-scoping-bridge": [
    "workers/credentials/src/index.ts",
    "workers/agents/src/script-engine/tool-surface.ts",
    "workers/agents/src/do/NaelaoAgentDO.ts",
    "packages/security/src/gatekeeper.ts"
  ],
```

