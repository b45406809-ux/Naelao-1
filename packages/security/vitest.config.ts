import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "../../tests/unit/packages/security.test.ts",
      "../../tests/unit/capability-scope-boundary.test.ts",
      "../../tests/plan/04-authorization.test.ts",
    ],
  },
});
