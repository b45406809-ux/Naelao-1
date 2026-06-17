# Prompt 01: Root package.json + tsconfig.json

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---


**Platform context:** Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects.
NO Node.js · NO PostgreSQL · NO Supabase. Data in SpaceDO SQLite. Worker comms via Service Bindings.
Routing via Hono. Auth via JWT (HMAC-SHA256). Billing via Lemon Squeezy (BillingProvider interface).
Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: "2025-01-01".

**Generate these TWO files exactly as shown below.**

---

## File 1: `package.json` (monorepo root)

Generate a pnpm workspaces monorepo `package.json` for the Naelao project with:
- `name: "naelao"`, `private: true`, `version: "0.1.0"`
- `packageManager: "pnpm@9.0.0"`
- workspaces: `["packages/*", "workers/*"]`
- devDependencies (exact versions):
  - `typescript: "^5.4.0"`
  - `@cloudflare/workers-types: "^4.20240701.0"`
  - `wrangler: "^3.60.0"`
  - `hono: "^4.4.0"`
  - `vitest: "^1.6.0"`
  - `@vitest/coverage-v8: "^1.6.0"`
- scripts:
  - `build`: `tsc -b`
  - `test`: `vitest run`
  - `deploy:all`: shell script that deploys workers in dependency order (see deploy order below)
  - `typecheck`: `tsc --noEmit`

Deploy order in `deploy:all` (use `&&` chaining, `wrangler deploy --config`):
naelao-spaces → naelao-auth → naelao-credentials → naelao-threads → naelao-knowledge →
naelao-billing → naelao-analytics → naelao-notifications → naelao-registry → naelao-agents →
naelao-mcp-hub → naelao-triggers → naelao-workflows → naelao-sweeper → naelao-provisioner →
naelao-together-ai → naelao-admin → naelao-eval → naelao-portal-router → naelao-artifact → naelao-router

---

## File 2: `tsconfig.json` (root, extended by all workers)

Generate a base `tsconfig.json` with:
- `compilerOptions`:
  - `target: "ES2022"`
  - `lib: ["ES2022"]`
  - `module: "ES2022"`
  - `moduleResolution: "Bundler"`
  - `strict: true`
  - `noUncheckedIndexedAccess: true`
  - `exactOptionalPropertyTypes: true`
  - `types: ["@cloudflare/workers-types"]`
  - `paths`: map `@naelao/types` to `./packages/types/src/index.ts`, same for `@naelao/analytics-schema` and `@naelao/billing-providers`
- `exclude: ["node_modules", "dist"]`

Output ONLY the two JSON files. No TypeScript. No explanation after the files.
