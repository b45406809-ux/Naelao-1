import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./stubs/cloudflare-workers.ts", import.meta.url)),
      "@naelao/tracing": fileURLToPath(new URL("../packages/tracing/src/index.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["plan/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
