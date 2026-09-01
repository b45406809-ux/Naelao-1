import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "cloudflare:workers", replacement: path.resolve(rootDir, "tests/stubs/cloudflare-workers.ts") },
      { find: /^hono\/factory$/, replacement: path.resolve(rootDir, "node_modules/.bun/hono@4.13.5/node_modules/hono/dist/helper/factory/index.js") },
      { find: /^hono\/cors$/, replacement: path.resolve(rootDir, "node_modules/.bun/hono@4.13.5/node_modules/hono/dist/middleware/cors/index.js") },
      { find: /^hono$/, replacement: path.resolve(rootDir, "node_modules/.bun/hono@4.13.5/node_modules/hono/dist/index.js") },
      { find: "@naelao/agent-sdk", replacement: path.resolve(rootDir, "packages/agent-sdk/src/index.ts") },
      { find: "@naelao/analytics-schema", replacement: path.resolve(rootDir, "packages/analytics-schema/src/index.ts") },
      { find: "@naelao/auth", replacement: path.resolve(rootDir, "packages/auth/src/index.ts") },
      { find: "@naelao/billing-core", replacement: path.resolve(rootDir, "packages/billing-core/src/index.ts") },
      { find: "@naelao/client-sdk", replacement: path.resolve(rootDir, "packages/client-sdk/src/index.ts") },
      { find: "@naelao/config", replacement: path.resolve(rootDir, "packages/config/src/index.ts") },
      { find: "@naelao/crypto", replacement: path.resolve(rootDir, "packages/crypto/src/index.ts") },
      { find: "@naelao/db", replacement: path.resolve(rootDir, "packages/db/src/index.ts") },
      { find: "@naelao/entitlements", replacement: path.resolve(rootDir, "packages/entitlements/src/index.ts") },
      { find: "@naelao/events", replacement: path.resolve(rootDir, "packages/events/src/index.ts") },
      { find: "@naelao/http", replacement: path.resolve(rootDir, "packages/http/src/index.ts") },
      { find: "@naelao/idempotency", replacement: path.resolve(rootDir, "packages/idempotency/src/index.ts") },
      { find: "@naelao/llm-gateway", replacement: path.resolve(rootDir, "packages/llm-gateway/src/index.ts") },
      { find: "@naelao/logger", replacement: path.resolve(rootDir, "packages/logger/src/index.ts") },
      { find: "@naelao/moderation", replacement: path.resolve(rootDir, "packages/moderation/src/index.ts") },
      { find: "@naelao/rag", replacement: path.resolve(rootDir, "packages/rag/src/index.ts") },
      { find: "@naelao/security", replacement: path.resolve(rootDir, "packages/security/src/index.ts") },
      { find: "@naelao/testing", replacement: path.resolve(rootDir, "packages/testing/src/index.ts") },
      { find: "@naelao/tool-runtime", replacement: path.resolve(rootDir, "packages/tool-runtime/src/index.ts") },
      { find: "@naelao/tracing", replacement: path.resolve(rootDir, "packages/tracing/src/index.ts") },
      { find: "@naelao/types", replacement: path.resolve(rootDir, "packages/types/src/index.ts") },
      { find: "@naelao/ui", replacement: path.resolve(rootDir, "packages/ui/src/index.ts") },
      { find: "@naelao/webhooks", replacement: path.resolve(rootDir, "packages/webhooks/src/index.ts") },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
