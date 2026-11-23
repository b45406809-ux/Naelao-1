# Naelao implementation instructions

## Current task

**APW02 — Host admission for dynamic goal graph expansion.** Resume from the checked-in
[implementation queue](docs/operations/implementation-queue.md#active-plan). Reconcile the current
caller against the APW02 ledger entry, then implement the next missing slice of host-owned
expansion while preserving task identity, scoped grants and Billing admission. Progressive
routing stays disabled by default.

## Work through the queue

- Use one implementation session, one active plan and one active task at a time. Start or
  resume by checking the actual branch, worktree and remote tip, then read the queue and the
  active task's plan and ledger entries. Read other plans only for a dependency or overlap.
- After each verified task, record evidence and check it off in the queue. Replace the current
  task above with the next ready task in the same plan. When that plan has no ready work, advance
  to the next plan. Record any blocked item and its resume condition in the queue. If no task
  is ready, remove the Current task section until one becomes ready.
- Keep this file as instructions and the current pointer. Put checkpoint history, completion
  evidence, pending work and blockers in the queue and linked ledgers. Resume from those
  records after interruption. A checkpoint is a place to resume within the goal.
- Reuse existing requirement IDs and code for overlaps. Verify reachable callers and run the
  relevant checks. Record local, mock and live evidence accurately. Continue through available
  work within the active goal unless the user redirects it or an actual blocker prevents progress.

## Repository rules

- Read nested AGENTS.md files before editing their paths. Use the pinned Node and pnpm versions
  from the repo and a frozen lockfile. Preserve existing work and untracked files.
- Fetch and safely integrate `origin/Mcbt5s-Backup-2` before each authorized checkpoint push.
  Push to that ref normally once the fetched tip is an ancestor of the intended commit.
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
