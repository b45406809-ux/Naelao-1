# Optional project code indexer

Project agents can use the optional `ext_lsp_indexer` project extension and virtual Bash
commands to index bounded TypeScript, JavaScript and Python workspace files in that project's
private Durable Object SQLite storage:

```bash
lsp index
lsp find-symbol User
lsp find-refs User
lsp get-signatures src/types.ts
lsp status
```

An owner or admin installs it for one project with the project extension installer endpoint
(`POST /spaces/{spaceId}/projects/{projectId}/extensions/lsp-indexer`). Calls are rejected until
that project has an active installation. FDE-authored coding templates can include
`ext_lsp_indexer` in their required extensions and add the guidance below to the project
instructions. The planner and delegated workers can call it through `code.execute_bash` when that
prebuilt is in their allowed tool surface; all LSP actions remain virtual CLI commands and do not
start a native container.

`lsp index` refreshes the current source-file index; pass paths to update selected files without
replacing other indexed files. A full refresh is limited to 200 files and 2 MB per request, and
individual files above 512 KB are skipped. Select smaller path groups when the workspace exceeds
those bounds. The current agent invocation's project and delegated-file scope control which files
can be read. The index lives in that project's SQLite actor, not in the Space Assistant's or a
different project's workspace.

An FDE can add this guidance to a software-engineering project's agent instructions:

> For repository navigation, use the `lsp` Bash commands before broad file reads: run `lsp index`,
> then use `lsp find-symbol`, `lsp find-refs`, and `lsp get-signatures` to narrow the relevant
> files. Do not claim the index is complete. If the command is unavailable, the index is stale, or
> a result is incomplete, fall back to normal project read/search tools and state the limitation.
> Re-index after source changes before relying on its results.

This is an optional project extension, not a mandatory kernel parser and not a full language server.
The existing parser is a bounded lexical indexer. `find-refs` returns identifier occurrences
outside ordinary comments and quoted strings; it does not resolve imports, scopes, property
bindings, template-string expressions or semantic references. It does not listen to file-save or
Git commit events. No Tree-sitter WASM grammar is deployed, so this feature does not claim syntax
validation, a complete AST, automatic semantic refactoring, or the latency figures in the source
conversation.
