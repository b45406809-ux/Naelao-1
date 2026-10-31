import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@naelao/entitlements": fileURLToPath(new URL("../../packages/entitlements/src/index.ts", import.meta.url)),
      "@naelao/billing-core": fileURLToPath(
        new URL("../../packages/billing-core/src/index.ts", import.meta.url)
      ),
      "@naelao/auth": fileURLToPath(
        new URL("../../packages/auth/src/index.ts", import.meta.url)
      ),
      "@naelao/crypto": fileURLToPath(
        new URL("../../packages/crypto/src/index.ts", import.meta.url)
      ),
      "@naelao/http": fileURLToPath(
        new URL("../../packages/http/src/index.ts", import.meta.url)
      ),
      "@naelao/events": fileURLToPath(
        new URL("../../packages/events/src/index.ts", import.meta.url)
      ),
      "@naelao/agent-sdk": fileURLToPath(
        new URL("../../packages/agent-sdk/src/index.ts", import.meta.url)
      ),
      "@naelao/types": fileURLToPath(
        new URL("../../packages/types/src/index.ts", import.meta.url)
      ),
      "@naelao/moderation": fileURLToPath(
        new URL("../../packages/moderation/src/index.ts", import.meta.url)
      ),
      "@naelao/tracing": fileURLToPath(
        new URL("../../packages/tracing/src/index.ts", import.meta.url)
      ),
      "@naelao/security": fileURLToPath(
        new URL("../../packages/security/src/index.ts", import.meta.url)
      ),
      "cloudflare:workers": fileURLToPath(
        new URL("../../tests/stubs/cloudflare-workers.ts", import.meta.url)
      ),
      "agents/voice": fileURLToPath(
        new URL("../../tests/stubs/agents-voice.ts", import.meta.url)
      ),
      agents: fileURLToPath(
        new URL("../../tests/stubs/agents.ts", import.meta.url)
      ),
    },
  },
  test: {
    environment: "node",
    server: { deps: { inline: ["@cloudflare/dynamic-workflows"] } },
    include: ["src/**/*.test.ts", "container/**/*.test.mjs", "../../tests/unit/run-cancellation.test.ts", "../../tests/unit/run-status-pending-approval.test.ts"],
  },
});
