import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@naelao/billing-core": fileURLToPath(
        new URL("../../packages/billing-core/src/index.ts", import.meta.url)
      ),
      "@naelao/security": fileURLToPath(
        new URL("../../packages/security/src/index.ts", import.meta.url)
      ),
      "@naelao/auth": fileURLToPath(
        new URL("../../packages/auth/src/index.ts", import.meta.url)
      ),
      "@naelao/crypto": fileURLToPath(
        new URL("../../packages/crypto/src/index.ts", import.meta.url)
      ),
      "@naelao/db": fileURLToPath(
        new URL("../../packages/db/src/index.ts", import.meta.url)
      ),
      "@naelao/events": fileURLToPath(
        new URL("../../packages/events/src/index.ts", import.meta.url)
      ),
      "@naelao/types": fileURLToPath(
        new URL("../../packages/types/src/index.ts", import.meta.url)
      ),
      "@naelao/agent-sdk": fileURLToPath(
        new URL("../../packages/agent-sdk/src/index.ts", import.meta.url)
      ),
      "@naelao/http": fileURLToPath(
        new URL("../../packages/http/src/index.ts", import.meta.url)
      ),
      "cloudflare:workers": fileURLToPath(
        new URL("../../tests/stubs/cloudflare-workers.ts", import.meta.url)
      ),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "../../tests/unit/external-revenue-tracking.test.ts",
      "../../tests/unit/generic-product-space-creation.test.ts",
      "../../tests/unit/create-space-record.test.ts",
      "../../tests/unit/builder-payout-requests.test.ts",
      "../../tests/unit/pricing-catalog.test.ts",
      "../../tests/unit/blueprint-conformance-workflow.test.ts",
    ],
  },
});
