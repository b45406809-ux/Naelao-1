# Batch 02 implementation checklist

Authority reread: batch 02; Update sections 9, 13, 16–17; Updates2 sections 1–7 and 20. The all-CLI `Bash` surface, scoped `/.avos/bin`, invisible routing and Jev/WriteGuard preflight supersede explicit infrastructure tools.

| ID | Runtime / persistence / authorization / API-UI-config-observability-deployment / tests |
|---|---|
| 20 | Frozen `ctx` proxies for fs/project/space/vault/cli/browser/connectors; project scope required; host bindings withheld; runner API and capability omission tests. |
| 21 | Logical vault aliases and encrypted credential service; tenant/space authorization; only outbound worker injects headers; connection UI/audit/bindings; leak tests. |
| 22 | WriteGuard scans decoded SQL/shell mutation parameters before side effects; signed scoped capability required; nonce/audit boundary; SECURITY_GATEWAY parity; adversarial tests. |
| 23 | Virtual CLI parses and dispatches catalog commands inside isolate; tenant/space/project/user storage key; command receipts/metrics; dispatcher tests. |
| 24 | Safe bounded parser synthesis into versioned store; no eval/dynamic import; scoped `$PATH` persistence; registration API/error UI; reload and hostile-source tests. |

Existing production workers provide credential encryption/outbound injection and the script engine execution path. This batch closes encoded-mutation and synthesized-command cross-scope persistence gaps in their shared SDK contract.
