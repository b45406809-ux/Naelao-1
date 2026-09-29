import { defineConfig } from "vitest/config";
export default defineConfig({ root: "harness/conformance", test: { include: ["**/*.test.ts"] } });
