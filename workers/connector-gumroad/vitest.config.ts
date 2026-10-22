import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: {
    "@naelao/http": fileURLToPath(new URL("../../packages/http/src/index.ts", import.meta.url)),
    "cloudflare:workers": fileURLToPath(new URL("../../tests/stubs/cloudflare-workers.ts", import.meta.url)),
  } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
