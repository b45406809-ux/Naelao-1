# Current conversation continuation implementation runbook

The current user mission supersedes the earlier batch source restriction below.
Work sequentially through all 33 USER/AI MODEL pairs in
`new plan/Tokenizers vs. Embedding Models Explained.continuation.messages.txt`.
Use `new plan/FOUNDRY-SPACE-PLATFORM-CONTINUATION-PLAN.md` for exact primary and
later-amendment reading ranges. Read the actual transcript manually in bounded
windows, reconcile later corrections before implementing each pair, and inspect
current code independently. Model replies are candidate designs; validate vendor
claims. Keep source transcripts unchanged. Update
`new plan/CONTINUATION-IMPLEMENTATION-PROGRESS.md` with read ranges, changes,
verification, unresolved dependencies, and the exact next unfinished action.
Commit and push on `Mcbt5s-Backup-2`. Reading a later pair as look-ahead does not
complete that pair. Do not treat previous completion notes as fresh test evidence.

## Earlier ten-batch runbook (historical task guidance)

For this task, read `new plan/CODEX-CLOUD-PROMPTS.md` shared rules and then
resume from `new plan/CLOUD-PROGRESS.md`. Work in numbered batch order. Do not
mark a batch complete from source reading alone: close its substantive
requirements, record code changes and fresh verification, then mark it complete
under the matching prompt and in the progress table. Keep batches not yet
assessed marked `UNASSESSED`. If work is interrupted, continue the recorded
unfinished action without restarting completed work. Product requirements come
only from the bounded ranges of the two original TXT files named by the current
prompt, reconciled with later amendments in those same files. Keep both TXT
files unchanged. Keep the selected branch `Mcbt5s-Backup-2`.

This file preserves repository task guidance. It does not change Codex app
feature flags or override the cloud environment's filesystem permissions.

To launch the Codex CLI with its Goals feature enabled for that process, use
`scripts/codex-goals.sh`; verify with `scripts/codex-goals.sh features list`.
The launcher cannot alter the environment of an already running Codex app.
