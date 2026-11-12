# Autonomous managed-services implementation session

Use this prompt in the next session. It authorizes implementation when submitted by the user;
creating this document alone does not start product changes. Instructions and progress are in Git;
installed tools, credentials and machine state must be re-established separately.

```text
Implement the entire Naelao managed-services and sidecar runtime plan, including its inherited
unified-platform code gaps. Work autonomously through all milestones and integrate the result;
do not stop after one phase while independent implementation remains.

Start with repository and remote bootstrap:

1. Inspect `/workspace/Naelao-1-managed-services` first. Preserve its active branch
   `autonomous-managed-services-20261111` and every dirty/untracked path. Do not reset, clean,
   replace, stash, switch branches or fast-forward the selected recovery branch over this worktree.
   Inspect `git remote -v`, `git branch --show-current`, and `git status --short --branch`.
2. The user-selected recovery destination is `origin/Mcbt5s-Backup-2`, separate from the active
   implementation branch. Fetch it only for inspection. Before each authorized recovery push,
   verify the remote tip is an ancestor of local `HEAD`; then use the explicit fast-forward refspec
   `HEAD:refs/heads/Mcbt5s-Backup-2`, without force. If histories diverge, preserve both and stop
   before any merge, rebase or overwrite; continue independent local implementation.
3. Read AGENTS.md and applicable nested instructions. Discover Node/package manager from the
   current root package.json; bootstrap pinned tools, install frozen-lockfile dependencies and
   build required workspace packages. Do not assume credentials, generated SDK declarations,
   local Docker, FUSE, workerd or browser tooling are already present. Record tool versions and
   real failures without weakening checks or exposing credentials.

Read these sources and current code before implementing:
- AGENTS.md
- docs/research/managed-services-and-sidecar-runtime-plan.md, every section including 18–19
- docs/research/managed-services-and-sidecar-implementation-progress.md
- docs/operations/managed-services-acceptance.md
- docs/research/naelao-unified-platform-deep-plan.md
- docs/research/unified-platform-implementation-progress.md
- docs/research/unified-workspace-requirements.md
- docs/requirements-trace-matrix.md
- docs/dynamic-containers-rollout.md
- docs/operations/unified-workspace-phase-6.md
- new plan/NAELAO-SANDBOXES-IMPLEMENTATION.md
- new plan/NAELAO-SANDBOXES-EVIDENCE.md
- Relevant AgentPort, email, provider SDK and billing source/evidence records discovered in S1.

This is an implementation request. Start at the exact unfinished action in the progress record,
reconcile newer commits with prior evidence, and complete S1–S9. The bootstrap preparation was
based on 700c3fe0, not a claim that later commits do not exist. Audit every requirement, give it
an ID and actual caller/evidence path, then implement all feasible code before treating missing
live credentials as a blocker. Close the inherited first-plan code gaps U01–U12 alongside the
new functionality. Preserve prior fixes, source transcripts and the existing architecture.

Cloudflare Dynamic Sandbox is the main runtime: one logical main computer per project with
fenced allocation and recoverable private state. Only the main runtime automatically uses the
default workspace workflow. Specialist sidecars are explicit tools with separate filesystems
and authorized artifact transfers. Canonical workspace state changes only through checked
publication. Default to checked_handoff; never silently downgrade requested live mode.

Implement the managed provider/AgentPort account, grant and lifecycle model; shared credits and
parent/agent payer mandates; actual Cloudflare live authority/runtime services; persistent main
computer and sidecars; Cloudflare email inbox and provider/channel adapters; event routing and
SDK/MCP/API consumers; provider dashboard/UserPort; settings, cleanup, reconciliation and tests
as specified in the complete plan. Verify current primary provider contracts. Never invent a
provider API, payment facility, commercial approval, credential, price, passing test or digest.
Do not call an interface, mock-only service, hardcoded unavailable route or fixture UI complete.

Continue independent work when one item needs a provider account or external decision. Record
exactly what is missing, what code is complete, what code cannot yet be written and why, and the
specific live acceptance journey. Implement configurable policy controls where feasible while
preserving existing approved retention/defaults. A missing ordinary service is an implementation
gap even if final validation requires live credentials. Do not claim only live tests remain unless
a final code/caller audit proves it. Unsupported provider capabilities remain accurately gated.

After every meaningful milestone update the progress record and AGENTS.md checkpoint, commands,
results, current branch/base, dirty files, requirement statuses and exact next action. Update the
first-plan trace/progress record when closing inherited gaps. On compaction/interruption reread
those files and inspect the worktree, then resume without restarting completed work.

Run meaningful tests for authorization, persistence, concurrency, recovery, billing, provider
operations and integration; run affected typechecks, migration/config checks and connected local
journeys. Fix relevant failures. Distinguish mocks, local emulation, real Container and deployed
provider evidence. Commit and push every coherent verified checkpoint to `origin/Mcbt5s-Backup-2`
using the explicit fast-forward refspec above; this workflow is authorized. Never force-push or
reconcile divergence through reset, rebase, merge or overwrite. Do not enable rollout flags or spend
money/create paid resources, deploy to production, run destructive remote migrations or message
people without separate authorization.

Before finishing, audit every requirement from sections 1–19 and the original phases A–G. Close
remaining independent code gaps, integrate callers, remove stale status claims and record exact
external/live gates. Report actual checks, any genuine remaining code and reason, credentials or
decisions needed, branch/commit and dirty status. Do not pause merely because one milestone is
complete.
```
