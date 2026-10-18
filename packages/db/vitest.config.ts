import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "../../tests/unit/db-migrations.test.ts"],
  },
});
