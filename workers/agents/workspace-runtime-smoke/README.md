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

In another shell, provide the same run ID and token. Set `WORKSPACE_SMOKE_PHASE4=true` to test main/branch migration receipts, the atomic policy switch, branch overlays, rollback restore, and fixture cleanup. Add `WORKSPACE_SMOKE_PAGINATED_MIGRATION=true` to seed 1,002 additional files and exercise the inventory pagination stress case; this exceeds local cutover limits in the current workerd run and should only be used with a disposable deployed binding sized for the test. Set `WORKSPACE_SMOKE_GIT=true` to run checked Git commit → isolated branch → branch commit → merge → drift detection → projection repair → rollback, then a separate legacy publication-journal replay after an R2 PUT commits but its response is lost. Set `WORKSPACE_SMOKE_WAIT_FOR_ROLLBACK_EXPIRY=true` with Phase 4 to wait the full one-hour minimum rollback window and verify alias cleanup continuation after a dropped response; this mode intentionally takes at least one hour. Set `WORKSPACE_SMOKE_LARGE_FILE=true` to send and read back exactly 20 MiB through the Worker, coordinator Durable Object, and R2 binding. The large transfer uses roughly 28 MiB of JSON/base64 request data and needs sufficient memory and storage. Set `WORKSPACE_SMOKE_TOOLSANDBOX=true` to exercise the actual ToolSandboxDO and its attached Docker container through cold start, shell execution, idempotent replay/conflict, terminal lifecycle events, stop, and restart. This requires Docker; the smoke-only subclass uses a zero-credit profile and is not deployed-runtime or billing evidence.

```sh
WORKSPACE_SMOKE_URL=http://127.0.0.1:8791 \
WORKSPACE_SMOKE_RUN_ID=<fresh-run-id> \
WORKSPACE_SMOKE_TOKEN=<same-bearer-token> \
WORKSPACE_SMOKE_PHASE4=true \
WORKSPACE_SMOKE_GIT=true \
WORKSPACE_SMOKE_LARGE_FILE=true \
node run.mjs
```

The smoke Worker is not the product Agents, Spaces, Artifact, or ToolSandbox deployment. Its migration flag is isolated to this disposable test Worker. A pass verifies the local workerd/SQLite Durable Object/R2 implementation only. Deployed traffic ownership, production binding limits, Git/provider journeys, and real ToolSandbox Container lifecycle require their own deployment and receipts.
