# Current cloud implementation runbook

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
