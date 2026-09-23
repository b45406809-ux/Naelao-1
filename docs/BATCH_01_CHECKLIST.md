# Batch 01 implementation checklist

Authority reread: batch 01; Update sections 3, 5, 8, 9–11, 16–18; Updates2 sections 4–13, 20–22, 25. Newer two-level hierarchy, invisible all-CLI routing, three Tier-6 backends, lockfile-only migration, and generalized deliverables take precedence.

| ID | Runtime / persistence / authorization / API-UI-config-observability-deployment / tests |
|---|---|
| 1 | `SpaceDO` hierarchy routes + SQLite registry; parent-admin policy; spaces API/shell config; SPACE_DO; hierarchy tests. |
| 2 | Hierarchy and cross-space grant checks + member/grant rows; conceal/deny; authorization endpoint; audit events; isolation tests. |
| 3 | Project list/read filtering + visibility/member rows; 404 concealment; project APIs/UI states; private-project tests. |
| 4 | Project-only workflow/schedule dispatch + D1 FK/index; project authorization; schedule APIs/cards; workflow bindings/tests. |
| 5 | RepositoryDO object/ref/commit engine + SQLite; scoped artifact binding/API; commit telemetry; repository tests. |
| 6 | Isolate shell over R2/DO locking; normalized paths; CLI surface; tier telemetry; workspace tests. |
| 7 | `/workspace` vs `/.avos` normalization and separate prefixes; traversal denial; file UI; config/container parity; adversarial tests. |
| 8 | Six-tier dispatcher and bindings; server-only routing; receipts expose selected engine; tier integration tests. |
| 9 | minimalist action surface routed by hypervisor; no client tier authority; trace selection; tool-surface tests. |
| 10 | ArtifactFS metadata listing/lazy reads + artifact/R2 binding; scoped authorization; container mount; lazy-fetch tests. |
| 11 | revision-checked filesystem/session/HEAD/DO state; stale-write denial; conflict telemetry; synchronization tests. |
| 12 | 60-second ToolSandbox alarm/lease; persisted state before stop; operational metric; exact boundary tests. |
| 13 | WASM Python classifier; native import promotion; honest unavailable failure; loader/Sandbox config; routing tests. |
| 14 | Kitesurf navigation with Chromium fallback; SSRF authorization; engine/fallback telemetry; browser tests. |
| 15 | project-scoped Xvfb endpoints and durable state; role gate; display UI; Sandbox deployment; contract tests. |
| 16 | correlated multiplex bridge scoped by project; authorization and cancellation; socket config/metrics; concurrency tests. |
| 17 | immutable-object branch refs with safe micro-fork names; checkout API; branch telemetry; main-ref isolation tests. |
| 18 | per-successful-turn artifact commit; project authorization; timeline OID card; artifact binding; integration tests. |
| 19 | validated role/goal/task/rationale metadata persisted with commits; history/blame API/UI; invalid metadata tests. |

All listed production surfaces are implemented in the referenced existing workers and adapters; this batch tightened container backend migration and reasoning metadata at the shared runtime contract so all adapters receive the same fail-closed rules.
