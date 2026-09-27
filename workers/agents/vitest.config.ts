import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@naelao/auth": fileURLToPath(
        new URL("../../packages/auth/src/index.ts", import.meta.url)
      ),
      "@naelao/crypto": fileURLToPath(
        new URL("../../packages/crypto/src/index.ts", import.meta.url)
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
    include: ["src/**/*.test.ts", "container/**/*.test.mjs"],
  },
});
