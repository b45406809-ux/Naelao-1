import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Allow worker code that imports the CF runtime module to load under Node.
      "cloudflare:workers": fileURLToPath(new URL("./stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
