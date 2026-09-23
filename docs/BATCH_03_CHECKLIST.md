# Batch 03 implementation checklist

Authority reread: batch 03; Update sections 1–8 and 13–16; Updates2 sections 2–3, 8–10, 18–23. Strict depth-three delegation, aliases, hierarchical assistants, pristine workflows, compact receipts, and quarantined public/customer planes prevail.

| ID | Runtime / persistence / authorization / API-UI-config-observability-deployment / tests |
|---|---|
| 25 | Tenant-bound alias resolver and D1 alias rows; authenticated MCP lookup; connector settings/status; resolution telemetry; no cross-tenant fallback tests. |
| 26 | Pre-side-effect scope verification and OAuth state; incremental reauth API/card; connector bindings/audit; missing-scope/retry tests. |
| 27 | HMAC capability attenuation with resource/action/expiry/depth and SpaceDO cross-grant; revocation audit; tamper/isolation tests. |
| 28 | user > project > space connector precedence with tenant keys; credential boundary; directory API/UI; scope tests. |
| 29 | serialized prompt schema physically strips personal tools; private-fork card; channel session scope; public-channel tests. |
| 30 | 15-second identity-bound single-use grant and atomic nonce ledger; elicitation card/consume API; replay/boundary tests. |
| 31 | first-mention holder and remaining referents; event dedupe/turn lock; channel telemetry; one-wakeup tests. |
| 32 | atomic lock transfer through `ctx.agent.delegate`; old holder denied; task persistence/receipts; race tests. |
| 33 | HMAC delegation preserves human/role and enforces strict depth 3; nonce/expiry; audit; amplification/depth tests. |
| 34 | trace distillation to versioned `/.avos/shared/skills`; project authorization; Vectorize metadata/catalog; health tests. |
| 35 | media transcription/vision trace requires verification before activation; scoped R2 versions; progress UI/telemetry; contract tests. |
| 36 | metadata-only command catalog in prompt; source loaded on demand; R2/Vectorize scope; token metrics; disclosure tests. |
| 37 | enum-only declarative hooks; R2 config; authorized pre/post execution; receipts; schema/gate tests. |
| 38 | serialized nested-payload DLP before consumer egress; redacted-only audit; gateway binding/metrics; SSN/card/key tests. |

This pass made connector lookup tenant-mandatory, rejects malformed grants, enforces delegation depth in attenuation, and scans nested serialized payloads before egress.
