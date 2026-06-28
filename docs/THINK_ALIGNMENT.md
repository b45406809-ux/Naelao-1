# Project Think alignment — Whop Businesses agent

Cloudflare **Project Think** (`@cloudflare/think`) is the durable agent runtime we
target: an opinionated base class that wires together Durable Objects, a message
tree, durable fibers, skills, sandboxed code execution, and sub-agents. Our
`BusinessDO` already follows this architecture; this note maps the two and records
the drop-in path so we adopt Think rather than re-deriving its machinery.

> Source: https://blog.cloudflare.com/project-think/ ·
> https://developers.cloudflare.com/agents/harnesses/think/ ·
> https://github.com/cloudflare/agents

## Mapping

| Project Think | Our implementation (today) | Notes |
|---|---|---|
| `Think<Env>` base class (a Durable Object) | `BusinessDO extends DurableObject` | One DO per business, SQLite-backed — same actor model. |
| `this.messages` — branching message tree (parent_id) | `messages` + `checkpoints` tables | We keep a flat log; Think's parent_id tree is the upgrade. |
| `runFiber()` + `ctx.stash()` durable execution | `tool_call_log` WAL + `checkpoints` + `fiber_status` mutex | Same intent: survive eviction mid-cycle, resume safely (WG-09/WG-11). |
| `getSkills()` — skill catalog auto-added to prompt | `whop/skills.ts` (`renderSkillsPrompt`) | Prebuilt skills + instructions, threaded into the model prompt. |
| `getTools()` — Vercel AI SDK ToolSet | `whop/actions.ts` host-action allow-list | Fixed, name-addressed, never `eval`'d (WG-02). |
| `createExecuteTool()` (`@cloudflare/codemode`, runs JS/TS/Python/Bash) | `ToolSandboxDO` + CF Container (`Dockerfile.toolsandbox`) | Our Tier-5 sandbox is the script-native execution surface. |
| Sub-agents / Facets (`subAgent(...).chat()`) | Not yet — single agent per business | Add when a niche needs parallel sub-tasks. |
| `getScheduledTasks()` | wrangler cron → `handleScheduled` | Nightly cycle. |

## Why we didn't just `npm i @cloudflare/think`

Think is in preview; pinning an unstable preview package into the build now would
couple every deploy to its churn. Instead we mirror its shape with stable
primitives (DO + SQLite + Containers + cron) so the **adjustment** the user asked
for is a swap, not a rewrite.

## Drop-in path (when Think GAs)

1. `npm i @cloudflare/think @cloudflare/codemode workers-ai-provider`.
2. `class BusinessDO extends Think<Env>` — keep our SQLite tables as Think context
   blocks / session storage.
3. Move `whop/actions.ts` behind `getTools()` and `whop/skills.ts` behind
   `getSkills()` (it already returns the catalog shape Think expects).
4. Replace the hand-rolled `composeCommunityPost` / L2–L4 Anthropic calls with
   `runTurn()`; keep our gates (autonomy, cap, moderation, breaker, idempotency,
   §02 deploy gate) as pre/post hooks — those are the niche's safety, not Think's.
5. Point `createExecuteTool()` at the existing `ToolSandboxDO` container.

The safety rails and the script-first cost model are ours and stay; the reasoning
loop, message tree, and fiber durability become Think's.
