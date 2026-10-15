# Private model adapter lifecycle

Space-owned adapters can be imported and used only after an owner records data eligibility, imports the adapter, records an evaluation, and approves activation. The API records attested evidence; it does not inspect a dataset or independently reproduce the evaluator's score.

Training submission is disabled. The current environment could not verify an official provider training API or a live adapter compatibility contract. Training requests return `training_unavailable`; adapters must be imported from an externally managed provider.

Lifecycle actions use `POST /spaces/:spaceId/custom-models/:modelId/lifecycle` and are limited to Space owners/admins:

1. `attest_consent` supplies `provenance`, `purpose`, `lawfulBasis`, and affirmative assertions for consent, same-Space-only data, secret/protected-content exclusion, and a deletion plan.
2. `import_adapter` supplies an allowlisted Workers AI base model, a provider adapter identifier, and short provider evidence. The evidence is recorded as owner-supplied and unverified.
3. `record_evaluation` supplies the matching base model, versioned test-set identifier, sample count, score, threshold, and optional baseline. A score below threshold or baseline is recorded as failed and cannot be activated.
4. `approve_activation` is a separate owner action. Only an active adapter is available to the internal inference resolver; activating a new one keeps the previously active adapter reference for rollback. Legacy adapters remain marked unverified.
5. `rollback`, `revoke`, and `delete` restore the prior adapter where possible. Revoke/delete remove the adapter identifier from the inference manifest. Delete also clears the lifecycle's provenance, purpose, consent, and evaluation details while retaining a minimal audit event.

`GET /spaces/:spaceId/custom-models/:modelId/lifecycle` returns lifecycle metadata without the provider adapter identifier. The identifier is returned only by an internal HMAC-protected route used by the Agents Worker. `PATCH /spaces/:spaceId/model-config` can select an adapter only after lifecycle status is active; the ordinary model-policy and air-gap gates still apply.

Migration 72 seeds pre-existing manifests as active with `legacy_unverified` evidence to preserve existing configurations. New imports must complete the lifecycle. Owners should re-attest/evaluate legacy adapters before replacing or redistributing them. The versioned evaluation is an owner-supplied record, not a platform-run benchmark or provider certification.
