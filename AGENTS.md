# Naelao implementation instructions

## Start or resume

When the user says **start** or **continue** in this repo, run the implementation queue on
`origin/Mcbt5s-Backup-2`. Use one session, one plan and one task at a time. Begin with the first
concrete action in the queue. A status summary, verified checkpoint or push is an intermediate
result. Keep working through ready tasks until the queue is complete, the user redirects the
session, or a specific blocker leaves no ready work.

1. Find the Naelao checkout. Check its remote, branch, working tree and local-only commits.
   Fetch `origin/Mcbt5s-Backup-2` before choosing work. In a fresh environment, start from
   that fetched commit. If the current checkout contains other work, use a separate worktree
   or clone and preserve the existing files and commits.
2. Read the [implementation queue](docs/operations/implementation-queue.md) from the recovered
   checkout. Follow its active task and latest checkpoint, then read only the relevant plan,
   ledger entries and source. If the pointer below is stale or absent, the queue decides what
   to resume or promote. Compare saved evidence with the code before repeating any step.
3. In an existing checkout, recover useful local work before restarting it from the remote.
   After an interruption during a push, fetch and check whether the remote already contains
   the commit. If the environment is still starting or reconnecting, wait for readiness and
   resume from the checkout when it returns.

## Save progress inside each task

- Break the active task into small slices that can be checked on their own. Commit and push
  each coherent slice as soon as its relevant checks pass, even while the task is still open.
  Include the work and a brief handoff that states what passed, what remains, and the exact
  next action. Keep the task checkbox open until its acceptance criteria are met.
- Fetch before pushing, then verify the remote contains the checkpoint commit. If a push
  fails, preserve the local commit, check the remote and retry safely. Treat the latest
  confirmed remote commit as the recovery point for a fresh environment.
- When a task is verified, check it off and point this file at the next ready task in the
  same plan. When that plan has no ready work, advance to the next plan. Record blockers
  and their resume conditions in the queue. If nothing is ready, remove the Current task
  section. Include the queue and pointer transition in the checkpoint, then continue.
- Keep checkpoint detail in the queue and linked ledgers. Reuse existing requirement IDs
  and code for overlaps. Verify reachable callers and distinguish mock, local and live
  evidence.

## Repository rules

- Read nested AGENTS.md files before editing their paths. Use the pinned Node and pnpm versions
  from the repo and a frozen lockfile. Preserve existing work and untracked files.
- Fetch and safely integrate `origin/Mcbt5s-Backup-2` before each authorized checkpoint push.
  Use `git push origin HEAD:refs/heads/Mcbt5s-Backup-2` once the fetched tip is an ancestor
  of the intended commit.
  Preserve both sides of any divergence. Avoid force pushes, resets and cleaning away work.
- Production deployment, rollout enablement, paid purchases, destructive remote migrations
  and external messages require separate authorization. Keep rollout gates disabled until
  accepted. Protect credentials and report unverified provider behavior, prices and live results
  as such.
- Preserve identity, tenant and project boundaries, revocable grants, billing admission and
  checked workspace publication. Cloudflare DynamicSandboxDO is the main runtime candidate.
  One logical main computer per project participates in default execution and sync. Specialist
  sidecars use independently scoped filesystems and authorized transfers. Preserve tunnel consent.
- Only WorkspaceCoordinatorDO checked publication advances canonical state. Restore and upstream
  sync target staging. Default to `checked_handoff` and require runtime evidence for any requested
  `live_single_writer` mode. Preserve AgentPort independence, guest isolation, version and
  generation fences, and approved retention. Record external operations before dispatch and
  reconcile uncertain outcomes before retrying.

## Current task

**Platform completion and guided templates · P05 — trace Space-shared provider-connection scope.**
Reconcile signed Blueprint dependencies, activation, owner connection selection and revocation
against current host authority. Implement only a scope current records can enforce; otherwise record
the missing beneficiary, payer, shared-authority or drain/revoke contract and continue to the next
ready task. Keep all rollouts disabled.
