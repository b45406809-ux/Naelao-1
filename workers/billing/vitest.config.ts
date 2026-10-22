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
    include: ["src/**/*.test.ts", "../../tests/unit/workflow-budget-settlement-v2.test.ts", "../../tests/unit/platform-plan-billing.test.ts", "../../tests/unit/marketplace-license-settlement.test.ts", "../../tests/unit/whop-wallet.test.ts", "../../tests/unit/revenue-cut-surcharge.test.ts", "../../tests/unit/business-subscriptions-billing.test.ts", "../../tests/unit/whop-oauth-business-billing.test.ts", "../../tests/unit/wallet-topups-billing.test.ts", "../../tests/unit/personal-plan-whop-checkout.test.ts", "../../tests/unit/billing-fulfillment-project.test.ts"],
  },
});
