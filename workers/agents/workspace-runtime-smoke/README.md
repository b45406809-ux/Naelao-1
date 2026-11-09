# Disposable workspace runtime smoke

This Worker exposes test-only R2 seeding/listing and coordinator proxy routes. It fails closed unless `WORKSPACE_SMOKE_DISPOSABLE=true`, a run ID, a bearer token of at least 32 characters, and `PLATFORM_SECRET` are supplied. Keep both secrets out of `wrangler.toml`; use local CLI variables or a Wrangler secrets file. Use a fresh run ID for every execution because `/v1/erase` intentionally tombstones its coordinator scope.

Start local SQLite Durable Objects and local R2 from this directory:

```sh
../../../node_modules/.bin/wrangler dev --local --port 8791 \
  --persist-to /tmp/naelao-workspace-smoke \
  --var 'PLATFORM_SECRET:<random-local-secret>' \
  --var 'WORKSPACE_SMOKE_DISPOSABLE:true' \
  --var 'WORKSPACE_SMOKE_TOKEN:<random-bearer-token>' \
  --var 'WORKSPACE_SMOKE_RUN_ID:<fresh-run-id>' \
  --var 'UNIFIED_WORKSPACE_ENABLED:true'
```

In another shell, provide the same run ID and token. Set `WORKSPACE_SMOKE_PHASE4=true` to test main/branch migration receipts, the atomic policy switch, branch overlays, rollback restore, and scoped fixture cleanup. Set `WORKSPACE_SMOKE_LARGE_FILE=true` to send and read back exactly 20 MiB through the Worker, coordinator Durable Object, and R2 binding. The large transfer uses roughly 28 MiB of JSON/base64 request data and needs sufficient memory and storage.

```sh
WORKSPACE_SMOKE_URL=http://127.0.0.1:8791 \
WORKSPACE_SMOKE_RUN_ID=<fresh-run-id> \
WORKSPACE_SMOKE_TOKEN=<same-bearer-token> \
WORKSPACE_SMOKE_PHASE4=true \
WORKSPACE_SMOKE_LARGE_FILE=true \
node run.mjs
```

The smoke Worker is not the product Agents, Spaces, Artifact, or ToolSandbox deployment. Its migration flag is isolated to this disposable test Worker. A pass verifies the local workerd/SQLite Durable Object/R2 implementation only. Deployed traffic ownership, production binding limits, Git/provider journeys, and real ToolSandbox Container lifecycle require their own deployment and receipts.
