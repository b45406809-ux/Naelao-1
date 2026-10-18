import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "../../tests/plan/02-contracts.test.ts"],
  },
});
