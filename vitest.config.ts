import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
  },
  resolve: {
    alias: {
      "@naelao/billing-core": path.resolve(__dirname, "packages/billing-core/src/index.ts"),
      "@naelao/types": path.resolve(__dirname, "packages/types/src/index.ts"),
      "@naelao/http": path.resolve(__dirname, "packages/http/src/index.ts"),
      "@naelao/events": path.resolve(__dirname, "packages/events/src/index.ts"),
      "@naelao/crypto": path.resolve(__dirname, "packages/crypto/src/index.ts"),
      "@naelao/moderation": path.resolve(__dirname, "packages/moderation/src/index.ts"),
      "@naelao/entitlements": path.resolve(__dirname, "packages/entitlements/src/index.ts"),
      "@naelao/config": path.resolve(__dirname, "packages/config/src/index.ts"),
      "@naelao/analytics-schema": path.resolve(__dirname, "packages/analytics-schema/src/index.ts"),
      "@naelao/rag": path.resolve(__dirname, "packages/rag/src/index.ts"),
      "@naelao/security": path.resolve(__dirname, "packages/security/src/index.ts"),
    },
  },
});
