# Verified vertical-slice implementation runner

This tooling is retained for optional AI-assisted implementation of the 130-item plan, but it no longer sends broad repository dumps or trusts a model's claim that a phase is complete.

## Execution design

The 130 requirements are grouped into 26 dependency-ordered vertical slices in `phases.json`. A slice follows one production journey—router/authentication, authoritative worker or Durable Object, scoped persistence, environment configuration, shell UI, and realistic tests—instead of grouping items merely because their numbers are adjacent.

Each live slice performs:

1. **Deterministic index:** `build-repository-index.mjs` records TypeScript imports, reverse imports, workspace packages, route registrations, Wrangler bindings, symbols, and associated tests without AI tokens.
2. **Scout:** the highest-ranked available Gemini 3.x model returns a structured context manifest. It cannot edit code.
3. **Validation and expansion:** unknown/traversing paths are rejected; imports, workspace dependencies, tests, package configs, and matching bindings are added locally.
4. **Bounded context:** files are supplied with line numbers. Large TypeScript files are AST-sliced by complete symbol rather than silently omitted or byte-truncated.
5. **Implementation:** the model may edit only declared files. Existing files must have appeared in the current context. Missing source requires an exact-path `CONTEXT_REQUEST`.
6. **Persistent notebook:** inspected files, patches, checks, and review findings survive across stateless API calls in `.phase-runs/<slice>/state.json`.
7. **Layered verification:** every patch runs diff validation, affected-package typechecks, declared tests, binding/vars parity, the trace-matrix test, and the Repomix configuration verifier. Full repository verification runs at domain boundaries and at the final selected slice.
8. **Independent review:** a fresh diff-focused call must approve security, tests, and every production boundary. `PHASE_STATUS: COMPLETE` alone has no authority.
9. **Resumability:** every approved slice is committed and pushed immediately. CI reuses `ai/verified-plan-accumulator`; reruns skip exact slice-completion commits already on that branch. Responses, manifests, notebooks, patches, and evidence are uploaded by CI.

## Model policy

The runner accepts capability-ordered, comma-separated Gemini 3.x pools. It queries each key's live model catalog, adds text-capable Gemini 3.x models that support `generateContent`, excludes image/live/TTS/transcription models, and tries Pro before full Flash before Flash Lite. A retired model, quota response, empty response, or provider failure rotates to the next model/key instead of terminating the accumulator. It never crosses into Gemini 2.x or a different provider.

Only `GEMINI_API_KEYS` is required for this workflow. It accepts one key or a comma-separated key rotation. Keys never enter prompts, repository indexes, artifacts, or logs.

## Local validation

```bash
pnpm install --frozen-lockfile
node repomix/build-prompts.mjs
node repomix/prepare-authority-context.mjs
node repomix/build-repository-index.mjs
node repomix/verify-configs.mjs
pnpm exec vitest run --config tests/vitest.config.ts \
  tests/unit/repomix/context-manifest.test.ts \
  tests/unit/repomix/gemini-models.test.ts \
  tests/unit/repomix/repository-index.test.ts \
  tests/unit/requirements-trace-matrix.test.ts
node run-phase.mjs --start 1 --end 1 --dry-run
```

## Live execution

Use a single review-sized milestone first:

```bash
GEMINI_API_KEYS='...' node run-phase.mjs --start 1 --end 1 \
  --models 'gemini-3.1-pro-preview,gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash'
```

After several slices have succeeded and been reviewed, the complete accumulator run is:

```bash
GEMINI_API_KEYS='...' node run-phase.mjs --start 1 --end 26
```

The GitHub workflow defaults to the complete 26-slice accumulator run; lower `end_slice` to create a review-sized milestone while qualifying keys and models. No automation can guarantee error-free generated code; this runner minimizes risk through constrained context, deterministic gates, real tests, independent review, and human-sized commits rather than making such a guarantee.
