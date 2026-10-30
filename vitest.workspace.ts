import { defineConfig } from "vitest/config";

// Vitest 4 replaces the old `--workspace vitest.workspace.ts` CLI with project discovery from
// a normal config file. Keep each package/Worker config as its own project so its aliases, runtime
// environment, and cwd-sensitive tests stay scoped correctly.
export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "workers/*/vitest.config.ts",
    ],
  },
});
