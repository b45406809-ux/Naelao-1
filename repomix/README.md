# Repomix micro-phase implementation packs

This directory packages the finalized 130-item plan for API models without assuming a million-token request is usable. It preserves full source and line numbers while progressively loading only the files needed by a two-item implementation phase.

## Build and validate

```bash
node repomix/build-prompts.mjs
node repomix/prepare-authority-context.mjs
node repomix/verify-configs.mjs
node run-phase.mjs --start 1 --end 67 --dry-run
```

`phases.json` is the machine-readable execution plan: 67 ordered phases, normally two adjacent items each, a 48,000-token target and 64,000-token hard input ceiling. The original 13 JSON files remain as domain source profiles, not execution batches. `run-phase.mjs` derives a small line-numbered, uncompressed Repomix slice from the applicable profile for each micro-phase.

## No lost context

The prompt compiler resolves the complete source chronology before execution: repository state is evidence; `CLAUDE.md` is the older baseline; expanded gaps and Appendix A1 retain compatible constraints; linked conversations override the baseline from left to right; and `_BUILD_PLAN/EVOLUTIONARY_ARCHITECTURAL_CHANGELOG.md` is the newest authority. Generated prompts contain the resolved behavior rather than asking a smaller model to repeat that research.

A small initial pack contains the self-contained prompt, repository path inventory, and highest-scoring production files. When a required file is absent, the model returns `CONTEXT_REQUEST:` with exact repository paths. The runner creates another full-source Repomix slice for only those paths. This progressive disclosure preserves source fidelity without truncation, compression, removed comments, or pretending an 8K model can accept a 600K pack.

## Provider rotation and real limits

`provider-models.json` records a dated, conservative eligibility snapshot and official source URLs. Limits are not promises: account tiers, previews, and free catalogs change. The runner therefore:

1. reads configured Gemini, Groq, and OpenRouter key rotations;
2. ranks models by capability, including preview models;
3. estimates input plus reserved output against context and TPM guards;
4. skips ineligible small models rather than submitting an impossible request;
5. rotates provider/model/key combinations on quota and transient failures;
6. uses live HTTP status and retry behavior as authority.

Groq's published free-plan table currently gives `groq/compound` and `compound-mini` a 70K TPM guard, while several capable hosted models have only 8K TPM. Those 8K entries remain available for genuinely tiny follow-up slices, but are never sent oversized source. OpenRouter's `openrouter/free` dynamically selects a currently free endpoint, so its exact underlying model must not be hard-coded. Google directs users to AI Studio for project-specific active limits; the registry therefore uses the model context ceiling and a conservative guard, while 429 responses trigger rotation.

Official sources:

- <https://ai.google.dev/gemini-api/docs/rate-limits>
- <https://console.groq.com/docs/rate-limits>
- <https://console.groq.com/docs/models>
- <https://openrouter.ai/docs/api-reference/limits>
- <https://openrouter.ai/api/v1/models>

## Secrets

Configure any of:

- `GEMINI_API_KEYS`
- `GROQ_API_KEYS`
- `OPENROUTER_API_KEYS`

Each accepts one key or a comma-separated rotation. The GitHub workflow fails closed when all are absent. Keys are never placed in generated packs.

## Workflow behavior

`.github/workflows/implement-full-plan.yml` runs micro-phases 1–67 sequentially on one accumulator branch. Each phase regenerates context after the previous phase commit, accepts bounded continuation/context-request turns, validates every diff with `git apply --check`, executes the configured repository verification command, commits atomically, uploads diagnostic responses, pushes the branch, and opens one reviewable PR.

No automation can guarantee bug-free generated code. The design instead prevents known false-success modes: impossible context submissions, silent source truncation, out-of-order phases, unvalidated patches, completion without tests, and claims that helpers/placeholders constitute production implementation.
