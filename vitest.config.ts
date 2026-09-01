import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
  },
  resolve: {
    alias: [
      { find: "cloudflare:workers", replacement: path.resolve(__dirname, "tests/stubs/cloudflare-workers.ts") },
      { find: /^hono\/factory$/, replacement: path.resolve(__dirname, "node_modules/.bun/hono@4.13.5/node_modules/hono/dist/helper/factory/index.js") },
      { find: /^hono\/cors$/, replacement: path.resolve(__dirname, "node_modules/.bun/hono@4.13.5/node_modules/hono/dist/middleware/cors/index.js") },
      { find: /^hono$/, replacement: path.resolve(__dirname, "node_modules/.bun/hono@4.13.5/node_modules/hono/dist/index.js") },
      { find: "@naelao/agent-sdk", replacement: path.resolve(__dirname, "packages/agent-sdk/src/index.ts") },
      { find: "@naelao/analytics-schema", replacement: path.resolve(__dirname, "packages/analytics-schema/src/index.ts") },
      { find: "@naelao/auth", replacement: path.resolve(__dirname, "packages/auth/src/index.ts") },
      { find: "@naelao/billing-core", replacement: path.resolve(__dirname, "packages/billing-core/src/index.ts") },
      { find: "@naelao/client-sdk", replacement: path.resolve(__dirname, "packages/client-sdk/src/index.ts") },
      { find: "@naelao/config", replacement: path.resolve(__dirname, "packages/config/src/index.ts") },
      { find: "@naelao/crypto", replacement: path.resolve(__dirname, "packages/crypto/src/index.ts") },
      { find: "@naelao/db", replacement: path.resolve(__dirname, "packages/db/src/index.ts") },
      { find: "@naelao/entitlements", replacement: path.resolve(__dirname, "packages/entitlements/src/index.ts") },
      { find: "@naelao/events", replacement: path.resolve(__dirname, "packages/events/src/index.ts") },
      { find: "@naelao/http", replacement: path.resolve(__dirname, "packages/http/src/index.ts") },
      { find: "@naelao/idempotency", replacement: path.resolve(__dirname, "packages/idempotency/src/index.ts") },
      { find: "@naelao/llm-gateway", replacement: path.resolve(__dirname, "packages/llm-gateway/src/index.ts") },
      { find: "@naelao/logger", replacement: path.resolve(__dirname, "packages/logger/src/index.ts") },
      { find: "@naelao/moderation", replacement: path.resolve(__dirname, "packages/moderation/src/index.ts") },
      { find: "@naelao/rag", replacement: path.resolve(__dirname, "packages/rag/src/index.ts") },
      { find: "@naelao/security", replacement: path.resolve(__dirname, "packages/security/src/index.ts") },
      { find: "@naelao/testing", replacement: path.resolve(__dirname, "packages/testing/src/index.ts") },
      { find: "@naelao/tool-runtime", replacement: path.resolve(__dirname, "packages/tool-runtime/src/index.ts") },
      { find: "@naelao/tracing", replacement: path.resolve(__dirname, "packages/tracing/src/index.ts") },
      { find: "@naelao/types", replacement: path.resolve(__dirname, "packages/types/src/index.ts") },
      { find: "@naelao/ui", replacement: path.resolve(__dirname, "packages/ui/src/index.ts") },
      { find: "@naelao/webhooks", replacement: path.resolve(__dirname, "packages/webhooks/src/index.ts") },
    ],
  },
});

