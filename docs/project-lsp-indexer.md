# Optional project code indexer

Project agents can use a virtual Bash command to index bounded TypeScript, JavaScript and
Python workspace files in the project's Durable Object SQLite storage:

```bash
lsp index
lsp find-symbol User
lsp find-refs User
lsp get-signatures src/types.ts
lsp status
```

`lsp index` refreshes the current source-file index; pass paths to update selected files without
replacing other indexed files. A full refresh is limited to 200 files and 2 MB per request, and
individual files above 512 KB are skipped. Select smaller path groups when the workspace exceeds
those bounds. The current agent invocation's project and delegated-file scope control which files
can be read. The index lives in that project's SQLite actor, not in the Space Assistant's or a
different project's workspace.

An FDE can add this guidance to a software-engineering project's agent instructions:

> For repository navigation, run `lsp index` and use `lsp find-symbol`, `lsp find-refs`, and
> `lsp get-signatures` before reading or editing code. If the command is unavailable or the result
> is incomplete, use the normal project read/search tools and state the limitation. Do not assume
> the index is current after source changes; re-index before relying on it.

This is an optional project command, not a mandatory kernel parser and not a full language server.
The existing parser is a bounded lexical indexer. `find-refs` returns identifier occurrences
outside ordinary comments and quoted strings; it does not resolve imports, scopes, property
bindings, template-string expressions or semantic references. It does not listen to file-save or
Git commit events. No Tree-sitter WASM grammar is deployed, so this feature does not claim syntax
validation, a complete AST, automatic semantic refactoring, or the latency figures in the source
conversation.
