import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@naelao/billing-core": fileURLToPath(new URL("../../packages/billing-core/src/index.ts", import.meta.url)),
      "@naelao/http": fileURLToPath(new URL("../../packages/http/src/index.ts", import.meta.url)),
      "@naelao/security": fileURLToPath(new URL("../../packages/security/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "../../tests/unit/workflow-budget-settlement-v2.test.ts"],
  },
});
