# Prompt: workers/naelao-artifact/src/ (2 files)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate TWO files for workers/naelao-artifact/src/.

Env:
  NAELAO_ARTIFACTS: R2Bucket
  NAELAO_ARTIFACT_KV: KVNamespace  (metadata)
  NAELAO_DISPATCH_NS: DispatchNamespace  (CF Workers for Platforms, for React artifacts)
  NAELAO_JWT_SECRET: string

=== File 1: src/sandbox.ts ===

CRITICAL FIX (G-F09): NEVER use template literal interpolation for user code.

  type ArtifactType = 'html' | 'react' | 'json' | 'markdown' | 'csv';

  function wrapHtmlArtifact(code: string, title?: string): string
  - Wraps user HTML in a safe sandboxed wrapper
  - Content Security Policy: no external scripts, no inline event handlers
  - CORRECT: store code as base64, decode at runtime — NOT string interpolation
  - return '<html><head><meta charset="utf-8"><title>' + (title ?? 'Artifact') + '</title></head>'
    + '<body><script>document.write(atob("' + btoa(code) + '"))</' + 'script></body></html>'
  
  Actually: for HTML, safely embed using template but encode ALL special chars:
    Escape: < > & " ' / in user code before any embedding
    Use DOMParser approach (no DOM in Workers) - store as base64 constant, write via script

  function wrapReactArtifact(code: string): string
  - NEVER interpolate code into template literal
  - Store code in R2, generate a signed R2 URL for import
  - Return a wrapper HTML that loads the component via dynamic import of the R2 URL

=== File 2: src/index.ts ===

Hono Worker for artifact serving.

Routes:
  POST /v1/artifacts
    Body: { type: ArtifactType; code: string; title?: string; spaceId: string }
    1. Validate code: run security scanner (no process.env, no require('child_process'), no eval patterns)
    2. Wrap code using sandbox functions
    3. Store in R2: artifacts/<spaceId>/<artifactId>.<ext>
    4. Store metadata in KV: artifact:<artifactId> = { type, title, spaceId, createdAt, size }
    5. Return { artifactId; url: '/artifacts/' + artifactId }

  GET /v1/artifacts/:artifactId
    1. Check KV for metadata
    2. Fetch from R2
    3. Return with appropriate Content-Type:
       html: text/html; charset=utf-8
       react: text/html (rendered wrapper)
       json: application/json
       markdown: text/markdown
    4. Set CSP headers: Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'unsafe-inline'

  DELETE /v1/artifacts/:artifactId
    - Verify requester owns the artifact (spaceId from JWT matches artifact.spaceId)
    - Delete from R2 and KV

