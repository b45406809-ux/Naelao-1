import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "../../tests/unit/packages/llm-gateway.test.ts",
    ],
  },
});
