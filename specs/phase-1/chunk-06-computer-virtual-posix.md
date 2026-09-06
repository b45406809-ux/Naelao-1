# Phase 1 — Chunk 06: In-Memory Virtual POSIX Shell

## Objective
Implement the sub-millisecond virtual POSIX shell executing `just-bash` directly against `NaelaoAgentDO`'s SQLite `workspace_files` storage.

## Implementation Details

1. Create `workers/agents/src/workspace/virtual-shell.ts`:
   - Export class `VirtualPosixShell` wrapping `just-bash`.
   - Bind `fs` methods (`readFile`, `writeFile`, `unlink`, `readdir`) directly to SQLite `workspace_files`.
   - Implement `exec(command, envVars, cwd)`:
     * Parses POSIX syntax, pipes (`|`), redirects (`>`), `grep`, `cat`, `sed`, `awk`, `jq`, `wc`, `diff`.
     * Returns `{ stdout, stderr, exitCode, durationMs }` in sub-5ms from V8.

2. Update `workers/agents/src/script-engine/prebuilt/r2-workspace.ts`:
   - Connect `VirtualPosixShell` so that standard file operations read and patch in-memory SQLite virtual files without container escalation.
