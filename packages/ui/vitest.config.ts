import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/*.test.js", "../../tests/unit/qr-encoder.test.ts"],
  },
});
